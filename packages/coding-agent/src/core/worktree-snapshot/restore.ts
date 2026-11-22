import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { pathExists } from "../../utils/path-exists.ts";
import { releaseLock } from "../lock-release.ts";
import { takeTakeoverMutexAsync } from "../lock-takeover.js";
import { renameWithRetry } from "../rename-retry.ts";
import { deferRestorePhase, noteRestoreFetch, timeRestorePhase } from "../resume/timings.ts";
import {
	locateCheckout,
	RESTORED_TREE_FILE,
	readRepositoryConfig,
	recordRestoredTree,
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
import {
	assertRestorePathBudget,
	canonicalizeWorktreePathAsync,
	defaultWorktreeSnapshotStoreDir,
	stagingWorktreeName,
} from "./paths.ts";
import { loadSnapshotPathPolicy } from "./policy.ts";
import { HOST, holderRuns, type ProcessHolder, thisProcess } from "./process-holder.js";
import { assertUsableBundlePrerequisites, assertUsableSnapshotRecord, isAllowedRemote } from "./records.ts";
import { checkoutStoreIdOf, sameRemote, sharedRepositoryIdsOf } from "./repository-identity.ts";
import {
	DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	resolveWorktreeSnapshotSettings,
	type WorktreeSnapshotSettingsInput,
} from "./settings.ts";
import { lockShared } from "./shared-clock.ts";
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
	 * Takes the Git LFS download of an exact restore off the restore (#5099): the restore verifies and publishes the
	 * worktree with its LFS files still holding pointers, then hands `pull` to this callback instead of downloading.
	 * `pull` downloads the objects into `worktree` as the restore would have, and resolves to the files that still hold
	 * pointers, for which the restore would have warned `lfs-objects-unavailable`. A degraded restore still downloads
	 * before it records the tree it holds.
	 */
	readonly deferLfs?: (worktree: string, pull: () => Promise<readonly string[]>) => void;
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

export { defaultWorktreeSnapshotStoreDir };

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

/**
 * The `commits` the store lacks as commits, asked of one Git process rather than one per commit. A store that cannot
 * answer the batch is asked per commit, as {@link hasObject} does.
 */
async function missingCommits(git: GitRunOptions, commits: readonly string[]): Promise<string[]> {
	if (commits.length <= 1) {
		const missing: string[] = [];
		for (const commit of commits) if (!(await hasObject(git, `${commit}^{commit}`))) missing.push(commit);
		return missing;
	}
	const { stdout, exitCode } = await runGit(["cat-file", "--batch-check=%(objecttype)"], {
		...git,
		input: commits.map((commit) => `${commit}^{commit}\n`).join(""),
		allowExitCodes: [128],
	});
	const types = stdout.toString("utf8").split("\n");
	if (exitCode !== 0 || types.length <= commits.length) {
		const missing: string[] = [];
		for (const commit of commits) if (!(await hasObject(git, `${commit}^{commit}`))) missing.push(commit);
		return missing;
	}
	return commits.filter((_, index) => types[index] !== "commit");
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

/** Serializes work on one shared object store within this process, ahead of its cross-process lock. */
async function withProcessRepositoryLock<T>(store: string, action: () => Promise<T>): Promise<T> {
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

/** The repository lock's constants: a stopped process loses it after 30 seconds; a held one is checked every 50 ms. */
const REPOSITORY_LOCK_STALE_MS = 30_000;
const REPOSITORY_LOCK_UPDATE_MS = 10_000;
const REPOSITORY_LOCK_POLL_MS = 50;
/** How long, on Windows, the repository lock is tried again while its directory is refused with EPERM. */
export const REPOSITORY_LOCK_REFUSED_MS = 10_000;

/**
 * Whether creating the lock directory failed only for a moment: Windows refuses with EPERM to create a directory
 * another process has just removed while a third still has it open, as other waiters' checks of the lock do.
 */
function refusedForAMoment(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32";
}

/**
 * Serializes work on one shared object store, in this process and across processes (#4951): creating the store,
 * configuring its remotes, fetching into it and updating its refs. Git's own locks fail rather than wait, so two
 * processes doing either at once would fail one of them. Waiters in this process queue behind each other; across
 * processes, the store's lock file `<store>.lock` is polled until it is free or its holder stopped refreshing it. On
 * Windows a lock directory refused with EPERM is polled too, for up to {@link REPOSITORY_LOCK_REFUSED_MS} on end.
 */
function withRepositoryLock<T>(
	store: string,
	snapshotId: string | null,
	signal: AbortSignal | undefined,
	action: () => Promise<T>,
): Promise<T> {
	return withProcessRepositoryLock(store, async () => {
		const unlock = await lockRepository(store, snapshotId, signal);
		try {
			return await action();
		} finally {
			// A release that fails leaves a lock file nothing refreshes, which the next waiter takes once it is stale.
			await releaseLock(unlock, store);
		}
	});
}

/** Takes the cross-process lock of `store`, waiting while another live process holds it. */
async function lockRepository(
	store: string,
	snapshotId: string | null,
	signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
	const repositories = dirname(store);
	await writing(repositories, snapshotId, () => mkdir(repositories, { recursive: true }));
	let refusedSince: number | undefined;
	for (;;) {
		signal?.throwIfAborted();
		try {
			return await lockShared(store, {
				realpath: false,
				stale: REPOSITORY_LOCK_STALE_MS,
				update: REPOSITORY_LOCK_UPDATE_MS,
				retries: 0,
				// A lost lock only lets another process into the store early, where Git's own locks still guard each write.
				onCompromised: () => {},
			});
		} catch (error) {
			if (refusedForAMoment(error)) {
				refusedSince ??= Date.now();
				// A refusal that lasts is a directory this process may not write to.
				if (Date.now() - refusedSince >= REPOSITORY_LOCK_REFUSED_MS)
					throw unwritablePathError(`${store}.lock`, snapshotId, error);
			} else if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
				refusedSince = undefined;
			} else {
				throw unwritablePathError(`${store}.lock`, snapshotId, error);
			}
		}
		await sleep(REPOSITORY_LOCK_POLL_MS);
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
	/** The tree this restore checks out into its staging worktree. Records of earlier versions have none. */
	readonly tree?: string;
	/**
	 * The identity of the staging directory as `git worktree add` created it, recorded right after, under the store lock.
	 * A directory is set aside or deleted as this restore's only while it is that same directory: copying or moving
	 * other files to its path never makes another directory look like it. Missing until it was recorded.
	 */
	readonly identity?: DirectoryIdentity;
}

/** A directory's device, inode (a Windows file ID) and birth time, as decimal strings: what no other directory shares. */
interface DirectoryIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly birthtime: string;
}

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
	if (typeof value !== "object" || value === null) return false;
	const identity = value as Partial<DirectoryIdentity>;
	return [identity.dev, identity.ino, identity.birthtime].every(
		(field) => typeof field === "string" && /^\d+$/.test(field),
	);
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
		(record.tree !== undefined &&
			(typeof record.tree !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.tree))) ||
		(record.identity !== undefined && !isDirectoryIdentity(record.identity)) ||
		resolve(record.target) !== record.target ||
		resolve(record.staging) !== record.staging ||
		resolve(record.store) !== record.store ||
		dirname(record.store) !== join(storeDir, "repositories") ||
		!/^[0-9a-f]{24}\.git$/.test(basename(record.store))
	)
		return false;
	// Earlier versions named staging worktrees `.staging-<id>` and `.<target>.atomic-restore-<id>` (#5139).
	const defaultStaging = [stagingWorktreeName(id), `.staging-${id}`].map((name) => join(storeDir, "worktrees", name));
	const { staging, target } = record;
	const siblingStaging = [stagingWorktreeName(id), `.atomic-restore-${id}`].map((suffix) =>
		join(dirname(target), `.${basename(target)}${suffix}`),
	);
	return (
		siblingStaging.includes(staging) ||
		(defaultStaging.includes(staging) && dirname(target) === join(storeDir, "worktrees"))
	);
}

/** The lines of `git worktree list --porcelain` other than a worktree's path, as Git before 2.36 writes them. */
const WORKTREE_LIST_ATTRIBUTE = /^(?:HEAD|branch|bare|detached|locked|prunable)(?: |$)/;

/**
 * Git's registered worktree paths, without shell quoting or newline ambiguity. Git before 2.36 has no `-z` (it exits
 * with 129 on it) and writes each path on a line of its own: there, a path with a line break, which those lines cannot
 * tell from two, fails the listing rather than be misread.
 */
async function registeredWorktrees(git: GitRunOptions): Promise<string[]> {
	const listed = await runGit(["worktree", "list", "--porcelain", "-z"], { ...git, allowExitCodes: [129] });
	if (listed.exitCode === 0) {
		return nulFields(listed.stdout)
			.filter((field) => field.startsWith("worktree "))
			.map((field) => field.slice("worktree ".length));
	}
	const paths: string[] = [];
	for (const line of (await runGit(["worktree", "list", "--porcelain"], git)).stdout.toString("utf8").split("\n")) {
		if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
		else if (line !== "" && !WORKTREE_LIST_ATTRIBUTE.test(line)) {
			throw new WorkspaceGitError({
				operation: "worktree list",
				cwd: git.cwd,
				exitCode: null,
				detail: "a worktree path has a line break, which Git before 2.36 cannot list; update Git",
			});
		}
	}
	return paths;
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

/** The administrative directory the `.git` file of the directory at `path` names, or undefined when there is none. */
async function worktreeAdminDir(path: string): Promise<string | undefined> {
	try {
		if (!(await lstat(path)).isDirectory()) return undefined;
		const link = join(path, ".git");
		if (!(await lstat(link)).isFile()) return undefined;
		const named = /^gitdir: (.+)$/m.exec(await readFile(link, "utf8"));
		return named === null ? undefined : await realpath(resolve(path, named[1]!.trim()));
	} catch {
		return undefined;
	}
}

/** The administrative directory of `store` that holds a worktree's own Git files, read through any symlink. */
async function storeAdminDirs(store: string): Promise<string | undefined> {
	try {
		return await realpath(join(store, "worktrees"));
	} catch {
		return undefined;
	}
}

/** The identity of the directory at `path` itself, never what a link there points to; undefined for anything else. */
async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
	const entry = await lstat(path, { bigint: true }).catch(() => undefined);
	if (!entry?.isDirectory()) return undefined;
	return { dev: String(entry.dev), ino: String(entry.ino), birthtime: String(entry.birthtimeNs) };
}

function sameIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.birthtime === b.birthtime;
}

/**
 * How many files whose bytes differ from their blob, as a conversion at checkout leaves them, cleanup compares with what
 * the checkout writes before it keeps the worktree, set aside, instead: each takes a Git process.
 */
const MAX_CONVERTED_FILES_CHECKED = 1000;

/** What a file a restore checked out holds, checked again right before the file is deleted. */
type RestoredEntry =
	| { readonly kind: "file"; readonly algorithm: "sha1" | "sha256"; readonly digest: string; readonly blob: boolean }
	| { readonly kind: "link"; readonly target: string }
	| { readonly kind: "text"; readonly content: string };

/** The digest of the file at `path` under `algorithm`, as a Git blob of `size` bytes when `blob`, else of its bytes. */
async function digestOf(
	path: string,
	algorithm: "sha1" | "sha256",
	blob: boolean,
	size: bigint | number,
): Promise<string> {
	const hash = createHash(algorithm);
	if (blob) hash.update(`blob ${size}\0`);
	const handle = await open(path, "r");
	try {
		for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/** The blobs `oids` of `store`, by id; an id the store does not hold as a blob is left out. */
async function storeBlobs(store: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
	const blobs = new Map<string, Buffer>();
	if (oids.length === 0) return blobs;
	const output = (
		await runGit(["cat-file", "--batch"], {
			cwd: dirname(store),
			env: { GIT_DIR: store },
			input: `${oids.join("\n")}\n`,
		})
	).stdout;
	let at = 0;
	while (at < output.length) {
		const end = output.indexOf(10, at);
		if (end < 0) break;
		const [oid, type, size] = output.subarray(at, end).toString("utf8").split(" ");
		at = end + 1;
		if (type !== "blob" || oid === undefined) continue;
		const length = Number(size);
		blobs.set(oid, output.subarray(at, at + length));
		at += length + 1;
	}
	return blobs;
}

/** The Git LFS object a pointer blob names, or undefined when the blob is not a pointer. */
function lfsObject(pointer: Buffer): { readonly oid: string; readonly size: number } | undefined {
	if (pointer.length > 1024) return undefined;
	const text = pointer.toString("utf8");
	if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n")) return undefined;
	const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
	const size = /^size (\d+)$/m.exec(text)?.[1];
	return oid === undefined || size === undefined ? undefined : { oid, size: Number(size) };
}

/**
 * The files of every tree a restore may have checked out into the worktree whose administrative directory is `admin`:
 * the record's `tree`, the tree the restore recorded there and the tree of its `HEAD`. All are in `store`, so a file
 * with one of their contents at its path is never lost when it is deleted.
 */
async function restoredTreeEntries(
	store: string,
	tree: string | undefined,
	admin: string | undefined,
): Promise<Map<string, { readonly mode: string; readonly oid: string }[]>> {
	const git: GitRunOptions = { cwd: dirname(store), env: { GIT_DIR: store } };
	const trees = new Set<string>(tree === undefined ? [] : [tree]);
	if (admin !== undefined) {
		const recorded = (await readFile(join(admin, RESTORED_TREE_FILE), "utf8").catch(() => "")).trim();
		if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recorded)) trees.add(recorded);
		const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], {
			...git,
			env: { GIT_DIR: admin },
			allowExitCodes: [1, 128],
		});
		const headTree = head.exitCode === 0 ? head.stdout.toString("utf8").trim() : "";
		if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headTree)) trees.add(headTree);
	}
	const entries = new Map<string, { readonly mode: string; readonly oid: string }[]>();
	for (const listed of trees) {
		const listing = await runGit(["ls-tree", "-r", "-z", "--full-tree", listed], { ...git, allowExitCodes: [128] });
		if (listing.exitCode !== 0) continue;
		for (const field of nulFields(listing.stdout)) {
			const tab = field.indexOf("\t");
			const [mode, , oid] = field.slice(0, tab).split(" ");
			if (mode === undefined || oid === undefined) continue;
			const path = field.slice(tab + 1);
			entries.set(path, [...(entries.get(path) ?? []), { mode, oid }]);
		}
	}
	return entries;
}

/**
 * What deleting the directory at `path` would delete, when that is only what a restore put there (#4748): each file has,
 * at its path, the content of a tree the restore may have checked out, as a Git blob or as the Git LFS object its
 * pointer names; each symlink that tree's target; and a root `.git` file names an administrative directory of `store`.
 * Undefined when anything else is there, or when `path` is not a directory itself.
 */
async function inspectRestoredContent(
	path: string,
	store: string,
	tree: string | undefined,
	own = false,
): Promise<Map<string, RestoredEntry> | undefined> {
	try {
		if (!(await lstat(path)).isDirectory()) return undefined;
		const admin = await worktreeAdminDir(path);
		const admins = await storeAdminDirs(store);
		const inStore = admin !== undefined && admins !== undefined && isWithin(admins, admin);
		const entries = await restoredTreeEntries(store, tree, inStore ? admin : undefined);
		const found = new Map<string, RestoredEntry>();
		const unmatched: {
			readonly path: string;
			readonly name: string;
			readonly size: bigint;
			readonly link: boolean;
		}[] = [];
		const visit = async (dir: string, prefix: string): Promise<boolean> => {
			for (const name of await readdir(dir)) {
				const absolute = join(dir, name);
				const relativeName = prefix === "" ? name : `${prefix}/${name}`;
				const entry = await lstat(absolute, { bigint: true });
				if (entry.isDirectory()) {
					if (!(await visit(absolute, relativeName))) return false;
				} else if (relativeName === ".git" && entry.isFile()) {
					if (!inStore) return false;
					found.set(relativeName, { kind: "text", content: await readFile(absolute, "utf8") });
				} else if (entry.isSymbolicLink()) {
					unmatched.push({ path: absolute, name: relativeName, size: entry.size, link: true });
				} else if (entry.isFile()) {
					const candidates = entries.get(relativeName) ?? [];
					const algorithm = candidates[0]?.oid.length === 64 ? "sha256" : "sha1";
					const digest = candidates.length === 0 ? "" : await digestOf(absolute, algorithm, true, entry.size);
					if (candidates.some((candidate) => candidate.oid === digest && candidate.mode !== "160000"))
						found.set(relativeName, { kind: "file", algorithm, digest, blob: true });
					else if (candidates.length === 0) return false;
					else unmatched.push({ path: absolute, name: relativeName, size: entry.size, link: false });
				} else return false;
			}
			return true;
		};
		if (!(await visit(path, ""))) return undefined;
		const converted: { readonly name: string; readonly path: string; readonly digest: string }[] = [];
		const blobs = await storeBlobs(
			store,
			unmatched.flatMap((file) => (entries.get(file.name) ?? []).map((candidate) => candidate.oid)),
		);
		for (const file of unmatched) {
			const candidates = (entries.get(file.name) ?? []).flatMap((candidate) => {
				const blob = blobs.get(candidate.oid);
				return blob === undefined ? [] : [{ mode: candidate.mode, blob }];
			});
			if (file.link) {
				const target = await readlink(file.path);
				if (
					!candidates.some(
						(candidate) => candidate.mode === "120000" && candidate.blob.toString("utf8") === target,
					)
				)
					return undefined;
				found.set(file.name, { kind: "link", target });
				continue;
			}
			const object = candidates
				.map((candidate) => lfsObject(candidate.blob))
				.find((pointer) => pointer !== undefined && BigInt(pointer.size) === file.size);
			const digest = await digestOf(file.path, "sha256", false, file.size);
			if (object !== undefined && digest === object.oid) {
				found.set(file.name, { kind: "file", algorithm: "sha256", digest, blob: false });
				continue;
			}
			if (
				own &&
				(await beginsAny(
					file.path,
					file.size,
					candidates.map((candidate) => candidate.blob),
				))
			) {
				found.set(file.name, { kind: "file", algorithm: "sha256", digest, blob: false });
				continue;
			}
			converted.push({ name: file.name, path: file.path, digest });
		}
		// A file the checkout converted, as for an end-of-line rule or a smudge filter, is the snapshot's only when its bytes
		// are exactly what the checkout writes for that path: never because a clean filter, which may drop an edit, maps it
		// back to a blob.
		if (converted.length > MAX_CONVERTED_FILES_CHECKED || (converted.length > 0 && !inStore)) return undefined;
		for (const file of converted) {
			let written = false;
			for (const candidate of entries.get(file.name) ?? []) {
				const checkout = await runGit(
					["-c", `core.attributesFile=${devNull}`, "cat-file", "--filters", `--path=${file.name}`, candidate.oid],
					{
						cwd: path,
						env: { GIT_DIR: admin!, GIT_WORK_TREE: path, GIT_LFS_SKIP_SMUDGE: "1" },
						neutral: true,
						allowExitCodes: [128],
					},
				);
				if (
					checkout.exitCode === 0 &&
					(createHash("sha256").update(checkout.stdout).digest("hex") === file.digest ||
						(own && (await beginsAny(file.path, undefined, [checkout.stdout]))))
				) {
					written = true;
					break;
				}
			}
			if (!written) return undefined;
			found.set(file.name, { kind: "file", algorithm: "sha256", digest: file.digest, blob: false });
		}
		return found;
	} catch {
		return undefined;
	}
}

