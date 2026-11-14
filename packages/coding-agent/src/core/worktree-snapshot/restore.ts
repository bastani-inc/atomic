import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";
import { noteRestoreFetch, timeRestorePhase } from "../resume/timings.ts";
import {
	locateCheckout,
	readRepositoryConfig,
	withScratchDirectory,
	writeSnapshotCommit,
	writeWorkingTree,
} from "./capture.ts";
import { computeEnvironmentHash, sha256Hex } from "./env-hash.ts";
import {
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	unreadablePathError,
	unwritablePathError,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceGitError,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorFields,
} from "./errors.ts";
import {
	type GitExecutable,
	type GitRunOptions,
	type GitRunResult,
	gitText,
	nulFields,
	runGit,
	withWorktreeSnapshotGit,
} from "./git.ts";
import { loadSnapshotPathPolicy } from "./policy.ts";
import { assertUsableBundlePrerequisites, assertUsableSnapshotRecord, isAllowedRemote } from "./records.ts";
import {
	DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	resolveWorktreeSnapshotSettings,
	type WorktreeSnapshotSettingsInput,
} from "./settings.ts";
import type {
	SnapshotBlobStore,
	WorkspaceBinding,
	WorktreeDegradedRestore,
	WorktreeDegradedRestoreBasis,
	WorktreeRestoreWarning,
	WorktreeSnapshot,
} from "./types.ts";

export interface RestoreWorktreeSnapshotOptions {
	/** New or empty directory for the restored worktree. Default: a new directory under `storeDir`/worktrees. */
	readonly into?: string;
	/** Blob storage holding the snapshot's patches and bundle. Required when the snapshot has any. */
	readonly blobs?: SnapshotBlobStore;
	/** Recorded snapshots to search when restoring a binding. */
	readonly snapshots?: readonly WorktreeSnapshot[];
	/** Host directory for the shared per-repository object stores and default worktrees. Default ~/.atomic/agent/worktree-snapshots. */
	readonly storeDir?: string;
	readonly onWarning?: (warning: WorktreeRestoreWarning) => void;
	readonly signal?: AbortSignal;
	/**
	 * The Git this restore runs, with the environment it needs. Default: the Git every snapshot operation resolves,
	 * provisioned when this machine has none.
	 */
	readonly git?: GitExecutable;
}

export interface RestoredWorktree {
	readonly path: string;
	readonly snapshot: WorktreeSnapshot | null;
	readonly binding: WorkspaceBinding;
	readonly warnings: readonly WorktreeRestoreWarning[];
}

/** The warnings a restore of `snapshot` reports from its record: omitted content and source conversion settings. */
export function snapshotRestoreWarnings(snapshot: WorktreeSnapshot): WorktreeRestoreWarning[] {
	return [
		...(snapshot.omitted.length > 0 ? [{ code: "omitted-content" as const, omitted: snapshot.omitted }] : []),
		...(snapshot.filters ? [{ code: "filters" as const, filters: snapshot.filters }] : []),
	];
}

export function defaultWorktreeSnapshotStoreDir(): string {
	return join(getAgentDir(), "worktree-snapshots");
}

function isBinding(value: unknown): value is WorkspaceBinding {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkspaceBinding>;
	return (
		Array.isArray(candidate.remotes) &&
		candidate.remotes.every((remote) => typeof remote === "string") &&
		typeof candidate.head === "string" &&
		typeof candidate.tree === "string" &&
		typeof candidate.envHash === "string"
	);
}

function isSnapshot(value: unknown): value is WorktreeSnapshot {
	return (
		isBinding(value) &&
		(value as Partial<WorktreeSnapshot>).version === 1 &&
		Array.isArray((value as Partial<WorktreeSnapshot>).chain) &&
		typeof (value as Partial<WorktreeSnapshot>).id === "string"
	);
}

/** Lowercase hex digest of a blob, compared with its recorded hash before Git sees its bytes. */
async function loadBlob(
	store: SnapshotBlobStore | undefined,
	hash: string,
	fields: Pick<WorkspaceRestoreErrorFields, "snapshotId" | "role" | "deltaIndex">,
): Promise<Uint8Array> {
	const data = await store?.getBlob(hash);
	if (data === undefined) throw new WorkspaceRestoreError("blob-missing", { ...fields, blob: hash });
	if (sha256Hex(data) !== hash) throw new WorkspaceRestoreError("blob-corrupt", { ...fields, blob: hash });
	return data;
}

async function checkTarget(target: string, snapshotId: string | null): Promise<void> {
	let empty: boolean;
	try {
		empty = (await stat(target)).isDirectory() && (await readdir(target)).length === 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadablePathError(target, error);
		if (await belowRegularFile(target)) throw unreadablePathError(target, error);
		return;
	}
	if (!empty) throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target, reason: "not-empty" });
}

/**
 * Whether the deepest existing ancestor of a missing `path` is not a directory. Linux reports such a path as
 * `ENOTDIR`, Windows as missing (`ENOENT`), so only its ancestors tell a path that could be created from one that cannot.
 */
async function belowRegularFile(path: string): Promise<boolean> {
	for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
		const entry = await statIfPresent(current);
		if (entry) return !entry.isDirectory();
	}
	return false;
}

/** Which of `trees` the object store already holds, asked of Git in one process. */
async function storedTrees(git: GitRunOptions, trees: readonly string[]): Promise<Set<string>> {
	const { stdout } = await runGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
		...git,
		input: trees.map((tree) => `${tree}\n`).join(""),
	});
	const stored = new Set<string>();
	for (const line of stdout.toString("utf8").split("\n")) {
		const [name, type] = line.split(" ");
		if (type === "tree" && name) stored.add(name);
	}
	return stored;
}

async function hasObject(git: GitRunOptions, object: string): Promise<boolean> {
	const { exitCode } = await runGit(["cat-file", "-e", object], { ...git, allowExitCodes: [1, 128] });
	return exitCode === 0;
}

/** Runs a filesystem write of `target`, reporting a filesystem failure as `unwritable-path`. */
async function writing<T>(target: string, snapshotId: string | null, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		throw unwritablePathError(target, snapshotId, error);
	}
}

const repositoryLocks = new Map<string, Promise<void>>();

/** Serializes work on one shared object store within this process; Git's own locks cover other processes. */
async function withRepositoryLock<T>(store: string, action: () => Promise<T>): Promise<T> {
	const previous = repositoryLocks.get(store) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolveLock) => {
		release = resolveLock;
	});
	const chained = previous.then(() => current);
	repositoryLocks.set(store, chained);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (repositoryLocks.get(store) === chained) repositoryLocks.delete(store);
	}
}

/** A stopped process loses its restore lock after 30 seconds; active processes refresh it every 10 seconds. */
const RESTORE_LOCK_STALE_MS = 30_000;
const RESTORE_LOCK_UPDATE_MS = 10_000;

interface RestoreRecord {
	readonly staging: string;
	readonly target: string;
	readonly store: string;
	readonly createdTarget: boolean;
}

