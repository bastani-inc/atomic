import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";
import { locateCheckout, readRepositoryConfig, withScratchDirectory, writeWorkingTree } from "./capture.ts";
import { computeEnvironmentHash, sha256Hex } from "./env-hash.ts";
import {
	isWorkspaceGitError,
	unreadablePathError,
	unwritablePathError,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceGitError,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorFields,
} from "./errors.ts";
import { type GitRunOptions, type GitRunResult, gitText, nulFields, runGit } from "./git.ts";
import { loadSnapshotPathPolicy } from "./policy.ts";
import { assertUsableBundlePrerequisites, assertUsableSnapshotRecord } from "./records.ts";
import {
	DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	resolveWorktreeSnapshotSettings,
	type WorktreeSnapshotSettingsInput,
} from "./settings.ts";
import type { SnapshotBlobStore, WorkspaceBinding, WorktreeRestoreWarning, WorktreeSnapshot } from "./types.ts";

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
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw unreadablePathError(target, error);
	}
	if (!empty) throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target, reason: "not-empty" });
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
		warn({ code: "stale-restore-retained", path: recordsDir });
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
				warn({ code: "stale-restore-retained", path: warningPath });
			}
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					if (!compromised) warn({ code: "stale-restore-retained", path: warningPath });
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
			warn({ code: "stale-restore-retained", path: record.staging });
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
				warn({ code: "stale-restore-retained", path: record.staging });
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
				warn({ code: "stale-restore-retained", path: record.staging });
			}
		}
	}
}

async function ensureObjectStore(
	storeDir: string,
	remotes: readonly string[],
	snapshotId: string | null,
	signal?: AbortSignal,
): Promise<string> {
	const repositories = join(storeDir, "repositories");
	const store = join(repositories, `${sha256Hex(remotes.join("\n")).slice(0, 24)}.git`);
	await writing(repositories, snapshotId, () => mkdir(repositories, { recursive: true }));
	await runGit(["init", "-q", "--bare", store], { cwd: repositories, signal });
	return store;
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

async function fetchCommits(
	git: GitRunOptions,
	remotes: readonly string[],
	commits: readonly string[],
): Promise<Error | undefined> {
	let failure: Error | undefined;
	for (const remote of remotes) {
		const missing = [];
		for (const commit of commits) if (!(await hasObject(git, `${commit}^{commit}`))) missing.push(commit);
		if (missing.length === 0) return undefined;
		try {
			await runFetch(git, remote, missing);
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
			failure = error;
		}
	}
	return failure;
}

async function ensureHead(
	git: GitRunOptions,
	snapshot: Pick<WorktreeSnapshot, "head" | "remotes" | "bundle" | "omitted"> & { readonly id: string | null },
	blobs: SnapshotBlobStore | undefined,
	scratch: string,
): Promise<void> {
	const { head } = snapshot;
	if (!(await hasObject(git, `${head}^{commit}`))) {
		let failure = await fetchCommits(git, snapshot.remotes, [head]);
		if (!(await hasObject(git, `${head}^{commit}`)) && snapshot.bundle) {
			const data = await loadBlob(blobs, snapshot.bundle.blob, { snapshotId: snapshot.id, role: "bundle" });
			const prerequisites = bundlePrerequisites(data);
			assertUsableBundlePrerequisites(prerequisites, snapshot.id);
			failure = (await fetchCommits(git, snapshot.remotes, prerequisites)) ?? failure;
			const file = join(scratch, "history.bundle");
			await writing(file, snapshot.id, () => writeFile(file, data));
			try {
				await runFetch(git, file, ["HEAD"]);
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
	await runGit(["update-ref", `refs/atomic/heads/${head}`, head], git);
}

async function reconstructTree(
	git: GitRunOptions,
	snapshot: WorktreeSnapshot,
	patches: readonly (Uint8Array | null)[],
	scratch: string,
): Promise<void> {
	const indexed: GitRunOptions = { ...git, env: { ...git.env, GIT_INDEX_FILE: join(scratch, "restore-index") } };
	await runGit(["read-tree", snapshot.head], indexed);
	for (const [deltaIndex, link] of snapshot.chain.entries()) {
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

/**
 * Downloads the Git LFS objects of the staged worktree from the first recorded remote that has them. The staging
 * worktree belongs to a per-repository store that is created without remotes, so each recorded remote is named
 * explicitly, after `--` so that a value can never be read as an option, and the download can never wait for a person.
 * Resolves false when no remote supplied the objects, or none is recorded.
 */
async function pullLfsObjects(worktree: GitRunOptions, remotes: readonly string[]): Promise<boolean> {
	for (const remote of remotes) {
		try {
			await runGit(["lfs", "pull", "--", lfsRemote(remote)], { ...worktree, nonInteractive: true });
			return true;
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
		}
	}
	return false;
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
 * blob before writing to the target; on failure removes what it created and throws a typed error.
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
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
	const { signal } = options;
	const snapshot = resolveSnapshot(target, options.snapshots);
	assertUsableSnapshotRecord(target, snapshot);
	const snapshotId = snapshot?.id ?? null;
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const path = resolve(
		options.into ??
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
		const store = await ensureObjectStore(storeDir, target.remotes, snapshotId, signal);
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		await withRepositoryLock(store, async () => {
			await ensureHead(
				git,
				snapshot ?? { id: null, head: target.head, remotes: target.remotes, bundle: null, omitted: [] },
				options.blobs,
				scratch,
			);
			if (!(await hasObject(git, `${target.tree}^{tree}`))) {
				if (!snapshot) {
					throw new WorkspaceRestoreError("snapshot-not-found", {
						snapshotId: null,
						head: target.head,
						tree: target.tree,
					});
				}
				await reconstructTree(git, snapshot, patches, scratch);
			}
		});
		await checkTarget(path, snapshotId);
		const createdTarget = (await statIfPresent(path)) === undefined;
		const id = randomUUID();
		const staging =
			options.into === undefined
				? join(storeDir, "worktrees", `.staging-${id}`)
				: join(dirname(path), `.${basename(path)}.atomic-restore-${id}`);
		const record: RestoreRecord = { staging, target: path, store, createdTarget };
		await withRestoreRecord(storeDir, id, record, snapshotId, warn, signal, async (assertActive) => {
			await materialize(git, staging, target.head, target.tree, scratch, snapshotId, signal);
			assertActive();
			if (snapshot?.filters?.drivers.includes("lfs")) {
				const worktree: GitRunOptions = { cwd: staging, signal };
				if (!(await pullLfsObjects(worktree, snapshot.remotes))) {
					warn({ code: "lfs-objects-unavailable", paths: await lfsPaths(worktree) });
				}
			}
			const checkout = await locateCheckout(staging, signal);
			if (checkout instanceof Error) throw checkout;
			const policy = await loadSnapshotPathPolicy(staging);
			const actual = await withScratchDirectory((verifyScratch) =>
				writeWorkingTree(checkout, settings, policy, verifyScratch, {
					signal,
					neutral: true,
					seedTree: target.tree,
					attributesFile: join(scratch, "empty-attributes"),
				}),
			);
			if (checkout.head !== target.head || actual.tree !== target.tree) {
				throw new WorkspaceRestoreError("tree-mismatch", {
					snapshotId,
					target: path,
					expectedTree: target.tree,
					actualTree: actual.tree,
				});
			}
			assertActive();
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
						warn({ code: "stale-restore-retained", path: nested });
					}
				}
				throw error;
			}
			assertActive();
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
	const store = common?.stdout.toString("utf8").trim() ?? "";
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