/**
 * Whether the bytes of the file at `path` are a beginning of one of `contents`, as a checkout stopped while it wrote the
 * file leaves it: its whole content is then still in the store, so deleting it loses nothing.
 */
async function beginsAny(path: string, size: bigint | undefined, contents: readonly Buffer[]): Promise<boolean> {
	const length = size === undefined ? (await lstat(path)).size : Number(size);
	const longer = contents.filter((content) => content.length >= length);
	if (longer.length === 0) return false;
	const bytes = await readFile(path);
	return longer.some((content) => bytes.length <= content.length && content.subarray(0, bytes.length).equals(bytes));
}

/** Whether the entry at `path` still holds what an inspection found there. */
async function stillRestored(path: string, expected: RestoredEntry): Promise<boolean> {
	const entry = await lstat(path, { bigint: true });
	if (expected.kind === "link") return entry.isSymbolicLink() && (await readlink(path)) === expected.target;
	if (!entry.isFile()) return false;
	if (expected.kind === "text") return (await readFile(path, "utf8")) === expected.content;
	return (await digestOf(path, expected.algorithm, expected.blob, entry.size)) === expected.digest;
}

/**
 * Deletes, bottom up, what an inspection found in the directory at `path` that this process set aside: each file or link
 * only while it still holds what was found, each directory only once empty, never following a link. Anything else is
 * kept, and so is every directory above it. Resolves to whether nothing is left.
 */
async function deleteRestoredContent(path: string, found: ReadonlyMap<string, RestoredEntry>): Promise<boolean> {
	const visit = async (dir: string, prefix: string): Promise<boolean> => {
		let emptied = true;
		for (const name of await readdir(dir)) {
			const absolute = join(dir, name);
			const relativeName = prefix === "" ? name : `${prefix}/${name}`;
			const entry = await lstat(absolute);
			if (entry.isDirectory()) {
				if (!(await visit(absolute, relativeName))) emptied = false;
				continue;
			}
			const expected = found.get(relativeName);
			if (expected === undefined || !(await stillRestored(absolute, expected))) {
				emptied = false;
				continue;
			}
			await writing(absolute, null, () => rm(absolute));
		}
		if (!emptied) return false;
		await writing(dir, null, () => rmdir(dir));
		return true;
	};
	return visit(path, "");
}

/** Where a restore sets its worktree aside to delete it: beside its staging path, `.d-` in place of `.s-`. */
function asidePath(record: RestoreRecord): string {
	const name = basename(record.staging);
	const aside = name.replace(/\.s-([0-9a-f]{12})$/, ".d-$1");
	return join(dirname(record.staging), aside === name ? `${name}.d` : aside);
}

/** A directory a restore moved aside under the store lock, with what an inspection found in it. */
interface SetAside {
	readonly path: string;
	readonly found: ReadonlyMap<string, RestoredEntry> | undefined;
}

/**
 * Under the store lock, moves this restore's worktree at `path` to its aside path (#4748). Only the directory the
 * restore created moves: one with the identity recorded when Git added it, or, for a record without one, one that holds
 * only what the restore put there. What it holds is inspected first; `found` is undefined when anything else is there,
 * so the directory is kept, aside, for the user. Resolves to undefined, moving nothing, when `path` holds no such
 * directory or something already is at the aside path.
 */
async function setRestoredAside(path: string, record: RestoreRecord): Promise<SetAside | undefined> {
	const identity = await directoryIdentity(path);
	if (identity === undefined) return undefined;
	const created = record.identity !== undefined && sameIdentity(identity, record.identity);
	// Only in the restore's own directory may a file be a checkout stopped while it wrote it.
	const found = await inspectRestoredContent(path, record.store, record.tree, created);
	if (!created && (record.identity !== undefined || found === undefined)) return undefined;
	const aside = asidePath(record);
	if ((await lstatIfPresent(aside)) !== undefined) return undefined;
	await writing(path, null, () => renameWithRetry(path, aside));
	return { path: aside, found };
}

/**
 * Deletes what this restore set aside, outside the store lock: the directory must still be the one set aside, and each
 * file still what was found in it. Throws, keeping it all, when it holds anything else.
 */
async function deleteSetAside(record: RestoreRecord, aside: SetAside): Promise<void> {
	const identity = await directoryIdentity(aside.path);
	const same = identity !== undefined && (record.identity === undefined || sameIdentity(identity, record.identity));
	if (!same || aside.found === undefined || !(await deleteRestoredContent(aside.path, aside.found))) {
		throw new WorkspaceRestoreError("unsafe-target", {
			snapshotId: null,
			target: aside.path,
			reason: "not-restored",
		});
	}
}

/**
 * Under the store lock: sets the restore's staging directory aside (see {@link setRestoredAside}), restores a previously
 * empty target if needed, and has Git forget the worktree. Resolves to what to delete once the lock is released: the
 * staging directory just set aside, or one an earlier cleanup set aside and did not finish deleting. A staging
 * directory this restore did not create is kept where it is and reported.
 */
async function cleanRestoreRecord(record: RestoreRecord, signal?: AbortSignal): Promise<SetAside[]> {
	const git: GitRunOptions = { cwd: dirname(record.store), env: { GIT_DIR: record.store }, signal };
	const pending: SetAside[] = [];
	const aside = asidePath(record);
	if ((await lstatIfPresent(aside)) !== undefined) {
		const identity = await directoryIdentity(aside);
		const own = identity !== undefined && record.identity !== undefined && sameIdentity(identity, record.identity);
		pending.push({ path: aside, found: await inspectRestoredContent(aside, record.store, record.tree, own) });
	}
	let entry: Stats | undefined;
	let registeredPath = record.staging;
	try {
		entry = await lstat(record.staging);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadablePathError(record.staging, error);
	}
	if (entry) {
		if (entry.isDirectory()) registeredPath = await physicalPath(record.staging);
		const setAside = pending.length === 0 ? await setRestoredAside(record.staging, record) : undefined;
		if (setAside === undefined) {
			throw new WorkspaceRestoreError("unsafe-target", {
				snapshotId: null,
				target: record.staging,
				reason: "not-restored",
			});
		}
		pending.push(setAside);
	}
	if (!record.createdTarget && (await statIfPresent(record.target)) === undefined) {
		await writing(record.target, null, () => mkdir(record.target, { recursive: true }));
	}
	// Git never prunes a locked worktree, as a killed `git worktree add` leaves one; unlocking touches no files.
	await runGit(["worktree", "unlock", record.staging], { ...git, allowExitCodes: [128] });
	await runGit(["worktree", "prune"], git);
	if (includesPath(await registeredWorktrees(git), registeredPath)) {
		throw new WorkspaceGitError({
			operation: "worktree prune",
			cwd: git.cwd,
			exitCode: null,
			detail: "the staging worktree is still registered",
		});
	}
	return pending;
}

/**
 * Cleans up after the restore of `record`: {@link cleanRestoreRecord} under the store lock, then the deletion of what it
 * set aside outside the lock. Throws, naming where the files are kept, when anything is kept.
 */
async function cleanUpRestore(
	record: RestoreRecord,
	snapshotId: string | null,
	signal: AbortSignal | undefined,
	underLock: () => Promise<SetAside[]> = () => cleanRestoreRecord(record, signal),
): Promise<void> {
	const pending = await withRepositoryLock(record.store, snapshotId, signal, underLock);
	for (const aside of pending) {
		await deleteSetAside(record, aside).catch((error: unknown) => {
			if (error instanceof Error) Object.defineProperty(error, "keptAt", { value: aside.path, configurable: true });
			throw error;
		});
	}
}