/** Validate crash records before using their paths. Only Atomic's staging name and per-repository store are valid. */
function isRestoreRecord(value: unknown, storeDir: string, id: string): value is RestoreRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<RestoreRecord>;
	if (
		typeof record.staging !== "string" ||
		typeof record.target !== "string" ||
		typeof record.store !== "string" ||
		typeof record.createdTarget !== "boolean" ||
		resolve(record.target) !== record.target ||
		resolve(record.staging) !== record.staging ||
		resolve(record.store) !== record.store ||
		dirname(record.store) !== join(storeDir, "repositories") ||
		!/^[0-9a-f]{24}\.git$/.test(basename(record.store))
	)
		return false;
	const defaultStaging = join(storeDir, "worktrees", `.staging-${id}`);
	const siblingStaging = join(dirname(record.target), `.${basename(record.target)}.atomic-restore-${id}`);
	return (
		record.staging === siblingStaging ||
		(record.staging === defaultStaging && dirname(record.target) === join(storeDir, "worktrees"))
	);
}

/** Git's registered worktree paths, without shell quoting or newline ambiguity. */
async function registeredWorktrees(git: GitRunOptions): Promise<string[]> {
	return nulFields((await runGit(["worktree", "list", "--porcelain", "-z"], git)).stdout)
		.filter((field) => field.startsWith("worktree "))
		.map((field) => field.slice("worktree ".length));
}

function includesPath(paths: readonly string[], target: string): boolean {
	const normalized = resolve(target);
	return paths.some((path) => {
		const candidate = resolve(path);
		return process.platform === "win32"
			? candidate.toLowerCase() === normalized.toLowerCase()
			: candidate === normalized;
	});
}

async function physicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		throw unreadablePathError(path, error);
	}
}

/** Remove a registered or partially initialized staging worktree, then restore a previously empty target if needed. */
async function cleanRestoreRecord(record: RestoreRecord, signal?: AbortSignal): Promise<void> {
	const git: GitRunOptions = { cwd: dirname(record.store), env: { GIT_DIR: record.store }, signal };
	let entry: Stats | undefined;
	let registeredPath = record.staging;
	try {
		entry = await lstat(record.staging);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadablePathError(record.staging, error);
	}
	if (entry) {
		if (entry.isDirectory()) registeredPath = await physicalPath(record.staging);
		if (!entry.isDirectory() || !includesPath(await registeredWorktrees(git), registeredPath)) {
			throw new WorkspaceRestoreError("unsafe-target", {
				snapshotId: null,
				target: record.staging,
				reason: "not-restored",
			});
		}
	}
	const removed = await runGit(["worktree", "remove", "--force", "--force", record.staging], {
		...git,
		allowExitCodes: [128],
	});
	if (entry && removed.exitCode !== 0) {
		throw new WorkspaceGitError({
			operation: "worktree remove",
			cwd: git.cwd,
			exitCode: removed.exitCode,
			detail: "could not remove the staging worktree",
		});
	}
	await writing(record.staging, null, () => rm(record.staging, { recursive: true, force: true }));
	if (!record.createdTarget && (await statIfPresent(record.target)) === undefined) {
		await writing(record.target, null, () => mkdir(record.target, { recursive: true }));
	}
	await runGit(["worktree", "prune"], git);
	if (includesPath(await registeredWorktrees(git), registeredPath)) {
		throw new WorkspaceGitError({
			operation: "worktree prune",
			cwd: git.cwd,
			exitCode: null,
			detail: "the staging worktree is still registered",
		});
	}
}

function leftoverKind(path: string, recordPath: string): "worktree" | "record" {
	return path === recordPath ? "record" : "worktree";
}

/** Sweep only unlocked or stale records, leaving active processes' staging worktrees alone. */
async function sweepRestoreRecords(
	storeDir: string,
	warn: (warning: WorktreeRestoreWarning) => void,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const recordsDir = join(storeDir, "restores");
	let names: string[];
	try {
		names = await readdir(recordsDir);
	} catch (error) {
		signal?.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		warn({ code: "stale-restore-retained", path: recordsDir, kind: "records-directory" });
		return;
	}
	for (const name of names) {
		signal?.throwIfAborted();
		const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/.exec(name);
		if (!match) continue;
		const recordPath = join(recordsDir, name);
		let release: (() => Promise<void>) | undefined;
		let compromised: Error | undefined;
		let warningPath = recordPath;
		try {
			release = await lockfile.lock(recordPath, {
				realpath: false,
				stale: RESTORE_LOCK_STALE_MS,
				update: RESTORE_LOCK_UPDATE_MS,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
				},
			});
			const record: unknown = JSON.parse(await readFile(recordPath, "utf8"));
			if (!isRestoreRecord(record, storeDir, match[1]!)) throw new Error("Invalid restore crash record");
			warningPath = record.staging;
			await withRepositoryLock(record.store, () => cleanRestoreRecord(record, signal));
			if (compromised) throw compromised;
			await rm(recordPath);
		} catch (error) {
			signal?.throwIfAborted();
			const code = (error as NodeJS.ErrnoException).code;
			if (!(release === undefined && code === "ELOCKED") && !(warningPath === recordPath && code === "ENOENT")) {
				warn({ code: "stale-restore-retained", path: warningPath, kind: leftoverKind(warningPath, recordPath) });
			}
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					if (!compromised) {
						warn({
							code: "stale-restore-retained",
							path: warningPath,
							kind: leftoverKind(warningPath, recordPath),
						});
					}
				}
			}
		}
	}
}

/** Hold a crash record lock throughout staging and publication; preserve the primary failure if cleanup fails. */
async function withRestoreRecord(
	storeDir: string,
	id: string,
	record: RestoreRecord,
	snapshotId: string | null,
	warn: (warning: WorktreeRestoreWarning) => void,
	signal: AbortSignal | undefined,
	action: (assertActive: () => void) => Promise<void>,
): Promise<void> {
	const recordsDir = join(storeDir, "restores");
	const recordPath = join(recordsDir, `${id}.json`);
	await writing(recordsDir, snapshotId, () => mkdir(recordsDir, { recursive: true }));
	let compromised: Error | undefined;
	const release = await writing(recordPath, snapshotId, () =>
		lockfile.lock(recordPath, {
			realpath: false,
			stale: RESTORE_LOCK_STALE_MS,
			update: RESTORE_LOCK_UPDATE_MS,
			retries: 0,
			onCompromised: (error) => {
				compromised = error;
			},
		}),
	);
	let recorded = false;
	let primary: unknown;
	const assertActive = () => {
		signal?.throwIfAborted();
		if (compromised) {
			throw new WorkspaceGitError(
				{
					operation: "worktree restore",
					cwd: record.staging,
					exitCode: null,
					detail: "the staging lock was lost",
				},
				compromised,
			);
		}
	};
	try {
		await writing(recordPath, snapshotId, () =>
			writeFile(recordPath, JSON.stringify(record), { flag: "wx", mode: 0o600 }),
		);
		recorded = true;
		assertActive();
		await action(assertActive);
		assertActive();
		try {
			await rm(recordPath);
		} catch {
			warn({ code: "stale-restore-retained", path: record.staging, kind: "worktree" });
		}
	} catch (error) {
		primary = error;
		if (recorded) {
			try {
				await cleanRestoreRecord(record);
				await rm(recordPath);
			} catch (cleanupCause) {
				if (error instanceof Error)
					Object.defineProperty(error, "cleanupCause", { value: cleanupCause, configurable: true });
				warn({ code: "stale-restore-retained", path: record.staging, kind: "worktree" });
			}
		}
		throw error;
	} finally {
		try {
			await release();
		} catch (error) {
			if (primary instanceof Error && !Object.hasOwn(primary, "cleanupCause")) {
				Object.defineProperty(primary, "cleanupCause", { value: error, configurable: true });
			} else if (primary === undefined) {
				warn({ code: "stale-restore-retained", path: record.staging, kind: "worktree" });
			}
		}
	}
}

/** The shared object store of the repository that `remotes` name, under `storeDir`. */
function objectStorePath(storeDir: string, remotes: readonly string[]): string {
	return join(storeDir, "repositories", `${sha256Hex(remotes.join("\n")).slice(0, 24)}.git`);
}

async function initializedStore(store: string): Promise<boolean> {
	try {
		await stat(join(store, "config"));
		await stat(join(store, "HEAD"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw unreadablePathError(store, error);
	}
}

/**
 * Creates `store` unless it already has its configuration and HEAD. Callers hold its repository lock, so restores never
 * initialize one store at once, and an existing store is left alone: re-initializing rewrites its configuration, which
 * on Windows fails the other restores' Git processes that are reading it.
 */
async function ensureObjectStore(store: string, snapshotId: string | null, signal?: AbortSignal): Promise<void> {
	if (await initializedStore(store)) return;
	const repositories = dirname(store);
	await writing(repositories, snapshotId, () => mkdir(repositories, { recursive: true }));
	await runGit(["init", "-q", "--bare", store], { cwd: repositories, signal });
}

function bundlePrerequisites(bundle: Uint8Array): string[] {
	const end = Buffer.from(bundle).indexOf("\n\n");
	const header = Buffer.from(bundle.subarray(0, end < 0 ? Math.min(bundle.length, 65536) : end)).toString("utf8");
	return header
		.split("\n")
		.filter((line) => line.startsWith("-"))
		.map((line) => line.slice(1).split(" ", 1)[0]!);
}

/**
 * Transports a restore may fetch over. Recorded remotes come from storage, so Git's remote helpers (`ext::`, `fd::`,
 * custom `<name>::`) are refused; local paths stay allowed for path remotes and mirrors.
 */
const FETCH_TRANSPORTS = [
	"-c",
	"protocol.allow=never",
	...["https", "http", "ssh", "git", "file"].flatMap((protocol) => ["-c", `protocol.${protocol}.allow=always`]),
];

/** `git fetch` of `refspecs` from `repository`; the `--` keeps a recorded value from ever being read as an option. */
function fetchArgs(repository: string, refspecs: readonly string[]): string[] {
	return [...FETCH_TRANSPORTS, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--", repository, ...refspecs];
}

/** Runs {@link fetchArgs} through the runner without a way to prompt, so an unreachable or unknown host fails at once. */
function runFetch(git: GitRunOptions, repository: string, refspecs: readonly string[]): Promise<GitRunResult> {
	return runGit(fetchArgs(repository, refspecs), { ...git, nonInteractive: true });
}

interface RemoteFetch {
	/** The last fetch failure, when a remote could not supply what was still missing. */
	readonly failure: Error | undefined;
	/** Whether a recorded remote's fetch of the missing commits succeeded, so that remote has every one of them. */
	readonly supplied: boolean;
}

async function fetchCommits(
	git: GitRunOptions,
	remotes: readonly string[],
	commits: readonly string[],
): Promise<RemoteFetch> {
	let failure: Error | undefined;
	let supplied = false;
	for (const remote of remotes) {
		const missing = [];
		for (const commit of commits) if (!(await hasObject(git, `${commit}^{commit}`))) missing.push(commit);
		if (missing.length === 0) return { failure: undefined, supplied };
		try {
			await runFetch(git, remote, missing);
			supplied = true;
			noteRestoreFetch("full");
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
			failure = error;
		}
	}
	return { failure, supplied };
}

/**
 * Makes `snapshot.head` available in the store, from the recorded remotes or else its bundle, and resolves whether
 * it came from a recorded remote.
 */
async function ensureHead(
	git: GitRunOptions,
	snapshot: Pick<WorktreeSnapshot, "head" | "remotes" | "bundle" | "omitted"> & { readonly id: string | null },
	blobs: SnapshotBlobStore | undefined,
	scratch: string,
): Promise<boolean> {
	const { head } = snapshot;
	let fetched = false;
	if (!(await hasObject(git, `${head}^{commit}`))) {
		// Only a fetch that succeeded proves a remote has `head`: another process may import it from a bundle meanwhile.
		const fromRemotes = await fetchCommits(git, snapshot.remotes, [head]);
		let failure = fromRemotes.failure;
		fetched = fromRemotes.supplied;
		if (!(await hasObject(git, `${head}^{commit}`)) && snapshot.bundle) {
			const data = await loadBlob(blobs, snapshot.bundle.blob, { snapshotId: snapshot.id, role: "bundle" });
			const prerequisites = bundlePrerequisites(data);
			assertUsableBundlePrerequisites(prerequisites, snapshot.id);
			failure = (await fetchCommits(git, snapshot.remotes, prerequisites)).failure ?? failure;
			const file = join(scratch, "history.bundle");
			await writing(file, snapshot.id, () => writeFile(file, data));
			try {
				await runFetch(git, file, ["HEAD"]);
				noteRestoreFetch("bundle");
			} catch (error) {
				if (!isWorkspaceGitError(error)) throw error;
				failure = error;
			}
		}
		if (!(await hasObject(git, `${head}^{commit}`))) {
			const denied = snapshot.omitted.find((entry) => entry.reason === "unpushed-history-denied");
			const overCap = snapshot.omitted.find((entry) => entry.reason === "bundle-over-cap");
			throw new WorkspaceRestoreError(
				"commits-unavailable",
				denied
					? {
							snapshotId: snapshot.id,
							head,
							commits: denied.commits,
							paths: denied.paths,
							remotes: snapshot.remotes,
							reason: "denied-history",
						}
					: overCap
						? {
								snapshotId: snapshot.id,
								head,
								commits: overCap.commits,
								remotes: snapshot.remotes,
								reason: "bundle-over-cap",
							}
						: {
								snapshotId: snapshot.id,
								head,
								commits: [head],
								remotes: snapshot.remotes,
								reason: "not-fetched",
							},
				failure,
			);
		}
	}
	return fetched;
}

async function configuredRemoteUrls(git: GitRunOptions): Promise<string[]> {
	const { stdout } = await runGit(["config", "-z", "--get-regexp", "^remote\\..+\\.url$"], {
		...git,
		allowExitCodes: [1],
	});
	return nulFields(stdout).map((field) => field.slice(field.indexOf("\n") + 1));
}

/**
 * Gives a shared object store the remotes its snapshots record, in their recorded order (the first as `origin`, then
 * `origin-2`, …), so a capture in one of its worktrees records them too. Resolves whether the store's remotes are the
 * recorded ones. A store without recorded remotes, or with a remote that is not credential-free or not of a scheme a
 * restore fetches over, is left without any, as before.
 */
async function configureRecordedRemotes(git: GitRunOptions, remotes: readonly string[]): Promise<boolean> {
	if (remotes.length === 0 || !remotes.every(isAllowedRemote)) return false;
	let configured = await configuredRemoteUrls(git);
	// A store holding the start of the recorded list was set up by a restore that stopped partway; finish it.
	if (configured.length < remotes.length && configured.every((remote, index) => remote === remotes[index])) {
		try {
			for (let index = configured.length; index < remotes.length; index++) {
				await runGit(["remote", "add", "--", index === 0 ? "origin" : `origin-${index + 1}`, remotes[index]!], git);
			}
			return true;
		} catch (error) {
			// Another process configured the store at the same moment; what it wrote is compared below.
			if (!isWorkspaceGitError(error)) throw error;
		}
		configured = await configuredRemoteUrls(git);
	}
	return configured.length === remotes.length && configured.every((remote, index) => remote === remotes[index]);
}

/** Where a restore records commits a recorded remote has, as remote-tracking refs no remote's fetch ever prunes. */
const PUSHED_REFS = "refs/remotes/atomic/pushed/";

/**
 * The commits a restore knows a recorded remote has, to record as remote-tracking refs: the snapshot's `head` when the
 * restore fetched it from one or the snapshot recorded nothing unpushed, else the parents of its bundled commits that
 * the bundle does not hold, its pushed boundary. Later captures in the store's worktrees then bundle only commits that
 * are really unpushed, and never count a commit that only a bundle carried as pushed.
 */
async function pushedCommits(
	git: GitRunOptions,
	snapshot: WorktreeSnapshot | null,
	head: string,
	fetched: boolean,
): Promise<Set<string>> {
	const pushed = new Set<string>();
	const historyOmitted = snapshot?.omitted.some(
		(omission) => omission.reason === "unpushed-history-denied" || omission.reason === "bundle-over-cap",
	);
	if (fetched || (snapshot !== null && snapshot.bundle === null && !historyOmitted)) pushed.add(head);
	else if (snapshot?.bundle) {
		const bundled = new Set(snapshot.bundle.commits);
		const parents = await runGit(["rev-list", "--no-walk=unsorted", "--parents", "--stdin"], {
			...git,
			input: `${snapshot.bundle.commits.join("\n")}\n`,
			allowExitCodes: [128],
		});
		if (parents.exitCode === 0) {
			for (const line of parents.stdout.toString("utf8").split("\n")) {
				for (const parent of line.split(" ").slice(1)) if (!bundled.has(parent)) pushed.add(parent);
			}
		}
	}
	return pushed;
}

async function reconstructTree(
	git: GitRunOptions,
	snapshot: WorktreeSnapshot,
	patches: readonly (Uint8Array | null)[],
	scratch: string,
): Promise<void> {
	const indexed: GitRunOptions = { ...git, env: { ...git.env, GIT_INDEX_FILE: join(scratch, "restore-index") } };
	const stored = await storedTrees(
		git,
		snapshot.chain.map((link) => link.tree),
	);
	let resumeAt = snapshot.chain.length;
	while (resumeAt > 0 && !stored.has(snapshot.chain[resumeAt - 1]!.tree)) resumeAt--;
	await runGit(["read-tree", resumeAt === 0 ? snapshot.head : snapshot.chain[resumeAt - 1]!.tree], indexed);
	for (const [deltaIndex, link] of snapshot.chain.entries()) {
		if (deltaIndex < resumeAt) continue;
		const patch = patches[deltaIndex];
		let applyFailure: Error | undefined;
		if (patch) {
			const file = join(scratch, `delta-${deltaIndex}.patch`);
			await writing(file, snapshot.id, () => writeFile(file, patch));
			try {
				await runGit(
					["apply", "--cached", "--binary", "--whitespace=nowarn", "--no-ignore-whitespace", "--no-3way", file],
					indexed,
				);
			} catch (error) {
				if (!isWorkspaceGitError(error)) throw error;
				applyFailure = error;
			}
		}
		const actualTree = applyFailure ? null : await gitText(["write-tree"], indexed);
		if (actualTree !== link.tree) {
			throw new WorkspaceRestoreError(
				"delta-failed",
				{
					snapshotId: snapshot.id,
					deltaIndex,
					...(link.patch ? { blob: link.patch } : {}),
					expectedTree: link.tree,
					actualTree,
				},
				applyFailure,
			);
		}
	}
}

async function lfsPaths(worktree: GitRunOptions): Promise<string[]> {
	const files = (await runGit(["ls-files", "-z"], worktree)).stdout;
	const fields = nulFields(
		(await runGit(["check-attr", "--stdin", "-z", "filter"], { ...worktree, input: files })).stdout,
	);
	const paths: string[] = [];
	for (let index = 0; index + 2 < fields.length; index += 3) {
		if (fields[index + 2] === "lfs") paths.push(fields[index]!);
	}
	return paths;
}

/** The form of a recorded remote that Git LFS can find its server from: a local path needs to be a `file://` URL. */
function lfsRemote(remote: string): string {
	return isAbsolute(remote) ? pathToFileURL(remote).href : remote;
}

const LFS_POINTER_PREFIX = Buffer.from("version https://git-lfs.github.com/spec/v1");
const LFS_POINTER_MAX_BYTES = 1024;

async function isLfsPointer(file: string): Promise<boolean> {
	try {
		if (!(await lstat(file)).isFile()) return false;
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.alloc(LFS_POINTER_MAX_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, LFS_POINTER_MAX_BYTES, 0);
			return (
				bytesRead < LFS_POINTER_MAX_BYTES &&
				buffer.subarray(0, LFS_POINTER_PREFIX.length).equals(LFS_POINTER_PREFIX)
			);
		} finally {
			await handle.close();
		}
	} catch (error) {
		throw unreadablePathError(file, error);
	}
}

async function remainingPointers(root: string, paths: readonly string[]): Promise<string[]> {
	const pointers: string[] = [];
	for (const path of paths) if (await isLfsPointer(join(root, path))) pointers.push(path);
	return pointers;
}

/**
 * Downloads the Git LFS objects of the snapshot's tree into the staged worktree from each recorded remote in turn,
 * while any LFS file still holds a pointer, and returns the files that still do. `git lfs pull` fetches only the
 * objects of HEAD's tree and its exit status does not say which files arrived, so the staged HEAD and index name the
 * snapshot's commit during the pulls, and the files themselves are inspected after each one. The staging worktree
 * belongs to a per-repository store that is created without remotes, so each recorded remote is named explicitly,
 * after `--` so that a value can never be read as an option, and the download can never wait for a person.
 */
async function pullLfsObjects(
	worktree: GitRunOptions,
	head: string,
	tree: string,
	remotes: readonly string[],
): Promise<string[]> {
	const snapshotCommit = await writeSnapshotCommit(worktree, head, tree);
	await runGit(["update-ref", "--no-deref", "HEAD", snapshotCommit], worktree);
	await runGit(["read-tree", snapshotCommit], worktree);
	let pointers = await remainingPointers(worktree.cwd, await lfsPaths(worktree));
	for (const remote of remotes) {
		if (pointers.length === 0) break;
		try {
			await runGit(["lfs", "pull", "--", lfsRemote(remote)], { ...worktree, nonInteractive: true });
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
			worktree.signal?.throwIfAborted();
		}
		pointers = await remainingPointers(worktree.cwd, pointers);
	}
	await runGit(["update-ref", "--no-deref", "HEAD", head], worktree);
	await runGit(["read-tree", head], worktree);
	await runGit(["update-index", "-q", "--refresh"], { ...worktree, neutral: true, allowExitCodes: [1] });
	return pointers;
}

async function materialize(
	git: GitRunOptions,
	target: string,
	head: string,
	tree: string,
	scratch: string,
	snapshotId: string | null,
	signal?: AbortSignal,
): Promise<void> {
	await runGit(["worktree", "add", "-q", "--detach", "--no-checkout", target, head], git);
	const attributes = join(scratch, "empty-attributes");
	await writing(attributes, snapshotId, () => writeFile(attributes, ""));
	const neutral: GitRunOptions = { cwd: target, signal, neutral: true, env: { GIT_LFS_SKIP_SMUDGE: "1" } };
	await runGit(["-c", `core.attributesFile=${attributes}`, "read-tree", "--reset", "-u", tree], neutral);
	await runGit(["read-tree", head], neutral);
	await runGit(["update-index", "-q", "--refresh"], { ...neutral, allowExitCodes: [1] });
}

/** Removes the restored worktree at `target` from the store `git` points at, then prunes what its removal left. */
async function removeWorktree(git: GitRunOptions, target: string): Promise<void> {
	await runGit(["worktree", "remove", "--force", target], { ...git, signal: undefined, allowExitCodes: [128] });
	await writing(target, null, () => rm(target, { recursive: true, force: true }));
	await runGit(["worktree", "prune"], { ...git, signal: undefined });
}

function resolveSnapshot(
	target: WorkspaceBinding | WorktreeSnapshot,
	snapshots: readonly WorktreeSnapshot[] | undefined,
): WorktreeSnapshot | null {
	if (isSnapshot(target)) return target;
	const candidates = (snapshots ?? []).filter(
		(snapshot) => isSnapshot(snapshot) && snapshot.tree === target.tree && snapshot.head === target.head,
	);
	return candidates.at(-1) ?? null;
}

/**
 * Restores a snapshot, or the snapshot a binding names, into a new worktree over the host's shared object store for
 * its repository, and returns the worktree only after its HEAD and recomputed tree match. Checks the target and every
 * blob before writing to the target; on failure removes what it created and throws a typed error. With `git`, every Git
 * command of the restore runs that executable.
 */
export async function restoreWorktree(
	target: WorkspaceBinding | WorktreeSnapshot,
	options: RestoreWorktreeSnapshotOptions = {},
): Promise<RestoredWorktree> {
	if (!isBinding(target)) {
		throw new WorkspaceConfigError("sdk", "target", "a WorkspaceBinding or a WorktreeSnapshot");
	}
	if (options.into !== undefined && (typeof options.into !== "string" || options.into.length === 0)) {
		throw new WorkspaceConfigError("sdk", "into", "a directory path");
	}
	if (options.git !== undefined && (typeof options.git?.path !== "string" || options.git.path.length === 0)) {
		throw new WorkspaceConfigError("sdk", "git", "a Git executable with a non-empty path");
	}
	return withWorktreeSnapshotGit(options.git, () => restoreValidated(target, options, undefined));
}

/**
 * {@link restoreWorktree} into `slot`, a pooled slot path under `storeDir`/worktrees that does not exist yet (#4748),
 * staged like a restore into a new default path. Session resumes use it; `into` stays the SDK's way to choose a path.
 */
export async function restoreWorktreeAt(
	target: WorkspaceBinding | WorktreeSnapshot,
	slot: string,
	options: Omit<RestoreWorktreeSnapshotOptions, "into"> = {},
): Promise<RestoredWorktree> {
	if (!isBinding(target)) {
		throw new WorkspaceConfigError("sdk", "target", "a WorkspaceBinding or a WorktreeSnapshot");
	}
	return withWorktreeSnapshotGit(options.git, () => restoreValidated(target, options, slot));
}

async function restoreValidated(
	target: WorkspaceBinding,
	options: RestoreWorktreeSnapshotOptions,
	slot: string | undefined,
): Promise<RestoredWorktree> {
	const { signal } = options;
	const snapshot = resolveSnapshot(target, options.snapshots);
	assertUsableSnapshotRecord(target, snapshot);
	const snapshotId = snapshot?.id ?? null;
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const path = resolve(
		options.into ??
			slot ??
			join(storeDir, "worktrees", `${(snapshot?.id ?? target.tree).slice(0, 12)}-${randomUUID().slice(0, 8)}`),
	);
	await checkTarget(path, snapshotId);
	const patches = snapshot
		? await Promise.all(
				snapshot.chain.map((link, deltaIndex) =>
					link.patch === null
						? null
						: loadBlob(options.blobs, link.patch, { snapshotId: snapshot.id, role: "patch", deltaIndex }),
				),
			)
		: [];
	const warnings: WorktreeRestoreWarning[] = [];
	const retained = new Set<string>();
	const warn = (warning: WorktreeRestoreWarning) => {
		if (warning.code === "stale-restore-retained") {
			if (retained.has(warning.path)) return;
			retained.add(warning.path);
		}
		warnings.push(warning);
		options.onWarning?.(warning);
	};
	await sweepRestoreRecords(storeDir, warn, signal);
	return withScratchDirectory(async (scratch) => {
		const store = objectStorePath(storeDir, target.remotes);
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		await withRepositoryLock(store, async () => {
			await ensureObjectStore(store, snapshotId, signal);
			const fetched = await timeRestorePhase("fetch", () =>
				ensureHead(
					git,
					snapshot ?? { id: null, head: target.head, remotes: target.remotes, bundle: null, omitted: [] },
					options.blobs,
					scratch,
				),
			);
			// What a snapshot of other remotes, such as a fork at the same commit, says is pushed is not this store's.
			const sameRemotes =
				snapshot === null ||
				(snapshot.remotes.length === target.remotes.length &&
					snapshot.remotes.every((remote, index) => remote === target.remotes[index]));
			const pushed =
				(await configureRecordedRemotes(git, target.remotes)) && sameRemotes
					? await pushedCommits(git, snapshot, target.head, fetched)
					: new Set<string>();
			await runGit(["update-ref", "--stdin"], {
				...git,
				input: [
					`update refs/atomic/heads/${target.head} ${target.head}\n`,
					...[...pushed].map((commit) => `update ${PUSHED_REFS}${commit} ${commit}\n`),
				].join(""),
			});
			if (!(await hasObject(git, `${target.tree}^{tree}`))) {
				if (!snapshot) {
					throw new WorkspaceRestoreError("snapshot-not-found", {
						snapshotId: null,
						head: target.head,
						tree: target.tree,
					});
				}
				await timeRestorePhase("reconstruct", () => reconstructTree(git, snapshot, patches, scratch));
			}
		});
		await publishWorktree({
			git,
			store,
			storeDir,
			path,
			into: options.into,
			head: target.head,
			tree: target.tree,
			snapshot,
			scratch,
			warn,
			signal,
			verify: "tree",
		});
		if (snapshot) for (const warning of snapshotRestoreWarnings(snapshot)) warn(warning);
		return {
			path,
			snapshot,
			binding: { remotes: [...target.remotes], head: target.head, tree: target.tree, envHash: target.envHash },
			warnings,
		};
	});
}

/** Restore errors after which a degraded restore can still give the session part of its snapshot (#4733). */
const DEGRADABLE_RESTORE_CODES: ReadonlySet<string> = new Set([
	"blob-missing",
	"blob-corrupt",
	"commits-unavailable",
	"delta-failed",
	"tree-mismatch",
]);

/** Whether a degraded restore can follow `error`, the failure of an exact restore. */
export function isDegradableRestoreFailure(error: unknown): error is WorkspaceRestoreError {
	return isWorkspaceRestoreError(error) && DEGRADABLE_RESTORE_CODES.has(error.code);
}

export interface RestoreDegradedWorktreeOptions extends Omit<RestoreWorktreeSnapshotOptions, "into" | "snapshots"> {
	/**
	 * Commits close to the snapshot's `HEAD` to try, nearest first, after its pushed base and before its branch tip:
	 * the `HEAD`s of the checkout's earlier snapshots, for example.
	 */
	readonly candidates?: readonly string[];
}

export interface DegradedWorktree {
	readonly path: string;
	readonly degraded: WorktreeDegradedRestore;
	readonly warnings: readonly WorktreeRestoreWarning[];
}

/**
 * Restores the best state of `snapshot` that this host can reach after an exact restore failed with `failure` (#4733),
 * into a new worktree: the recorded `HEAD` with the change sets of the patch chain that apply, each whole or not at
 * all, up to the first that cannot; else the closest commit it can fetch from the recorded remotes, trying the
 * snapshot's pushed base, then `candidates`, then the recorded branch's tip. Rejects with `failure` when no commit is
 * reachable, and with `invalid-snapshot` for a record that fails the security checks, before any Git work.
 */
export async function restoreDegradedWorktree(
	snapshot: WorktreeSnapshot,
	failure: WorkspaceRestoreError,
	options: RestoreDegradedWorktreeOptions = {},
): Promise<DegradedWorktree> {
	return withWorktreeSnapshotGit(options.git, () => restoreDegradedValidated(snapshot, failure, options, undefined));
}

/** {@link restoreDegradedWorktree} into `slot`, a pooled slot path as for {@link restoreWorktreeAt} (#4748). */
export async function restoreDegradedWorktreeAt(
	snapshot: WorktreeSnapshot,
	failure: WorkspaceRestoreError,
	slot: string,
	options: RestoreDegradedWorktreeOptions = {},
): Promise<DegradedWorktree> {
	return withWorktreeSnapshotGit(options.git, () => restoreDegradedValidated(snapshot, failure, options, slot));
}

async function restoreDegradedValidated(
	snapshot: WorktreeSnapshot,
	failure: WorkspaceRestoreError,
	options: RestoreDegradedWorktreeOptions,
	slot: string | undefined,
): Promise<DegradedWorktree> {
	const { signal } = options;
	assertUsableSnapshotRecord(
		{ remotes: [...snapshot.remotes], head: snapshot.head, tree: snapshot.tree, envHash: snapshot.envHash },
		snapshot,
	);
	const candidates = options.candidates ?? [];
	const unusable = candidates.findIndex((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit));
	if (unusable >= 0) throw new WorkspaceConfigError("sdk", `candidates[${unusable}]`, "a Git commit id");
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const path =
		slot === undefined
			? join(storeDir, "worktrees", `${snapshot.id.slice(0, 12)}-${randomUUID().slice(0, 8)}`)
			: resolve(slot);
	await checkTarget(path, snapshot.id);
	const warnings: WorktreeRestoreWarning[] = [];
	const warn = (warning: WorktreeRestoreWarning) => {
		warnings.push(warning);
		options.onWarning?.(warning);
	};
	await sweepRestoreRecords(storeDir, warn, signal);
	return withScratchDirectory(async (scratch) => {
		const store = objectStorePath(storeDir, snapshot.remotes);
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		const cause = {
			cause: failure.code,
			...(failure.reason ? { causeReason: failure.reason } : {}),
			hint: failure.hint,
		};
		const degraded = await withRepositoryLock(store, async (): Promise<WorktreeDegradedRestore> => {
			await ensureObjectStore(store, snapshot.id, signal);
			const configured = await configureRecordedRemotes(git, snapshot.remotes);
			// The exact restore may have stopped before it reached the recorded commit: fetch it, or take it from the bundle.
			const reached = await timeRestorePhase("fetch", () => ensureHead(git, snapshot, options.blobs, scratch)).then(
				(fetched) => ({ fetched }),
				(error: unknown) => {
					if (isWorkspaceRestoreError(error)) return undefined;
					throw error;
				},
			);
			if (reached !== undefined) {
				const partial = await timeRestorePhase("reconstruct", () =>
					applicableChanges(git, snapshot, options.blobs, scratch),
				);
				await runGit(["update-ref", "--stdin"], {
					...git,
					input: [
						`update refs/atomic/heads/${snapshot.head} ${snapshot.head}\n`,
						...(configured && reached.fetched
							? [`update ${PUSHED_REFS}${snapshot.head} ${snapshot.head}\n`]
							: []),
					].join(""),
				});
				return {
					stage: "partial-changes",
					head: snapshot.head,
					tree: partial.tree,
					missingLinks: partial.missingLinks,
					missingPaths: partial.missingPaths,
					missingCommits: [],
					...cause,
				};
			}
			const closest = await timeRestorePhase("fetch", () => closestCommit(git, snapshot, candidates, options.blobs));
			if (closest === undefined) throw failure;
			await runGit(["update-ref", "--stdin"], {
				...git,
				input: [
					`update refs/atomic/heads/${closest.commit} ${closest.commit}\n`,
					...(configured && closest.fromRemote
						? [`update ${PUSHED_REFS}${closest.commit} ${closest.commit}\n`]
						: []),
				].join(""),
			});
			return {
				stage: "closest-commit",
				head: closest.commit,
				tree: await gitText(["rev-parse", `${closest.commit}^{tree}`], git),
				basis: closest.basis,
				missingLinks: snapshot.chain.flatMap((link, index) => (link.patch === null ? [] : [index])),
				missingPaths: [],
				missingCommits: await notInHistory(git, unpushedCommits(snapshot), closest.commit),
				...cause,
			};
		});
		const measured = await publishWorktree({
			git,
			store,
			storeDir,
			path,
			into: undefined,
			head: degraded.head,
			tree: degraded.tree,
			snapshot,
			scratch,
			warn,
			signal,
			// Whatever started the degraded restore, this host's checkout filters may change the files it writes (#4744):
			// check its HEAD and keep the checkout, recording the tree it holds.
			verify: "head",
		});
		if (measured === degraded.tree) return { path, degraded, warnings };
		// This host's checkout filters changed files: record what the worktree holds, and which files differ.
		const differing = nulFields(
			(await runGit(["diff-tree", "-r", "-z", "--name-only", "--no-renames", degraded.tree, measured], git)).stdout,
		);
		const missingPaths = [...new Set([...degraded.missingPaths, ...differing])].sort();
		return { path, degraded: { ...degraded, tree: measured, missingPaths }, warnings };
	});
}

/** The commits `snapshot` recorded as not pushed: its bundle's, else those its omissions name, else its `HEAD`. */
function unpushedCommits(snapshot: WorktreeSnapshot): string[] {
	if (snapshot.bundle) return [...snapshot.bundle.commits];
	const named = snapshot.omitted.flatMap((omission) => ("commits" in omission ? omission.commits : []));
	return named.length > 0 ? [...new Set(named)] : [snapshot.head];
}

/** `commits` without those `head`'s history holds: the restored history already has them (#4744). */
async function notInHistory(git: GitRunOptions, commits: readonly string[], head: string): Promise<string[]> {
	const missing: string[] = [];
	for (const commit of commits) {
		// Exit 1: not an ancestor; 128: not in the store, so not in the restored history either.
		const { exitCode } = await runGit(["merge-base", "--is-ancestor", commit, head], {
			...git,
			allowExitCodes: [1, 128],
		});
		if (exitCode !== 0) missing.push(commit);
	}
	return missing;
}

/**
 * The tree of `snapshot`'s `HEAD` with its patch chain applied in the store, link by link, up to the first link whose
 * patch is missing, corrupt or does not give the link's tree; that link and every later one are left out whole. Lists
 * the paths the left-out links touch where their patches are readable.
 */
async function applicableChanges(
	git: GitRunOptions,
	snapshot: WorktreeSnapshot,
	blobs: SnapshotBlobStore | undefined,
	scratch: string,
): Promise<{ tree: string; missingLinks: number[]; missingPaths: string[] }> {
	const indexed: GitRunOptions = { ...git, env: { ...git.env, GIT_INDEX_FILE: join(scratch, "degraded-index") } };
	let tree = await gitText(["rev-parse", `${snapshot.head}^{tree}`], git);
	await runGit(["read-tree", tree], indexed);
	let stop = snapshot.chain.length;
	const patches: (Uint8Array | undefined)[] = [];
	for (const [deltaIndex, link] of snapshot.chain.entries()) {
		const patch =
			link.patch === null
				? null
				: await loadBlob(blobs, link.patch, { snapshotId: snapshot.id, role: "patch", deltaIndex }).catch(
						(error: unknown) => {
							if (isWorkspaceRestoreError(error)) return undefined;
							throw error;
						},
					);
		patches.push(patch ?? undefined);
		if (stop < snapshot.chain.length) continue;
		if (patch === undefined) {
			stop = deltaIndex;
			continue;
		}
		if (patch !== null) {
			const file = join(scratch, `degraded-${deltaIndex}.patch`);
			await writing(file, snapshot.id, () => writeFile(file, patch));
			// `git apply` changes nothing when any hunk does not apply, so a link is applied whole or not at all.
			const applied = await runGit(
				["apply", "--cached", "--binary", "--whitespace=nowarn", "--no-ignore-whitespace", "--no-3way", file],
				{ ...indexed, allowExitCodes: [1, 128] },
			);
			if (applied.exitCode !== 0) {
				stop = deltaIndex;
				continue;
			}
		}
		const written = await gitText(["write-tree"], indexed);
		if (written !== link.tree) {
			await runGit(["read-tree", tree], indexed);
			stop = deltaIndex;
			continue;
		}
		tree = written;
	}
	const missingLinks = snapshot.chain.flatMap((_link, index) => (index >= stop ? [index] : []));
	const missingPaths = new Set<string>();
	for (const index of missingLinks) {
		const patch = patches[index];
		if (!patch) continue;
		const file = join(scratch, `degraded-${index}.patch`);
		await writing(file, snapshot.id, () => writeFile(file, patch));
		const listed = await runGit(["apply", "--numstat", "-z", file], { ...git, allowExitCodes: [1, 128] });
		if (listed.exitCode !== 0) continue;
		for (const field of nulFields(listed.stdout)) {
			const path = field.split("\t").at(-1);
			if (path) missingPaths.add(path);
		}
	}
	return { tree, missingLinks, missingPaths: [...missingPaths].sort() };
}

/** Whether Git accepts `name`, a branch name from a snapshot record, as a branch name (`git check-ref-format --branch`). */
async function isBranchName(git: GitRunOptions, name: string): Promise<boolean> {
	if (name.startsWith("-") || name.includes("@{") || /[\u0000-\u001f\u007f]/.test(name)) return false;
	const { exitCode } = await runGit(["check-ref-format", "--branch", name], { ...git, allowExitCodes: [1, 128] });
	return exitCode === 0;
}

/**
 * The commit nearest `snapshot`'s `HEAD` that the store holds or a recorded remote supplies: the pushed base of its
 * bundle, when the bundle is readable, then each of `candidates`, then the tip of the recorded branch (the remote's
 * default branch for a detached `HEAD`).
 */
async function closestCommit(
	git: GitRunOptions,
	snapshot: WorktreeSnapshot,
	candidates: readonly string[],
	blobs: SnapshotBlobStore | undefined,
): Promise<{ commit: string; basis: WorktreeDegradedRestoreBasis; fromRemote: boolean } | undefined> {
	const tried = new Set<string>([snapshot.head]);
	const reachable = async (commit: string): Promise<{ commit: string; fromRemote: boolean } | undefined> => {
		if (tried.has(commit)) return undefined;
		tried.add(commit);
		if (await hasObject(git, `${commit}^{commit}`)) return { commit, fromRemote: false };
		const fetched = await fetchCommits(git, snapshot.remotes, [commit]);
		return fetched.supplied && (await hasObject(git, `${commit}^{commit}`))
			? { commit, fromRemote: true }
			: undefined;
	};
	if (snapshot.bundle) {
		const data = await blobs?.getBlob(snapshot.bundle.blob).catch(() => undefined);
		if (data !== undefined && sha256Hex(data) === snapshot.bundle.blob) {
			const prerequisites = bundlePrerequisites(data);
			assertUsableBundlePrerequisites(prerequisites, snapshot.id);
			for (const commit of prerequisites) {
				const found = await reachable(commit);
				if (found) return { ...found, basis: "pushed-base" };
			}
		}
	}
	for (const commit of candidates) {
		const found = await reachable(commit);
		if (found) return { ...found, basis: "earlier-snapshot" };
	}
	// The recorded branch's tip, when Git accepts its name as a branch; the remote's default branch only for a
	// detached HEAD, never in place of a branch that has a name.
	if (snapshot.branch !== null && !(await isBranchName(git, snapshot.branch))) return undefined;
	const source = snapshot.branch === null ? "HEAD" : `refs/heads/${snapshot.branch}`;
	const ref = `refs/atomic/tips/${snapshot.id}`;
	for (const remote of snapshot.remotes) {
		try {
			await runFetch(git, remote, [`+${source}:${ref}`]);
			noteRestoreFetch("full");
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
			continue;
		}
		const tip = await runGit(["rev-parse", "-q", "--verify", `${ref}^{commit}`], {
			...git,
			allowExitCodes: [1, 128],
		});
		await runGit(["update-ref", "-d", ref], git);
		if (tip.exitCode === 0)
			return { commit: tip.stdout.toString("utf8").trim(), basis: "branch-tip", fromRemote: true };
	}
	return undefined;
}

interface PublishWorktree {
	readonly git: GitRunOptions;
	readonly store: string;
	readonly storeDir: string;
	readonly path: string;
	readonly into: string | undefined;
	readonly head: string;
	readonly tree: string;
	readonly snapshot: WorktreeSnapshot | null;
	readonly scratch: string;
	readonly warn: (warning: WorktreeRestoreWarning) => void;
	readonly signal: AbortSignal | undefined;
	/**
	 * What the staged worktree is checked against before it is moved to `path`: its HEAD and recomputed tree (`tree`),
	 * or its HEAD alone (`head`), for a degraded restore whose content this host's filters may change.
	 */
	readonly verify: "tree" | "head";
}

/**
 * Checks `head` and `tree` out of `store` into a staging worktree, verifies it, and moves it to `path`, under a crash
 * record, so a final path never holds an unverified worktree.
 */
async function publishWorktree(publish: PublishWorktree): Promise<string> {
	const { git, store, storeDir, path, head, tree, snapshot, scratch, warn, signal } = publish;
	let measured = tree;
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
	const snapshotId = snapshot?.id ?? null;
	await checkTarget(path, snapshotId);
	const createdTarget = (await statIfPresent(path)) === undefined;
	const id = randomUUID();
	const staging =
		publish.into === undefined
			? join(storeDir, "worktrees", `.staging-${id}`)
			: join(dirname(path), `.${basename(path)}.atomic-restore-${id}`);
	const record: RestoreRecord = { staging, target: path, store, createdTarget };
	await withRestoreRecord(storeDir, id, record, snapshotId, warn, signal, async (assertActive) => {
		await timeRestorePhase("materialize", () => materialize(git, staging, head, tree, scratch, snapshotId, signal));
		assertActive();
		if (snapshot?.filters?.drivers.includes("lfs")) {
			const worktree: GitRunOptions = { cwd: staging, signal };
			const pointers = await timeRestorePhase("lfs", () => pullLfsObjects(worktree, head, tree, snapshot.remotes));
			if (pointers.length > 0) warn({ code: "lfs-objects-unavailable", paths: pointers });
		}
		await timeRestorePhase("verify", async () => {
			const checkout = await locateCheckout(staging, signal);
			if (checkout instanceof Error) throw checkout;
			const policy = await loadSnapshotPathPolicy(staging);
			const actual = await withScratchDirectory((verifyScratch) =>
				writeWorkingTree(checkout, settings, policy, verifyScratch, {
					signal,
					neutral: true,
					seedTree: tree,
					attributesFile: join(scratch, "empty-attributes"),
				}),
			);
			measured = actual.tree;
			if (checkout.head !== head || (publish.verify === "tree" && actual.tree !== tree)) {
				throw new WorkspaceRestoreError("tree-mismatch", {
					snapshotId,
					target: path,
					expectedTree: tree,
					actualTree: actual.tree,
				});
			}
		});
		assertActive();
		await timeRestorePhase("publish", () => moveIntoPlace(publish, staging, createdTarget, snapshotId));
		assertActive();
	});
	return measured;
}

/** Moves the verified staging worktree to the restore's final path, never into a directory that appeared there. */
async function moveIntoPlace(
	publish: PublishWorktree,
	staging: string,
	createdTarget: boolean,
	snapshotId: string | null,
): Promise<void> {
	const { git, path, warn } = publish;
	if (createdTarget) {
		if ((await statIfPresent(path)) !== undefined) {
			throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target: path, reason: "not-empty" });
		}
	} else {
		await writing(path, snapshotId, () => rmdir(path));
	}
	await runGit(["worktree", "move", staging, path], git);
	// Git moves *inside* an existing directory. If one appeared after our check, never return it as the
	// verified worktree: remove only the nested worktree that Git registered and leave the user's files alone.
	const registered = await registeredWorktrees(git);
	const destination = await physicalPath(path);
	if (!includesPath(registered, destination)) {
		const error = new WorkspaceRestoreError("unsafe-target", { snapshotId, target: path, reason: "not-empty" });
		const nested = join(destination, basename(staging));
		if (includesPath(registered, nested)) {
			try {
				await runGit(["worktree", "remove", "--force", "--force", nested], { ...git, signal: undefined });
			} catch (cleanupCause) {
				Object.defineProperty(error, "cleanupCause", { value: cleanupCause, configurable: true });
				warn({ code: "stale-restore-retained", path: nested, kind: "worktree" });
			}
		}
		throw error;
	}
}