/** Where a failed cleanup kept the restore's files: the directory its refusal names, else where they were. */
function keptPath(cause: unknown, record: RestoreRecord, moved: boolean): string {
	const keptAt = (cause as { keptAt?: unknown } | undefined)?.keptAt;
	if (typeof keptAt === "string") return keptAt;
	if (isWorkspaceRestoreError(cause) && cause.code === "unsafe-target" && cause.target !== undefined)
		return cause.target;
	return moved ? record.target : record.staging;
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
			release = await lockShared(recordPath, {
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
			await cleanUpRestore(record, null, signal).catch((cause: unknown) => {
				warningPath = keptPath(cause, record, false);
				throw cause;
			});
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

/**
 * Where the restore's worktree may be once it asked Git to move it to its target: `unchecked` until the check after the
 * move found it there (`published`), or found it nested in a directory that appeared at the target and dealt with that.
 */
type MoveState = "none" | "unchecked" | "published" | "nested" | "checked";

/**
 * Under the store lock, cleanup after a restore that failed or was stopped once it asked Git to move its worktree toward
 * the target (#4748): the worktree, at the target or nested in a directory that appeared there, is set aside like its
 * staging directory (see {@link setRestoredAside}), then {@link cleanRestoreRecord} runs. Only the restore that moved it
 * does this; the crash sweep never does, so a record that a successful restore could not remove never costs the
 * worktree it published.
 */
async function cleanMovedRestore(record: RestoreRecord, state: MoveState): Promise<SetAside[]> {
	const git: GitRunOptions = { cwd: dirname(record.store), env: { GIT_DIR: record.store } };
	const pending: SetAside[] = [];
	const nested = join(record.target, basename(record.staging));
	const candidates = state === "unchecked" ? [record.target, nested] : state === "nested" ? [nested] : [record.target];
	for (const candidate of candidates) {
		if (pending.length > 0) break;
		const setAside = await setRestoredAside(candidate, record);
		if (setAside !== undefined) pending.push(setAside);
	}
	if (pending.length === 0) {
		// A worktree of this restore, or one Git registered where it moved it, that could not be set aside is kept and
		// reported, with its crash record, never left behind silently.
		const registered = await registeredWorktrees(git);
		for (const candidate of candidates) {
			const identity = await directoryIdentity(candidate);
			if (identity === undefined) continue;
			const own = record.identity !== undefined && sameIdentity(identity, record.identity);
			if (own || includesPath(registered, await physicalPath(candidate))) {
				throw new WorkspaceRestoreError("unsafe-target", {
					snapshotId: null,
					target: candidate,
					reason: "not-restored",
				});
			}
		}
	}
	const staged = await cleanRestoreRecord(record);
	return [...pending, ...staged.filter((aside) => !pending.some((moved) => moved.path === aside.path))];
}

/**
 * Hold a crash record lock throughout staging and publication; preserve the primary failure if cleanup fails. The
 * action calls `published` once it has moved its worktree to the target, so a failure after that removes it too.
 */
async function withRestoreRecord(
	storeDir: string,
	id: string,
	record: RestoreRecord,
	snapshotId: string | null,
	warn: (warning: WorktreeRestoreWarning) => void,
	signal: AbortSignal | undefined,
	action: (
		assertActive: () => void,
		moving: (state: MoveState) => void,
		created: (identity: DirectoryIdentity) => Promise<void>,
	) => Promise<void>,
): Promise<void> {
	const recordsDir = join(storeDir, "restores");
	const recordPath = join(recordsDir, `${id}.json`);
	await writing(recordsDir, snapshotId, () => mkdir(recordsDir, { recursive: true }));
	let compromised: Error | undefined;
	const release = await writing(recordPath, snapshotId, () =>
		lockShared(recordPath, {
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
	let moveState = "none" as MoveState;
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
		await action(
			assertActive,
			(state) => {
				moveState = state;
			},
			async (identity) => {
				record = { ...record, identity };
				const written = `${recordPath}.${process.pid}.tmp`;
				await writing(recordPath, snapshotId, async () => {
					await writeFile(written, JSON.stringify(record), { mode: 0o600 });
					await renameWithRetry(written, recordPath);
				});
			},
		);
		assertActive();
		try {
			await rm(recordPath);
		} catch {
			warn({ code: "stale-restore-retained", path: record.staging, kind: "worktree" });
		}
	} catch (error) {
		primary = error;
		if (recorded) {
			const moved = moveState === "unchecked" || moveState === "published" || moveState === "nested";
			try {
				await cleanUpRestore(record, snapshotId, undefined, () =>
					moved ? cleanMovedRestore(record, moveState) : cleanRestoreRecord(record),
				);
				await rm(recordPath);
			} catch (cleanupCause) {
				if (error instanceof Error)
					Object.defineProperty(error, "cleanupCause", { value: cleanupCause, configurable: true });
				warn({ code: "stale-restore-retained", path: keptPath(cleanupCause, record, moved), kind: "worktree" });
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

/**
 * The object store, under `storeDir`, of the checkout at `root` whose remotes are `remotes`. Checkouts of one
 * repository share it: it is named after the normalized remotes (#4748), relative paths resolved against `root`, so
 * SSH and HTTPS checkouts of one repository share it, or after the remotes as spelled when only a store an earlier
 * version created that way exists. A checkout whose remotes name no one repository, as one without remotes, has a
 * store of its own (#4989). Undefined when that checkout's `root` is unknown: its store cannot be told apart from
 * another repository's.
 */
export function objectStorePath(storeDir: string, remotes: readonly string[], root?: string): string | undefined {
	const [current, legacy] = sharedRepositoryIdsOf(remotes, root);
	const named = (repository: string) => join(storeDir, "repositories", `${repository}.git`);
	if (current === undefined) {
		return root === undefined || !isAbsolute(root) ? undefined : named(checkoutStoreIdOf(root));
	}
	if (legacy === undefined) return named(current);
	return existsSync(named(current)) || !existsSync(named(legacy)) ? named(current) : named(legacy);
}

async function objectStorePathAsync(
	storeDir: string,
	remotes: readonly string[],
	root?: string,
): Promise<string | undefined> {
	const [current, legacy] = sharedRepositoryIdsOf(remotes, root);
	const named = (repository: string) => join(storeDir, "repositories", `${repository}.git`);
	if (current === undefined) {
		return root === undefined || !isAbsolute(root) ? undefined : named(checkoutStoreIdOf(root));
	}
	if (legacy === undefined) return named(current);
	return (await pathExists(named(current))) || !(await pathExists(named(legacy))) ? named(current) : named(legacy);
}

/**
 * {@link objectStorePath} of the checkout a restore of `target` restores, its snapshot's when known; rejects with
 * `commits-unavailable` when it has none, as for a binding of a checkout without remotes and no snapshot: no store can
 * be its repository's (#4989).
 */
async function restoreStorePath(
	storeDir: string,
	target: { readonly remotes: readonly string[]; readonly head: string },
	checkout: { readonly id: string | null; readonly root: string | undefined },
): Promise<string> {
	const store = await objectStorePathAsync(storeDir, target.remotes, checkout.root);
	if (store !== undefined) return store;
	throw new WorkspaceRestoreError("commits-unavailable", {
		snapshotId: checkout.id,
		head: target.head,
		commits: [target.head],
		remotes: [...target.remotes],
		reason: "not-fetched",
	});
}

/**
 * Puts the commit `head` of the local checkout at `checkout` into the shared object store of the repository `remotes`
 * name (#4748), so a restore of it fetches nothing from a remote: a CI job's checkout keeps its credentials to itself.
 * A shallow checkout leaves the store shallow, as a depth-1 restore fetch does.
 */
export async function storeCheckoutHead(
	storeDir: string,
	remotes: readonly string[],
	checkout: string,
	head: string,
	signal?: AbortSignal,
): Promise<void> {
	const store = await restoreStorePath(resolve(storeDir), { remotes, head }, { id: null, root: checkout });
	const git: GitRunOptions = { cwd: checkout, signal, env: { GIT_DIR: store } };
	await withRepositoryLock(store, null, signal, async () => {
		await ensureObjectStore(store, signal);
		if (!(await hasObject(git, `${head}^{commit}`))) await runFetch(git, checkout, [head], ["--update-shallow"]);
	});
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
 * Creates `store` unless it already has its configuration and HEAD. Callers hold its repository lock, so no two
 * restores, in this process or others, initialize one store at once (#4951), and an existing store is left alone:
 * re-initializing rewrites its configuration, which on Windows fails the other restores' Git processes that are
 * reading it. The store is initialized beside its place and renamed into it, so a process stopped midway leaves no
 * half-made store; a directory already there that is not one, as an older build may have left, is initialized in place.
 */
async function ensureObjectStore(store: string, signal?: AbortSignal): Promise<void> {
	if (await initializedStore(store)) return enableLongPaths(store, signal);
	const repositories = dirname(store);
	const fresh = join(repositories, `.${basename(store)}.${process.pid}.init`);
	try {
		await runGit(["init", "-q", "--bare", fresh], { cwd: repositories, signal });
		await enableLongPaths(fresh, signal);
		try {
			await renameWithRetry(fresh, store, { signal });
		} catch {
			await runGit(["init", "-q", "--bare", store], { cwd: repositories, signal });
		}
	} finally {
		await rm(fresh, { recursive: true, force: true });
	}
}

/**
 * On Windows, turns on `core.longpaths` in `store`'s configuration, which its worktrees share, so Git run in a restored
 * worktree by the user or an agent handles that worktree's files past 260 characters as Atomic's own Git does (#5139).
 * A store that has it is left alone, so its configuration is rewritten at most once; a failure to write it costs only
 * that, since Atomic's own Git commands set it on their command lines. Run only under the store's repository lock.
 */
async function enableLongPaths(store: string, signal?: AbortSignal): Promise<void> {
	if (process.platform !== "win32") return;
	const config = join(store, "config");
	const git: GitRunOptions = { cwd: store, signal, allowExitCodes: [1] };
	const current = await runGit(["config", "--file", config, "--type=bool", "--get", "core.longpaths"], git);
	if (current.stdout.toString("utf8").trim() === "true") return;
	await runGit(["config", "--file", config, "core.longpaths", "true"], git).catch(() => signal?.throwIfAborted());
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

/**
 * `git fetch` of `refspecs` from `repository`, with `options` such as `--depth=1`; the `--` keeps a recorded value from
 * ever being read as an option.
 */
function fetchArgs(repository: string, refspecs: readonly string[], options: readonly string[]): string[] {
	return [
		...FETCH_TRANSPORTS,
		"fetch",
		"-q",
		"--no-tags",
		"--no-write-fetch-head",
		...options,
		"--",
		repository,
		...refspecs,
	];
}

/** Runs {@link fetchArgs} through the runner without a way to prompt, so an unreachable or unknown host fails at once. */
function runFetch(
	git: GitRunOptions,
	repository: string,
	refspecs: readonly string[],
	options: readonly string[] = [],
): Promise<GitRunResult> {
	return runGit(fetchArgs(repository, refspecs, options), { ...git, nonInteractive: true });
}

/** The options of a fetch that brings whole history: `--unshallow` once a depth-1 fetch left the store shallow. */
async function historyFetchOptions(git: GitRunOptions): Promise<string[]> {
	return (await gitText(["rev-parse", "--is-shallow-repository"], git)) === "true" ? ["--unshallow"] : [];
}

/** Fetch failures that do not depend on the depth: the remote cannot be reached, or does not have the commits. */
const FULL_FETCH_FAILS_TOO =
	/could not read from remote repository|unable to access|could not resolve|does not appear to be a git repository|^ssh:|not our ref|couldn't find remote ref|unadvertised object/i;

interface RemoteFetch {
	/** The last fetch failure, when a remote could not supply what was still missing. */
	readonly failure: Error | undefined;
	/** Whether a recorded remote's fetch of the missing commits succeeded, so that remote has every one of them. */
	readonly supplied: boolean;
}

/**
 * Fetches the `commits` the store lacks from the first of `remotes` that has them, with their history; with
 * `depthFirst`, each remote is first asked for the commits alone (`--depth=1`, #4748), and asked again for their
 * history only when that fails for a reason other than an unreachable remote or missing commits.
 */
async function fetchCommits(
	git: GitRunOptions,
	remotes: readonly string[],
	commits: readonly string[],
	depthFirst = false,
	knownMissing?: readonly string[],
): Promise<RemoteFetch> {
	let failure: Error | undefined;
	let supplied = false;
	// The caller's own check of the store, made just before, answers the first remote's question.
	let checked = knownMissing;
	for (const remote of remotes) {
		const missing = checked ?? (await missingCommits(git, commits));
		checked = undefined;
		if (missing.length === 0) return { failure: undefined, supplied };
		if (depthFirst) {
			try {
				await runFetch(git, remote, missing, ["--depth=1"]);
				supplied = true;
				noteRestoreFetch("shallow");
				continue;
			} catch (error) {
				if (!isWorkspaceGitError(error)) throw error;
				// A remote or Git that refuses a depth-1 fetch gets today's full fetch; one that is unreachable or lacks the
				// commits would fail it the same way, so it is not asked twice.
				if (FULL_FETCH_FAILS_TOO.test(error.detail)) {
					failure = error;
					continue;
				}
			}
		}
		try {
			await runFetch(git, remote, missing, await historyFetchOptions(git));
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
 * Fetches the whole history of a store a depth-1 fetch left shallow, with `commits`, from the first of `remotes` that
 * supplies it, so an ancestry check across the boundary is answered (#4748). Resolves whether one did; Git refuses at
 * once, without contacting a remote, for a store that holds its whole history.
 */
async function unshallowStore(
	git: GitRunOptions,
	remotes: readonly string[],
	commits: readonly string[],
): Promise<boolean> {
	for (const remote of remotes) {
		try {
			await runFetch(git, remote, commits, ["--unshallow"]);
			return true;
		} catch (error) {
			if (!isWorkspaceGitError(error)) throw error;
		}
	}
	return false;
}

/** The shared object store a restored worktree's Git directory names: Atomic's own, never a user's repository. */
/** What Git before 2.31, which has no `--path-format`, prints first when asked for it: the option itself. */
const PATH_FORMAT_ABSOLUTE = "--path-format=absolute";

/**
 * The common Git directory of the checkout at `git.cwd` as `git rev-parse --path-format=absolute --git-common-dir`
 * prints it, through any symlink, and its exit code, one of `allowExitCodes` (128 outside a repository; any other code
 * rejects as {@link runGit} does). Git before 2.31 prints the option back
 * and exits with 0, then the directory relative to the working directory, which Git is asked to resolve as it resolves
 * an absolute one.
 */
async function absoluteCommonDir(
	git: GitRunOptions,
	allowExitCodes: readonly number[] = [128],
): Promise<{ readonly exitCode: number; readonly path: string }> {
	const asked = await runGit(["rev-parse", PATH_FORMAT_ABSOLUTE, "--git-common-dir"], { ...git, allowExitCodes });
	const [first = "", named = ""] = asked.stdout.toString("utf8").trim().split("\n");
	if (asked.exitCode !== 0 || first !== PATH_FORMAT_ABSOLUTE) return { exitCode: asked.exitCode, path: first };
	const real = await runGit(["rev-parse", "--absolute-git-dir"], {
		...git,
		env: { ...git.env, GIT_DIR: resolve(git.cwd, named) },
		allowExitCodes,
	});
	return { exitCode: real.exitCode, path: real.stdout.toString("utf8").trim() };
}

const SHARED_STORE = /[\\/]repositories[\\/][0-9a-f]{24}\.git$/;

/**
 * Fetches the whole history of the shared object store behind the restored worktree at `root` from its recorded
 * remotes, when a depth-1 restore left that store shallow, so ancestry across the boundary is answered (#4748).
 * Resolves whether it did; a checkout that is not a restored worktree, or a failed fetch, is left as it is.
 */
export async function unshallowRestoredWorktree(
	root: string,
	commits: readonly string[],
	signal?: AbortSignal,
): Promise<boolean> {
	const common = await absoluteCommonDir({ cwd: root, signal });
	const store = common.path;
	if (common.exitCode !== 0 || !SHARED_STORE.test(store)) return false;
	const git: GitRunOptions = { cwd: dirname(store), signal, env: { GIT_DIR: store } };
	// Sibling worktrees of one store are compared at once: one fetches its history, the others find it complete.
	return withRepositoryLock(store, null, signal, async () =>
		(await historyFetchOptions(git)).length === 0
			? true
			: unshallowStore(git, await configuredRemoteUrls(git), commits),
	);
}

/**
 * Makes `snapshot.head` available in the store, from the recorded remotes or else its bundle, and resolves whether
 * it came from a recorded remote. A remote's fetch of `head` alone is tried first, at depth 1 (#4748); a bundle's
 * prerequisites are fetched with their history, as its import needs.
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
		const fromRemotes = await fetchCommits(git, snapshot.remotes, [head], true, [head]);
		let failure = fromRemotes.failure;
		fetched = fromRemotes.supplied;
		let present = await hasObject(git, `${head}^{commit}`);
		if (!present && snapshot.bundle) {
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
			present = await hasObject(git, `${head}^{commit}`);
		}
		if (!present) {
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
 * recorded ones, however each is spelled. A store without recorded remotes, or with a remote that is not credential-free or not of a scheme a
 * restore fetches over, is left without any, as before.
 */
async function configureRecordedRemotes(git: GitRunOptions, remotes: readonly string[]): Promise<boolean> {
	if (remotes.length === 0 || !remotes.every(isAllowedRemote)) return false;
	let configured = await configuredRemoteUrls(git);
	// A store holding the start of the recorded list was set up by a restore that stopped partway; finish it.
	if (configured.length < remotes.length && configured.every((remote, index) => sameRemote(remote, remotes[index]!))) {
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
	return (
		configured.length === remotes.length && configured.every((remote, index) => sameRemote(remote, remotes[index]!))
	);
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

/**
 * The file in a restored worktree's own Git directory that says its LFS download has not completed (#5099): written
 * before a worktree whose download is deferred is published, removed once every LFS file has its content, so a resume
 * interrupted during the download leaves the next one a way to finish it.
 */
const LFS_PENDING_FILE = "atomic-lfs-pending.json";

interface PendingLfs {
	readonly head: string;
	readonly tree: string;
	readonly remotes: readonly string[];
	/** The process downloading, while one is: its Git steps may leave locks behind if it is killed. */
	readonly holder?: ProcessHolder;
}

/**
 * How long a download whose process cannot be told from a later one given its id, where its start cannot be read,
 * counts as running: past this its locks are its leftovers.
 */
const UNSTARTED_LFS_HOLDER_LIMIT_MS = 24 * 60 * 60_000;

/** The marks of the worktrees this process is downloading into now. */
const pullingHere = new Set<string>();

/** `name` in the worktree's own Git directory. */
async function worktreeGitPath(worktree: GitRunOptions, name: string): Promise<string> {
	const [first = "", named = ""] = (
		await gitText(["rev-parse", "--path-format=absolute", "--git-path", name], worktree)
	).split("\n");
	if (first !== PATH_FORMAT_ABSOLUTE) return resolve(worktree.cwd, first);
	// Git before 2.31 printed the option back, then the path relative to the working directory: resolve it as Git
	// resolves an absolute one, through any symlink, the file itself perhaps not there yet.
	const path = resolve(worktree.cwd, named);
	try {
		return await realpath(path);
	} catch {
		return join(await realpath(dirname(path)), basename(path));
	}
}

function pendingLfsPath(worktree: GitRunOptions): Promise<string> {
	return worktreeGitPath(worktree, LFS_PENDING_FILE);
}

async function markLfsPending(worktree: GitRunOptions, pending: PendingLfs, snapshotId: string | null): Promise<void> {
	const marker = await pendingLfsPath(worktree);
	await writing(marker, snapshotId, () => writeFile(marker, JSON.stringify(pending)));
}

/**
 * Replaces the mark of a worktree that other processes may read at once: written beside it and renamed over it, so a
 * reader finds the old mark or the new one, never one a write has truncated, which reads as unusable and is removed.
 */
async function rewritePendingMark(marker: string, pending: PendingLfs): Promise<void> {
	const partial = `${marker}.${randomUUID()}.partial`;
	try {
		await writeFile(partial, JSON.stringify(pending));
		await renameWithRetry(partial, marker);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
}

/** {@link pullLfsObjects} into a worktree marked pending, clearing the mark once no LFS file holds a pointer. */
async function pullPendingLfs(worktree: GitRunOptions, pending: PendingLfs): Promise<string[]> {
	const marker = await pendingLfsPath(worktree);
	const waiting: PendingLfs = { head: pending.head, tree: pending.tree, remotes: pending.remotes };
	pullingHere.add(marker);
	try {
		await rewritePendingMark(marker, { ...waiting, holder: await thisProcess() });
		const pointers = await pullLfsObjects(worktree, pending.head, pending.tree, pending.remotes);
		if (pointers.length === 0) await rm(marker, { force: true });
		else await rewritePendingMark(marker, waiting);
		return pointers;
	} finally {
		pullingHere.delete(marker);
	}
}

/**
 * Whether the download that `pending` names is still running, in this process or another, so nothing of it may be
 * touched. A download whose process is gone may have left `HEAD.lock` or `index.lock` behind.
 */
async function lfsHolderRuns(marker: string, pending: PendingLfs): Promise<boolean> {
	if (pullingHere.has(marker)) return true;
	const holder = pending.holder;
	if (holder === undefined) return false;
	// This process, when it is not downloading into the worktree, stopped the download that names it.
	if (holder.host === HOST && holder.pid === process.pid) return false;
	try {
		const age = Date.now() - (await stat(marker)).mtimeMs;
		return await holderRuns(holder, age, UNSTARTED_LFS_HOLDER_LIMIT_MS);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

function isPendingLfs(value: unknown): value is PendingLfs {
	const pending = value as Partial<PendingLfs> | null;
	return (
		typeof pending?.head === "string" &&
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pending.head) &&
		typeof pending.tree === "string" &&
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pending.tree) &&
		Array.isArray(pending.remotes) &&
		pending.remotes.every((remote) => typeof remote === "string" && isAllowedRemote(remote)) &&
		(pending.holder === undefined ||
			(typeof pending.holder?.host === "string" &&
				Number.isSafeInteger(pending.holder.pid) &&
				(pending.holder.start === undefined || typeof pending.holder.start === "string")))
	);
}

/** How long a resume waits for another running process to finish a download it holds before it warns (#5099). */
export const LFS_HOLDER_WAIT_MS = 10 * 60_000;
/** How often a resume waiting for another process's download checks on it. */
const LFS_HOLDER_POLL_MS = 250;

/**
 * The Git LFS download left unfinished in the restored worktree at `worktree` (#5099), by a resume that was interrupted
 * or by another Atomic process still running it, or undefined when none is pending. The returned function finishes it
 * and resolves to the files that still hold pointers, as a restore's download does: it waits for a running process to
 * end its download, at most {@link LFS_HOLDER_WAIT_MS}, and takes over from one that stopped. A worktree whose `HEAD`
 * moved since its restore, or whose mark cannot be read, is not changed: the function then rejects, saying to run
 * `git lfs pull` there, and the mark is removed so this is said once.
 */
export async function pendingLfsDownload(
	worktree: string,
	options: { readonly signal?: AbortSignal } = {},
): Promise<(() => Promise<readonly string[]>) | undefined> {
	const git: GitRunOptions = { cwd: worktree, signal: options.signal };
	const marker = await pendingLfsPath(git);
	if ((await readPendingMark(marker)) === undefined) return undefined;
	return () => finishPendingLfs(git, marker);
}

async function readPendingMark(marker: string): Promise<string | undefined> {
	try {
		return await readFile(marker, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function finishPendingLfs(git: GitRunOptions, marker: string): Promise<string[]> {
	const waitingSince = Date.now();
	for (;;) {
		const text = await readPendingMark(marker);
		// Its process finished the download: every LFS file has its content.
		if (text === undefined) return [];
		const pending = parsePendingLfs(text);
		if (pending === undefined || !(await lfsHolderRuns(marker, pending))) {
			const claim = await claimPendingLfs(git, marker);
			if (claim.kind === "finished") return [];
			if (claim.kind === "claimed") {
				try {
					return await takeOverPendingLfs(git, marker, claim.pending);
				} finally {
					pullingHere.delete(marker);
				}
			}
		}
		if (Date.now() - waitingSince >= LFS_HOLDER_WAIT_MS) return remainingPointers(git.cwd, await lfsPaths(git));
		await sleep(LFS_HOLDER_POLL_MS, undefined, { signal: git.signal });
	}
}

/** How a {@link claimPendingLfs} went: the download is done, another process runs it, or this process now holds it. */
type LfsClaim =
	| { readonly kind: "finished" }
	| { readonly kind: "running" }
	| { readonly kind: "claimed"; readonly pending: PendingLfs | undefined };

/**
 * Makes this process the holder of the download pending in the worktree, when its process stopped or it names none,
 * one process at a time: under the takeover mutex of its mark, an advisory lock the kernel releases when its holder
 * dies (#5193), the mark is read again, the locks a stopped download's Git steps left are removed, and the mark names
 * this process before the mutex is released. Another process that judged the same download stopped then finds this
 * one running it and waits, rather than removing the locks this one's Git holds, or downloading beside it.
 */
async function claimPendingLfs(git: GitRunOptions, marker: string): Promise<LfsClaim> {
	const locks = await Promise.all(["HEAD.lock", "index.lock"].map((name) => worktreeGitPath(git, name)));
	const mutex = await takeTakeoverMutexAsync(marker, 0);
	if (mutex === undefined) return { kind: "running" };
	try {
		const text = await readPendingMark(marker);
		if (text === undefined) return { kind: "finished" };
		const pending = parsePendingLfs(text);
		if ((pending !== undefined && (await lfsHolderRuns(marker, pending))) || !(await mutex.owned()))
			return { kind: "running" };
		// A download killed during its Git steps leaves their locks; nothing else takes them in a worktree with a mark.
		if (pending?.holder !== undefined) for (const lock of locks) await rm(lock, { force: true });
		if (pending !== undefined) {
			const { head, tree, remotes } = pending;
			await rewritePendingMark(marker, { head, tree, remotes, holder: await thisProcess() });
			pullingHere.add(marker);
		}
		return { kind: "claimed", pending };
	} finally {
		await mutex.release();
	}
}

/** Finishes the download pending in the worktree once this process holds it ({@link claimPendingLfs}). */
async function takeOverPendingLfs(
	git: GitRunOptions,
	marker: string,
	pending: PendingLfs | undefined,
): Promise<string[]> {
	const head = await gitText(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { ...git, allowExitCodes: [1] });
	// A download cut off mid-pull leaves HEAD at the snapshot's commit, which it names while it runs.
	if (
		pending !== undefined &&
		(head === pending.head || head === (await writeSnapshotCommit(git, pending.head, pending.tree)))
	) {
		return pullPendingLfs(git, pending);
	}
	await rm(marker, { force: true });
	throw new Error(
		"its LFS download was interrupted and the worktree changed since, so it was not repeated; run `git lfs pull` in it",
	);
}

function parsePendingLfs(text: string): PendingLfs | undefined {
	try {
		const pending: unknown = JSON.parse(text);
		return isPendingLfs(pending) ? pending : undefined;
	} catch {
		return undefined;
	}
}

async function materialize(
	git: GitRunOptions,
	store: string,
	target: string,
	head: string,
	tree: string,
	scratch: string,
	snapshotId: string | null,
	created: (identity: DirectoryIdentity) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	await withRepositoryLock(store, snapshotId, signal, async () => {
		// Git adds a worktree into an empty directory too: only one it creates itself is the restore's.
		if ((await lstatIfPresent(target)) !== undefined) {
			throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target, reason: "not-empty" });
		}
		await runGit(["worktree", "add", "-q", "--detach", "--no-checkout", target, head], git);
		const identity = await directoryIdentity(target);
		if (identity !== undefined) await created(identity);
	});
	const attributes = join(scratch, "empty-attributes");
	await writing(attributes, snapshotId, () => writeFile(attributes, ""));
	const neutral: GitRunOptions = { cwd: target, signal, neutral: true, env: { GIT_LFS_SKIP_SMUDGE: "1" } };
	await runGit(["-c", `core.attributesFile=${attributes}`, "read-tree", "--reset", "-u", tree], neutral);
	await runGit(["read-tree", head], neutral);
	await runGit(["update-index", "-q", "--refresh"], { ...neutral, allowExitCodes: [1] });
	await recordRestoredTree(neutral, tree);
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
	options: Omit<RestoreWorktreeSnapshotOptions, "into"> & {
		/** The root of the checkout a binding was recorded in, which its relative-path remotes are relative to (#4989). */
		readonly root?: string;
	} = {},
): Promise<RestoredWorktree> {
	if (!isBinding(target)) {
		throw new WorkspaceConfigError("sdk", "target", "a WorkspaceBinding or a WorktreeSnapshot");
	}
	return withWorktreeSnapshotGit(options.git, () => restoreValidated(target, options, slot, options.root));
}

async function restoreValidated(
	target: WorkspaceBinding,
	options: RestoreWorktreeSnapshotOptions,
	slot: string | undefined,
	root?: string,
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
	const patches = await snapshotPatches(snapshot, options.blobs);
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
	await checkPathBudget(
		storeDir,
		() => restoreStorePath(storeDir, target, snapshot ?? { id: null, root }),
		path,
		options.into,
		snapshotId,
	);
	await sweepRestoreRecords(storeDir, warn, signal);
	return withScratchDirectory(async (scratch) => {
		const store = await restoreStorePath(storeDir, target, snapshot ?? { id: null, root });
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		await storeSnapshotObjects(git, store, target, snapshot, patches, options.blobs, scratch);
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
			// The download runs later, with the Git this restore runs.
			deferLfs:
				options.deferLfs &&
				((worktree, pull) => options.deferLfs!(worktree, () => withWorktreeSnapshotGit(options.git, pull))),
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

/**
 * Makes `target`'s commit and tree objects of the shared store `store`, which `git` points at: fetches or unbundles the
 * commit when the store lacks it, keeps it and the commits known to be pushed referenced, and rebuilds the tree from
 * the snapshot's change sets when the store lacks it too.
 */
async function storeSnapshotObjects(
	git: GitRunOptions,
	store: string,
	target: WorkspaceBinding,
	snapshot: WorktreeSnapshot | null,
	patches: readonly (Uint8Array | null)[],
	blobs: SnapshotBlobStore | undefined,
	scratch: string,
): Promise<void> {
	await withRepositoryLock(store, snapshot?.id ?? null, git.signal, async () => {
		await ensureObjectStore(store, git.signal);
		const fetched = await timeRestorePhase("fetch", () =>
			ensureHead(
				git,
				snapshot ?? { id: null, head: target.head, remotes: target.remotes, bundle: null, omitted: [] },
				blobs,
				scratch,
			),
		);
		// What a snapshot of other remotes, such as a fork at the same commit, says is pushed is not this store's.
		const sameRemotes =
			snapshot === null ||
			(snapshot.remotes.length === target.remotes.length &&
				snapshot.remotes.every((remote, index) => sameRemote(remote, target.remotes[index]!)));
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
}

/** The change sets of `snapshot`'s chain, each checked against its recorded hash; null for a link without one. */
function snapshotPatches(
	snapshot: WorktreeSnapshot | null,
	blobs: SnapshotBlobStore | undefined,
): Promise<(Uint8Array | null)[]> {
	if (!snapshot) return Promise.resolve([]);
	return Promise.all(
		snapshot.chain.map((link, deltaIndex) =>
			link.patch === null
				? null
				: loadBlob(blobs, link.patch, { snapshotId: snapshot.id, role: "patch", deltaIndex }),
		),
	);
}

/**
 * Makes `snapshot`'s commit and tree objects of this host's shared object store for its repository, as a restore does,
 * without writing a worktree, and resolves with the store's path (#4922). Rejects with the restore's typed failures,
 * such as `blob-missing` or `commits-unavailable`, and `invalid-snapshot` for a record that fails the security checks.
 */
export async function storeSnapshotTree(
	snapshot: WorktreeSnapshot,
	options: Pick<RestoreWorktreeSnapshotOptions, "blobs" | "storeDir" | "signal">,
): Promise<string> {
	const binding: WorkspaceBinding = { ...snapshot, remotes: [...snapshot.remotes] };
	assertUsableSnapshotRecord(binding, snapshot);
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const patches = await snapshotPatches(snapshot, options.blobs);
	return withScratchDirectory(async (scratch) => {
		const store = await restoreStorePath(storeDir, snapshot, snapshot);
		const git: GitRunOptions = { cwd: scratch, signal: options.signal, env: { GIT_DIR: store } };
		await storeSnapshotObjects(git, store, binding, snapshot, patches, options.blobs, scratch);
		return store;
	});
}

export interface ResetPooledWorktreeOptions {
	readonly storeDir: string;
	readonly blobs?: SnapshotBlobStore;
	readonly signal?: AbortSignal;
	/** Runs once the snapshot's objects are in the store, right before the first write to the worktree. */
	readonly beforeReset: () => Promise<void>;
}

/**
 * Resets the existing pooled worktree at `slot`, whose files are exactly the recorded tree `from`, to `snapshot`
 * (#4748): files `from` holds and the snapshot does not are removed, the snapshot's are written where they differ, and
 * HEAD and the index name the snapshot's commit. Files Git ignores, such as dependencies and build output, stay;
 * unchanged files keep their timestamps. Resolves to the restore's warnings once HEAD and the recomputed tree match
 * the snapshot; rejects with `tree-mismatch` when they do not. A failure before `beforeReset` ran left the worktree
 * untouched. Only the pool's claim calls this: it is the one way an existing worktree is rewritten.
 */
export async function resetPooledWorktree(
	snapshot: WorktreeSnapshot,
	slot: string,
	from: { readonly tree: string },
	options: ResetPooledWorktreeOptions,
): Promise<WorktreeRestoreWarning[]> {
	const { signal } = options;
	const binding: WorkspaceBinding = {
		remotes: [...snapshot.remotes],
		head: snapshot.head,
		tree: snapshot.tree,
		envHash: snapshot.envHash,
	};
	assertUsableSnapshotRecord(binding, snapshot);
	const patches = await snapshotPatches(snapshot, options.blobs);
	// The slot's own store: one an earlier version named after the remotes as spelled stays the slot's (#4748).
	const store = await pooledWorktreeStore(options.storeDir, slot, signal);
	return withScratchDirectory(async (scratch) => {
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		await storeSnapshotObjects(git, store, binding, snapshot, patches, options.blobs, scratch);
		await options.beforeReset();
		// A download an interrupted resume left pending is the reset's to finish, or to leave pending again.
		await rm(await pendingLfsPath({ cwd: slot, signal }), { force: true });
		await timeRestorePhase("materialize", async () => {
			const attributes = join(scratch, "empty-attributes");
			await writing(attributes, snapshot.id, () => writeFile(attributes, ""));
			const neutral: GitRunOptions = { cwd: slot, signal, neutral: true, env: { GIT_LFS_SKIP_SMUDGE: "1" } };
			// The index takes `from` first, keeping the timestamps of the entries it already had, so the reset below
			// removes the files `from` holds beyond HEAD as well, and writes only what differs.
			await runGit(["read-tree", "--reset", from.tree], neutral);
			await runGit(["update-index", "-q", "--refresh"], { ...neutral, allowExitCodes: [1] });
			await runGit(
				["-c", `core.attributesFile=${attributes}`, "read-tree", "--reset", "-u", snapshot.tree],
				neutral,
			);
			await runGit(["update-ref", "--no-deref", "HEAD", snapshot.head], neutral);
			await runGit(["read-tree", "--reset", snapshot.head], neutral);
			await runGit(["update-index", "-q", "--refresh"], { ...neutral, allowExitCodes: [1] });
			await recordRestoredTree(neutral, snapshot.tree);
		});
		const warnings = snapshotRestoreWarnings(snapshot);
		if (snapshot.filters?.drivers.includes("lfs")) {
			const worktree: GitRunOptions = { cwd: slot, signal };
			const pending: PendingLfs = { head: snapshot.head, tree: snapshot.tree, remotes: snapshot.remotes };
			const pointers = await timeRestorePhase("lfs", () => pullPendingLfs(worktree, pending));
			if (pointers.length > 0) warnings.unshift({ code: "lfs-objects-unavailable", paths: pointers });
		}
		await timeRestorePhase("verify", () =>
			verifyRestoredTree(slot, slot, snapshot.head, snapshot.tree, "tree", scratch, snapshot.id, signal),
		);
		return warnings;
	});
}

/**
 * The shared object store under `storeDir` that the restored worktree at `worktree` belongs to; rejects with
 * `unsafe-target` when it belongs to none.
 */
export async function pooledWorktreeStore(
	storeDir: string,
	worktree: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const store = resolve((await absoluteCommonDir({ cwd: worktree, signal }, [])).path);
	if (
		(await canonicalizeWorktreePathAsync(dirname(store))) !==
		(await canonicalizeWorktreePathAsync(join(storeDir, "repositories")))
	) {
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target: worktree, reason: "not-restored" });
	}
	return store;
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
	await checkPathBudget(storeDir, () => restoreStorePath(storeDir, snapshot, snapshot), path, undefined, snapshot.id);
	await sweepRestoreRecords(storeDir, warn, signal);
	return withScratchDirectory(async (scratch) => {
		const store = await restoreStorePath(storeDir, snapshot, snapshot);
		const git: GitRunOptions = { cwd: scratch, signal, env: { GIT_DIR: store } };
		const cause = {
			cause: failure.code,
			...(failure.reason ? { causeReason: failure.reason } : {}),
			hint: failure.hint,
		};
		const degraded = await withRepositoryLock(
			store,
			snapshot.id,
			signal,
			async (): Promise<WorktreeDegradedRestore> => {
				await ensureObjectStore(store, signal);
				const configured = await configureRecordedRemotes(git, snapshot.remotes);
				// The exact restore may have stopped before it reached the recorded commit: fetch it, or take it from the bundle.
				const reached = await timeRestorePhase("fetch", () =>
					ensureHead(git, snapshot, options.blobs, scratch),
				).then(
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
				const closest = await timeRestorePhase("fetch", () =>
					closestCommit(git, snapshot, candidates, options.blobs),
				);
				if (closest === undefined) throw failure;
				// Which unpushed commits the closest commit's history lacks is an ancestry question a shallow store cannot answer.
				await unshallowStore(git, snapshot.remotes, [closest.commit]);
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
			},
		);
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
		// This host's checkout filters may have changed files, and a case-insensitive file system may hold one file for
		// paths that differ only in case: record what the worktree holds, and which files differ.
		const differing = nulFields(
			(await runGit(["diff-tree", "-r", "-z", "--name-only", "--no-renames", degraded.tree, measured], git)).stdout,
		);
		const folded = await caseFoldedPaths(git, degraded.tree, path);
		const missingPaths = [...new Set([...degraded.missingPaths, ...differing, ...folded])].sort();
		return { path, degraded: { ...degraded, tree: measured, missingPaths }, warnings };
	});
}

/**
 * The paths of `tree` that differ from another only in case (`dir/b.txt` and `Dir/b.txt`) where the worktree at `root`
 * lacks one of them under its own spelling: a case-insensitive file system holds one file for them all, so none can be
 * relied on (#4932).
 */
async function caseFoldedPaths(git: GitRunOptions, tree: string, root: string): Promise<string[]> {
	const groups = new Map<string, string[]>();
	for (const path of nulFields((await runGit(["ls-tree", "-r", "-z", "--name-only", tree], git)).stdout)) {
		const key = path.toLowerCase();
		groups.set(key, [...(groups.get(key) ?? []), path]);
	}
	const spelledAsRecorded = async (path: string) => {
		const parts = path.split("/");
		for (let index = 0; index < parts.length; index++) {
			const names: string[] = await readdir(join(root, ...parts.slice(0, index))).catch(() => []);
			if (!names.includes(parts[index]!)) return false;
		}
		return true;
	};
	const folded: string[] = [];
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		for (const path of group) {
			if (await spelledAsRecorded(path)) continue;
			folded.push(...group);
			break;
		}
	}
	return folded;
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
		const fetched = await fetchCommits(git, snapshot.remotes, [commit], false, [commit]);
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
	/** Where an exact restore hands its LFS download instead of running it (#5099). */
	readonly deferLfs?: RestoreWorktreeSnapshotOptions["deferLfs"];
	/**
	 * What the staged worktree is checked against before it is moved to `path`: its HEAD and recomputed tree (`tree`),
	 * or its HEAD alone (`head`), for a degraded restore whose content this host's filters may change.
	 */
	readonly verify: "tree" | "head";
}

/** The staging worktree of the restore `id` into `path`: under `storeDir`, or beside `path` when the caller chose it. */
function stagingPath(storeDir: string, path: string, into: string | undefined, id: string): string {
	return into === undefined
		? join(storeDir, "worktrees", stagingWorktreeName(id))
		: join(dirname(path), `.${basename(path)}${stagingWorktreeName(id)}`);
}

/**
 * On Windows, fails a restore into `path` over the object store `store` names before it writes anything when a path it
 * would create is longer than Git for Windows accepts (#5139). Staging names have one length, whatever the id.
 */
async function checkPathBudget(
	storeDir: string,
	store: () => Promise<string>,
	path: string,
	into: string | undefined,
	snapshotId: string | null,
): Promise<void> {
	if (process.platform !== "win32") return;
	const named = await store().then(
		(value) => ({ value }),
		() => undefined,
	);
	if (named === undefined) return;
	const staging = stagingPath(storeDir, path, into, "0".repeat(12));
	assertRestorePathBudget({ storeDir, store: () => named.value, staging, target: path, snapshotId });
}

/**
 * Checks `head` and `tree` out of `store` into a staging worktree, verifies it, and moves it to `path`, under a crash
 * record, so a final path never holds an unverified worktree.
 */
async function publishWorktree(publish: PublishWorktree): Promise<string> {
	const { git, store, storeDir, path, head, tree, snapshot, scratch, warn, signal } = publish;
	// Only an exact restore defers its download: a degraded one records the tree it holds after it (#5099).
	const deferred = publish.verify === "tree" ? publish.deferLfs : undefined;
	let measured = tree;
	const snapshotId = snapshot?.id ?? null;
	await checkTarget(path, snapshotId);
	const createdTarget = (await statIfPresent(path)) === undefined;
	const id = randomUUID();
	const staging = stagingPath(storeDir, path, publish.into, id);
	const record: RestoreRecord = { staging, target: path, store, createdTarget, tree };
	await withRestoreRecord(storeDir, id, record, snapshotId, warn, signal, async (assertActive, moving, created) => {
		await timeRestorePhase("materialize", () =>
			materialize(git, store, staging, head, tree, scratch, snapshotId, created, signal),
		);
		assertActive();
		const lfs = snapshot?.filters?.drivers.includes("lfs") ? snapshot.remotes : undefined;
		const pending: PendingLfs | undefined = lfs === undefined ? undefined : { head, tree, remotes: lfs };
		// Marked before it is published, so a worktree whose deferred download never completed says so (#5099).
		if (pending !== undefined && deferred !== undefined)
			await markLfsPending({ cwd: staging, signal }, pending, snapshotId);
		if (lfs !== undefined && deferred === undefined) {
			const worktree: GitRunOptions = { cwd: staging, signal };
			const pointers = await timeRestorePhase("lfs", () => pullLfsObjects(worktree, head, tree, lfs));
			if (pointers.length > 0) warn({ code: "lfs-objects-unavailable", paths: pointers });
		}
		measured = await timeRestorePhase("verify", () =>
			verifyRestoredTree(staging, path, head, tree, publish.verify, scratch, snapshotId, signal),
		);
		assertActive();
		await timeRestorePhase("publish", () =>
			withRepositoryLock(store, snapshotId, signal, () => moveIntoPlace(publish, record, snapshotId, moving)),
		);
		assertActive();
		if (pending !== undefined && deferred !== undefined) {
			const worktree: GitRunOptions = { cwd: path, signal };
			// Taken as any other process takes the download over, so it never runs beside one that took it first.
			deferred(
				path,
				deferRestorePhase("lfs", async () => finishPendingLfs(worktree, await pendingLfsPath(worktree))),
			);
		}
	});
	return measured;
}

/**
 * Checks that the worktree at `dir`, restored for `target`, has HEAD `head` and, unless only HEAD is checked, the
 * neutral policy tree `tree`, ignoring conversion filters through the empty attributes file in `scratch`. Resolves to
 * the tree it measured; rejects with `tree-mismatch`.
 */
async function verifyRestoredTree(
	dir: string,
	target: string,
	head: string,
	tree: string,
	verify: "tree" | "head",
	scratch: string,
	snapshotId: string | null,
	signal: AbortSignal | undefined,
): Promise<string> {
	const checkout = await locateCheckout(dir, signal);
	if (checkout instanceof Error) throw checkout;
	const policy = await loadSnapshotPathPolicy(dir);
	const actual = await withScratchDirectory((verifyScratch) =>
		writeWorkingTree(checkout, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, policy, verifyScratch, {
			signal,
			neutral: true,
			seedTree: tree,
			attributesFile: join(scratch, "empty-attributes"),
		}),
	);
	if (checkout.head !== head || (verify === "tree" && actual.tree !== tree)) {
		throw new WorkspaceRestoreError("tree-mismatch", {
			snapshotId,
			target,
			expectedTree: tree,
			actualTree: actual.tree,
		});
	}
	return actual.tree;
}

/**
 * Moves the verified staging worktree to the restore's final path, never into a directory that appeared there, telling
 * `moving` where the worktree may be: `unchecked` as Git is asked to move it, then `published` once it is registered at
 * that path, or `checked` once a nested move was refused.
 */
async function moveIntoPlace(
	publish: PublishWorktree,
	record: RestoreRecord,
	snapshotId: string | null,
	moving: (state: MoveState) => void,
): Promise<void> {
	const { git, path, signal } = publish;
	const { staging, createdTarget } = record;
	if (createdTarget) {
		if ((await statIfPresent(path)) !== undefined) {
			throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target: path, reason: "not-empty" });
		}
	} else {
		await writing(path, snapshotId, () => rmdir(path));
	}
	// `-f` replaces only a registration whose directory is gone, as a store restored from a CI cache keeps for the
	// worktree its saving job built at this path (#4748); a directory at the path was refused above.
	// The move and the check of where it went are never stopped midway (#4748): a Git killed mid-move leaves a worktree
	// that neither the staging path nor `published` accounts for. Both are short; a stop is noticed right after them.
	signal?.throwIfAborted();
	moving("unchecked");
	await runGit(["worktree", "move", "-f", staging, path], { ...git, signal: undefined });
	// Git moves *inside* an existing directory. If one appeared after our check, never return it as the
	// verified worktree: remove only the nested worktree that Git registered and leave the user's files alone,
	// even when that directory is itself a worktree of this store.
	const registered = await registeredWorktrees({ ...git, signal: undefined });
	const destination = await physicalPath(path);
	const nested = join(destination, basename(staging));
	if (includesPath(registered, destination) && !includesPath(registered, nested)) {
		moving("published");
	} else {
		// The cleanup that follows takes a worktree Git nested in the directory that appeared out again.
		moving(includesPath(registered, nested) ? "nested" : "checked");
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target: path, reason: "not-empty" });
	}
}

/** The entry at `path` itself, a symlink rather than what it points to, or undefined when there is none. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw unreadablePathError(path, error);
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
					`A restore interrupted earlier left ${warning.path}, which may hold your files; check them, then delete the directory yourself.`,
				);
		},
		options.signal,
	);
	const entry = await statIfPresent(target);
	if (entry === undefined) return;
	// A staging or set-aside directory is only ever what a cleanup kept, which may hold a user's files (#4748).
	if (isRestoreScratchName(basename(target)) || (await namedByRestoreRecord(storeDir, target))) {
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target, reason: "not-restored" });
	}
	const repositories = join(storeDir, "repositories");
	const common = entry.isDirectory() ? await absoluteCommonDir({ cwd: target, signal: options.signal }) : undefined;
	const store = common ? resolve(common.path) : "";
	if (
		common?.exitCode !== 0 ||
		!isWithin(repositories, store) ||
		relative(store, target) === "" ||
		isWithin(store, target)
	) {
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target, reason: "not-restored" });
	}
	await withRepositoryLock(store, null, options.signal, () =>
		removeWorktree({ cwd: repositories, env: { GIT_DIR: store }, signal: options.signal }, target),
	);
}

/**
 * Whether `name` is one a restore gives the directory it stages its worktree in, or sets it aside in to delete it: never
 * the name of a worktree a restore returned. Earlier versions named staging `.staging-<id>` and `.<target>.atomic-restore-<id>`.
 */
function isRestoreScratchName(name: string): boolean {
	return (
		/^(?:\.[sd]|\..+\.[sd])-[0-9a-f]{12}$/.test(name) ||
		/^\.staging-[0-9a-f-]{36}$/.test(name) ||
		/\.atomic-restore-[0-9a-f-]{36}$/.test(name)
	);
}

/** Whether a crash record under `storeDir` names `path` as its staging directory. */
async function namedByRestoreRecord(storeDir: string, path: string): Promise<boolean> {
	const recordsDir = join(storeDir, "restores");
	const names = await readdir(recordsDir).catch(() => [] as string[]);
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = await readFile(join(recordsDir, name), "utf8")
			.then((text) => JSON.parse(text) as { staging?: unknown })
			.catch(() => undefined);
		if (typeof record?.staging === "string" && includesPath([record.staging], path)) return true;
	}
	return false;
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	// A child named like `..x` is inside; only `..` or `../…` leaves.
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