/** The entry at `path`, or undefined when there is none. */
async function statIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw unreadablePathError(path, error);
	}
}

/**
 * Removes a worktree that a restore created, for callers that roll back a multi-checkout restore; a path that no
 * longer exists is already removed. Refuses, with `unsafe-target` (reason `not-restored`), any path that is not a
 * worktree of a shared store under `storeDir`, including a file, so it can never touch a user's checkout.
 */
export async function removeRestoredWorktree(
	path: string,
	options: {
		readonly storeDir?: string;
		readonly signal?: AbortSignal;
		readonly onWarning?: (warning: WorktreeRestoreWarning) => void;
	} = {},
): Promise<void> {
	const target = resolve(path);
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const warned = new Set<string>();
	await sweepRestoreRecords(
		storeDir,
		(warning) => {
			if (warning.code !== "stale-restore-retained" || warned.has(warning.path)) return;
			warned.add(warning.path);
			if (options.onWarning) options.onWarning(warning);
			else
				process.emitWarning(
					`A restore interrupted earlier left ${warning.path}; remove the directory and retry cleanup.`,
				);
		},
		options.signal,
	);
	const entry = await statIfPresent(target);
	if (entry === undefined) return;
	const repositories = join(storeDir, "repositories");
	const common = entry.isDirectory()
		? await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
				cwd: target,
				signal: options.signal,
				allowExitCodes: [128],
			})
		: undefined;
	const store = common ? resolve(common.stdout.toString("utf8").trim()) : "";
	if (
		common?.exitCode !== 0 ||
		!isWithin(repositories, store) ||
		relative(store, target) === "" ||
		isWithin(store, target)
	) {
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target, reason: "not-restored" });
	}
	await removeWorktree({ cwd: repositories, env: { GIT_DIR: store }, signal: options.signal }, target);
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Restores `target` into a new worktree and resolves to its path after verifying its HEAD and tree. Restore-time
 * notices (omitted content, conversion filters, unavailable LFS objects) go to `onWarning`.
 */
export async function restoreWorktreeSnapshot(
	target: WorkspaceBinding | WorktreeSnapshot,
	options: RestoreWorktreeSnapshotOptions = {},
): Promise<string> {
	return (await restoreWorktree(target, options)).path;
}

export interface VerifyWorktreeOptions {
	/** Snapshot settings that decide whether a file the recorded tree does not hold counts as drift. */
	readonly settings?: WorktreeSnapshotSettingsInput;
	readonly signal?: AbortSignal;
}

/**
 * Resolves to the binding of the checkout at `dir` when its HEAD and policy-filtered tree equal `binding`'s; rejects
 * with {@link WorkspaceDriftError} otherwise, and with the typed reason when Git or a repository is missing.
 */
export async function verifyWorktree(
	binding: WorkspaceBinding | WorktreeSnapshot,
	dir: string,
	options: VerifyWorktreeOptions = {},
): Promise<WorkspaceBinding> {
	if (!isBinding(binding)) throw new WorkspaceConfigError("sdk", "binding", "a WorkspaceBinding");
	if (typeof dir !== "string" || dir.length === 0) throw new WorkspaceConfigError("sdk", "dir", "a directory path");
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	assertUsableSnapshotRecord(binding, isSnapshot(binding) ? binding : null);
	const checkout = await locateCheckout(dir, options.signal);
	if (checkout instanceof Error) throw checkout;
	if (!(await hasObject({ cwd: checkout.root, signal: options.signal }, `${binding.tree}^{tree}`))) {
		throw new WorkspaceDriftError({
			root: checkout.root,
			expectedHead: binding.head,
			actualHead: checkout.head,
			expectedTree: binding.tree,
			actualTree: null,
			snapshotId: isSnapshot(binding) ? binding.id : null,
		});
	}
	const policy = await loadSnapshotPathPolicy(checkout.root);
	const state = await withScratchDirectory((scratch) =>
		writeWorkingTree(checkout, settings, policy, scratch, { signal: options.signal, seedTree: binding.tree }),
	);
	if (checkout.head !== binding.head || state.tree !== binding.tree) {
		throw new WorkspaceDriftError({
			root: checkout.root,
			expectedHead: binding.head,
			actualHead: checkout.head,
			expectedTree: binding.tree,
			actualTree: state.tree,
			snapshotId: isSnapshot(binding) ? binding.id : null,
		});
	}
	return {
		remotes: (await readRepositoryConfig(checkout.root, options.signal)).remotes,
		head: checkout.head,
		tree: state.tree,
		envHash: await computeEnvironmentHash(checkout.root),
	};
}
