import { randomUUID } from "node:crypto";
import {
	copyFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathExists } from "../../utils/path-exists.ts";
import { renameWithRetry } from "../rename-retry.ts";
import { snapshotBlobHashes } from "./blob-store.ts";
import { computeEnvironmentHash, sha256Hex, snapshotBlob } from "./env-hash.ts";
import {
	type GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceSnapshotError,
	unreadablePathError,
	WorkspaceConfigError,
	WorkspaceSnapshotError,
} from "./errors.ts";
import {
	type GitRunOptions,
	gitText,
	installedGitUnavailable,
	nulFields,
	redactUrlCredentials,
	runGit,
} from "./git.ts";
import { canonicalizeWorktreePathAsync, captureIndexPath, defaultWorktreeSnapshotStoreDir } from "./paths.ts";
import { isDeniedSnapshotPath, loadSnapshotPathPolicy, type SnapshotPathPolicy } from "./policy.ts";
import { resolveWorktreeSnapshotSettings, type WorktreeSnapshotSettingsInput } from "./settings.ts";
import type {
	SnapshotBlob,
	SnapshotBlobStore,
	WorkspaceBinding,
	WorktreeSnapshot,
	WorktreeSnapshotBundle,
	WorktreeSnapshotChainLink,
	WorktreeSnapshotFilters,
	WorktreeSnapshotOmission,
	WorktreeSnapshotSettings,
} from "./types.ts";

export interface CaptureWorktreeSnapshotOptions {
	/** Overrides for the default snapshot settings. */
	readonly settings?: WorktreeSnapshotSettingsInput;
	/**
	 * The last snapshot recorded for this checkout: the no-op comparison and the incremental delta base. With `blobs`,
	 * its blobs' age restarts first, so collection keeps them for the new snapshot; when any is missing it is ignored
	 * and the capture records a full delta.
	 */
	readonly previous?: WorktreeSnapshot;
	/** Where to store new patch and bundle blobs before the capture resolves. */
	readonly blobs?: SnapshotBlobStore;
	readonly signal?: AbortSignal;
}

export type WorktreeSnapshotUnavailableReason = GitUnavailableError | WorkspaceSnapshotError;

export type WorktreeSnapshotCapture =
	| {
			readonly status: "captured";
			readonly snapshot: WorktreeSnapshot;
			readonly binding: WorkspaceBinding;
			/** Blobs this capture created; already stored when `blobs` was passed. */
			readonly blobs: readonly SnapshotBlob[];
	  }
	| { readonly status: "unchanged"; readonly snapshot: WorktreeSnapshot; readonly binding: WorkspaceBinding }
	| { readonly status: "disabled" }
	| { readonly status: "unavailable"; readonly reason: WorktreeSnapshotUnavailableReason };

const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "Atomic",
	GIT_AUTHOR_EMAIL: "atomic@localhost",
	GIT_AUTHOR_DATE: "@0 +0000",
	GIT_COMMITTER_NAME: "Atomic",
	GIT_COMMITTER_EMAIL: "atomic@localhost",
	GIT_COMMITTER_DATE: "@0 +0000",
};

/** Writes the commit of `tree` on `head` that records a snapshot. A fixed identity and time give one state one id. */
export function writeSnapshotCommit(git: GitRunOptions, head: string, tree: string): Promise<string> {
	return gitText(["commit-tree", "--no-gpg-sign", "-p", head, "-m", "Atomic worktree snapshot", tree], {
		...git,
		env: { ...git.env, ...SNAPSHOT_IDENTITY },
	});
}

export function bindingOf(snapshot: WorktreeSnapshot): WorkspaceBinding {
	return { remotes: [...snapshot.remotes], head: snapshot.head, tree: snapshot.tree, envHash: snapshot.envHash };
}

export interface Checkout {
	readonly root: string;
	readonly head: string;
	/** The checkout's absolute Git directory as Git prints it, when the lookup that found the checkout read it. */
	readonly gitDir?: string;
	/** The absolute path of the checkout's own index file, read with {@link gitDir}. */
	readonly userIndex?: string;
}

/**
 * One `rev-parse` that prints the checkout's top level, its Git directory and index file, then its HEAD commit, which
 * an unborn HEAD leaves out with exit code 1.
 */
const LOCATE_CHECKOUT = [
	"rev-parse",
	"--show-toplevel",
	"--absolute-git-dir",
	"--git-path",
	"index",
	"--verify",
	"-q",
	"HEAD^{commit}",
];

/**
 * The checkout containing `dir` and its HEAD commit, or the reason it has none: Git is missing, `dir` is outside a
 * work tree, or the repository has no commits. One Git process reads all of it ({@link lookupOutcome}).
 */
export async function locateCheckout(
	dir: string,
	signal?: AbortSignal,
): Promise<Checkout | WorktreeSnapshotUnavailableReason> {
	try {
		if (!(await stat(dir)).isDirectory()) return new WorkspaceSnapshotError("not-a-repository", dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
			return new WorkspaceSnapshotError("not-a-repository", dir, error as Error);
		}
		throw unreadablePathError(dir, error);
	}
	try {
		const located = await runGit(LOCATE_CHECKOUT, { cwd: dir, signal, allowExitCodes: [1, 128] });
		const output = located.stdout.toString("utf8");
		const lines = output.replace(/\n$/, "").split("\n");
		const [top = "", gitDir = "", index = "", head = ""] = lines;
		switch (lookupOutcome(located.exitCode, output === "", lines.length)) {
			case "not-a-repository":
				return new WorkspaceSnapshotError("not-a-repository", dir);
			case "unborn-head":
				return new WorkspaceSnapshotError("unborn-head", await canonicalizeWorktreePathAsync(top));
			case "located":
				return {
					root: await canonicalizeWorktreePathAsync(top),
					head,
					gitDir,
					userIndex: isAbsolute(index) ? index : resolve(dir, index),
				};
			case "stepwise":
				return await locateCheckoutStepwise(dir, signal);
		}
	} catch (error) {
		if (isGitUnavailableError(error)) return error;
		throw error;
	}
}

/**
 * What the single lookup's exit code and output say. Exit code 128 with nothing printed: no work tree contains the
 * directory, which `--show-toplevel`, the first question, reports at once. Exit code 0 with four lines: the checkout and
 * its HEAD; exit code 1 with three: a checkout whose HEAD has no commit. Anything else, such as a path with a line
 * break, is asked again one question at a time.
 */
function lookupOutcome(
	exitCode: number,
	nothingPrinted: boolean,
	lineCount: number,
): "not-a-repository" | "unborn-head" | "located" | "stepwise" {
	if (exitCode === 128 && nothingPrinted) return "not-a-repository";
	if (exitCode === 0 && lineCount === 4) return "located";
	if (exitCode === 1 && lineCount === 3) return "unborn-head";
	return "stepwise";
}

/** {@link locateCheckout} one question at a time, for output the single lookup cannot be split by. */
async function locateCheckoutStepwise(
	dir: string,
	signal?: AbortSignal,
): Promise<Checkout | WorktreeSnapshotUnavailableReason> {
	const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, signal, allowExitCodes: [128] });
	if (top.exitCode !== 0) return new WorkspaceSnapshotError("not-a-repository", dir);
	const root = await canonicalizeWorktreePathAsync(top.stdout.toString("utf8").replace(/\n$/, ""));
	const head = await runGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
		cwd: root,
		signal,
		allowExitCodes: [1, 128],
	});
	if (head.exitCode !== 0) return new WorkspaceSnapshotError("unborn-head", root);
	return { root, head: head.stdout.toString("utf8").trim() };
}

/** Runs `action` with a private directory that is removed afterwards; a removal failure never hides `action`'s. */
export async function withScratchDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-snapshot-"));
	let result: T;
	try {
		result = await action(directory);
	} catch (error) {
		try {
			await rm(directory, { recursive: true, force: true });
		} catch (cleanupCause) {
			Object.defineProperty(error as Error, "cleanupCause", { value: cleanupCause, configurable: true });
		}
		throw error;
	}
	await rm(directory, { recursive: true, force: true });
	return result;
}

export interface WorkingTreeState {
	readonly tree: string;
	readonly omitted: readonly WorktreeSnapshotOmission[];
}

interface WorkingTreeOptions {
	readonly signal?: AbortSignal;
	readonly neutral?: boolean;
	readonly seedTree?: string;
	readonly attributesFile?: string;
}

/**
 * The file in a restored worktree's own Git directory that names the tree the restore checked out, so its first
 * capture, which has no earlier snapshot of that checkout, can keep the modes the snapshot recorded (#4932).
 */
export const RESTORED_TREE_FILE = "atomic-restored-tree";

/** Records `tree` as the tree the restored worktree at `worktree` holds. */
export async function recordRestoredTree(worktree: GitRunOptions, tree: string): Promise<void> {
	const gitDir =
		(await linkedWorktreeGitDir(worktree.cwd)) ?? (await gitText(["rev-parse", "--absolute-git-dir"], worktree));
	await writeFile(join(gitDir, RESTORED_TREE_FILE), `${tree}\n`);
}

/**
 * The Git directory a linked worktree's `.git` file at `root` names, read without starting Git: `git worktree add`
 * writes it as one `gitdir: <path>` line, relative to `root` when Git writes relative worktree paths. Undefined for
 * anything else, such as a `.git` directory or a file naming no existing directory, which Git is asked about instead.
 */
async function linkedWorktreeGitDir(root: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, ".git"), "utf8");
	} catch {
		return undefined;
	}
	const match = /^gitdir: (.+?)\r?\n?$/.exec(text);
	if (match === null) return undefined;
	const gitDir = resolve(root, match[1]!);
	try {
		return (await stat(gitDir)).isDirectory() ? gitDir : undefined;
	} catch {
		return undefined;
	}
}

/** The tree a restore recorded in the Git directory `gitDir`, or undefined when it is not a restored worktree. */
async function restoredTreeOf(gitDir: string): Promise<string | undefined> {
	try {
		return (await readFile(join(gitDir, RESTORED_TREE_FILE), "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function userIndexPathOf(checkout: Checkout, signal?: AbortSignal): Promise<string> {
	if (checkout.userIndex !== undefined) return checkout.userIndex;
	const userIndex = await gitText(["rev-parse", "--git-path", "index"], { cwd: checkout.root, signal });
	return isAbsolute(userIndex) ? userIndex : resolve(checkout.root, userIndex);
}

/**
 * Copies the user's index to `index`, keeping its time: Git trusts a cached entry only when it is older than the index
 * file, so an entry written in the same instant as a later edit is still read from the file, not taken as unchanged.
 * A checkout without an index leaves `index` absent.
 */
async function seedFromUserIndex(userIndexPath: string, index: string): Promise<void> {
	try {
		await copyFile(userIndexPath, index);
		const { atime, mtimeMs } = await stat(userIndexPath);
		await utimes(index, atime, new Date(mtimeMs));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadablePathError(userIndexPath, error);
	}
}

/**
 * Writes the policy-filtered working tree through a private index seeded from `seedTree` (HEAD by default), leaving
 * the user's index, refs and files untouched. A path the policy, settings or caps leave out keeps HEAD's content, or
 * stays absent when HEAD lacks it, whatever the seed held, so a verification seeded from a recorded tree sees a
 * recorded file that later grew past a cap or became ignored as changed. A file staged in the user's index despite an
 * ignore rule (`git add -f`) counts as a new file, like an untracked one.
 */
export async function writeWorkingTree(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	scratch: string,
	options: WorkingTreeOptions,
): Promise<WorkingTreeState> {
	const index = join(scratch, "index");
	await seedFromUserIndex(await userIndexPathOf(checkout, options.signal), index);
	return writeTreeThrough(index, checkout, settings, policy, options, {
		refresh: options.seedTree !== undefined,
		forceAdded: (git) => ignoredStagedOutsideSeed(checkout.root, git, options),
	});
}

/** What a persistent capture index was seeded from: the user's index as it was then. */
interface IndexSeed {
	readonly size: number;
	readonly mtimeMs: number;
	/** The index's last bytes, which end with its checksum. */
	readonly tail: string;
}

const CAPTURE_INDEX_VERSION = 1;

/** The user's index as a seed, or null when the checkout has none. */
async function indexSeedOf(userIndexPath: string): Promise<IndexSeed | null> {
	let file: FileHandle;
	try {
		file = await open(userIndexPath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw unreadablePathError(userIndexPath, error);
	}
	try {
		const { size, mtimeMs } = await file.stat();
		const tail = Buffer.alloc(Math.min(size, 32));
		await file.read(tail, 0, tail.byteLength, size - tail.byteLength);
		return { size, mtimeMs, tail: tail.toString("hex") };
	} finally {
		await file.close();
	}
}

/**
 * What is recorded next to a private index: the seed it was built from and the hash of its bytes. The record is written
 * after the index, by whichever capture renamed it, so it vouches only for the exact index it names: a crash between
 * the two writes, or captures in two processes renaming over each other, leave a record whose hash the index file no
 * longer has, and the next capture reseeds.
 */
interface IndexRecord {
	readonly version: number;
	readonly seed: IndexSeed | null;
	readonly index: string;
}

/** The record next to `index`, when it is of this version; anything else reads as none. */
async function recordOf(index: string): Promise<IndexRecord | undefined> {
	try {
		const record = JSON.parse(await readFile(`${index}.json`, "utf8")) as IndexRecord;
		return record.version === CAPTURE_INDEX_VERSION ? record : undefined;
	} catch {
		return undefined;
	}
}

function sameSeed(left: IndexSeed | null, right: IndexSeed | null): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Captures of one checkout in this process, chained so they take turns with its persistent index. */
const captureIndexTurns = new Map<string, Promise<void>>();

async function inTurn<T>(key: string, action: () => Promise<T>): Promise<T> {
	const run = (captureIndexTurns.get(key) ?? Promise.resolve()).then(action);
	const turn = run.then(
		() => undefined,
		() => undefined,
	);
	captureIndexTurns.set(key, turn);
	try {
		return await run;
	} finally {
		if (captureIndexTurns.get(key) === turn) captureIndexTurns.delete(key);
	}
}

/** Where captures of a checkout keep their private index, with the checkout's Git directory and own index file. */
interface CaptureIndex {
	readonly gitDir: string;
	readonly userIndexPath: string;
	readonly index: string;
}

async function captureIndexOf(checkout: Checkout, storeDir: string, signal?: AbortSignal): Promise<CaptureIndex> {
	const { root } = checkout;
	if (checkout.gitDir !== undefined && checkout.userIndex !== undefined) {
		return {
			gitDir: checkout.gitDir,
			userIndexPath: checkout.userIndex,
			index: captureIndexPath(storeDir, checkout.gitDir, root),
		};
	}
	const [gitDir = "", userIndex = ""] = (
		await gitText(["rev-parse", "--absolute-git-dir", "--git-path", "index"], { cwd: root, signal })
	).split("\n");
	return {
		gitDir,
		userIndexPath: isAbsolute(userIndex) ? userIndex : resolve(root, userIndex),
		index: captureIndexPath(storeDir, gitDir, root),
	};
}

/**
 * {@link writeWorkingTree} for a capture, through the private index `capture.index` kept between captures. Its entries
 * keep the file times of the last capture's refresh, so unchanged files are not read again; it is reseeded from the
 * user's index whenever that changed. Any failure with it, such as a corrupt or truncated file, removes it and
 * captures as {@link writeWorkingTree} does: the tree is always computed from the working files. Runs in the index's
 * turn ({@link inTurn}).
 */
async function writeCapturedTree(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	scratch: string,
	capture: CaptureIndex,
	signal?: AbortSignal,
): Promise<WorkingTreeState> {
	const { root } = checkout;
	const { index, userIndexPath } = capture;
	const options: WorkingTreeOptions = { signal };
	if (!(await usableOutside(root, index))) return writeWorkingTree(checkout, settings, policy, scratch, options);
	const working = `${index}.${process.pid}.tmp`;
	try {
		const seed = await indexSeedOf(userIndexPath);
		await mkdir(dirname(index), { recursive: true });
		const record = await recordOf(index);
		const reseed =
			record === undefined || !sameSeed(seed, record.seed) || !(await copyRecorded(index, record.index, working));
		if (reseed) {
			await rm(working, { force: true });
			await seedFromUserIndex(userIndexPath, working);
		}
		const state = await writeTreeThrough(working, checkout, settings, policy, options, {
			refresh: true,
			forceAdded: () => ignoredAdditionsToHead(checkout, signal),
		});
		const written: IndexRecord = {
			version: CAPTURE_INDEX_VERSION,
			seed,
			index: sha256Hex(await readFile(working)),
		};
		await renameWithRetry(working, index, { signal });
		await writeAtomically(`${index}.json`, JSON.stringify(written));
		return state;
	} catch {
		const remove = (files: readonly string[]) =>
			Promise.all(files.map((file) => rm(file, { force: true }))).catch(() => undefined);
		await remove([working, `${working}.lock`]);
		signal?.throwIfAborted();
		await remove([index, `${index}.json`]);
		return writeWorkingTree(checkout, settings, policy, scratch, options);
	}
}

/** What a capture reads from a checkout's working files: its tree, and the paths the snapshot leaves out. */
interface WorkingFiles {
	readonly state: WorkingTreeState;
	readonly omitted: readonly WorktreeSnapshotOmission[];
}

/** Orders the ends of turns' writes and the starts of scans in this process: a later tick happened after. */
let captureTick = 0;
/** @internal The next tick of the clock that orders turns' writes and scans of checkouts in this process. */
export function nextCaptureTick(): number {
	captureTick += 1;
	return captureTick;
}

/**
 * The computations of a checkout's working files that have not started reading them, by everything they compute
 * from: the checkout, its HEAD, its private index and the settings. A computation keeps no modes from an earlier
 * snapshot, which each capture gives its own tree afterwards, so every capture of those inputs can take it.
 */
const pendingWorkingFiles = new Map<string, Promise<WorkingFiles>>();

/** The computations of a checkout's working files reading them now, by the same key, and when each started. */
const startedWorkingFiles = new Map<
	string,
	{ readonly computation: Promise<WorkingFiles>; readonly startedAt: number }
>();

/**
 * Reads the working files of `checkout` in its private index's turn. A capture without an abort signal joins the
 * computation another one requested for the same inputs when that has not started yet, instead of starting its own:
 * the computation reads the files after the joining capture was requested, so that capture records exactly what one
 * of its own starting at the same moment would. With `wroteBy`, when the writes it must hold ended, it also joins one
 * that started reading after that. Any other started computation is not joined, as it may have read a file before the
 * capture's writes: a capture waits for at most the computation running when it was requested and one more, whichever
 * earlier snapshots the captures start from.
 */
function readWorkingFiles(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	capture: CaptureIndex,
	signal?: AbortSignal,
	wroteBy?: number,
): Promise<WorkingFiles> {
	const compute = () =>
		withScratchDirectory(async (scratch): Promise<WorkingFiles> => {
			const policy = await loadSnapshotPathPolicy(checkout.root);
			const state = await writeCapturedTree(checkout, settings, policy, scratch, capture, signal);
			return { state, omitted: [...state.omitted, ...(await submoduleOmissions(checkout.root, signal))] };
		});
	if (signal !== undefined) return inTurn(capture.index, compute);
	const key = JSON.stringify([
		checkout.root,
		checkout.head,
		capture.gitDir,
		capture.userIndexPath,
		capture.index,
		settings,
	]);
	const pending = pendingWorkingFiles.get(key);
	if (pending !== undefined) return pending;
	const started = startedWorkingFiles.get(key);
	if (wroteBy !== undefined && started !== undefined && started.startedAt > wroteBy) return started.computation;
	const computation: Promise<WorkingFiles> = inTurn(capture.index, async () => {
		if (pendingWorkingFiles.get(key) === computation) pendingWorkingFiles.delete(key);
		const reading = { computation, startedAt: nextCaptureTick() };
		startedWorkingFiles.set(key, reading);
		try {
			return await compute();
		} finally {
			if (startedWorkingFiles.get(key) === reading) startedWorkingFiles.delete(key);
		}
	});
	pendingWorkingFiles.set(key, computation);
	return computation;
}

/**
 * Whether a private index at `index` may be used for the checkout at `root`: its path resolves, and it is outside the
 * checkout, which would otherwise capture the index's own files.
 */
async function usableOutside(root: string, index: string): Promise<boolean> {
	let real: string;
	try {
		real = await canonicalizeWorktreePathAsync(index);
	} catch {
		return false;
	}
	const fromRoot = relative(root, real);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

/**
 * Copies `from` to `to` with `from`'s modification time; true when its bytes have the recorded `hash`, false when they
 * do not, and the copy must be replaced, or `from` does not exist. Bytes and time are read through one handle, so a
 * rename over `from` meanwhile cannot pair one file's bytes with another's time.
 */
async function copyRecorded(from: string, hash: string, to: string): Promise<boolean> {
	let file: FileHandle;
	try {
		file = await open(from, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	let bytes: Buffer;
	let times: { readonly atime: Date; readonly mtime: Date };
	try {
		times = await file.stat();
		bytes = await file.readFile();
	} finally {
		await file.close();
	}
	await writeFile(to, bytes);
	await utimes(to, times.atime, times.mtime);
	return sha256Hex(bytes) === hash;
}

async function writeAtomically(file: string, data: string): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, data);
	try {
		await renameWithRetry(temporary, file);
	} catch (error) {
		// Windows refuses to replace a file another process has open, which concurrent captures do.
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** Files staged in the user's index that an ignore rule matches and the private index, read from the seed, lacks. */
async function ignoredStagedOutsideSeed(
	root: string,
	git: GitRunOptions,
	options: WorkingTreeOptions,
): Promise<string[]> {
	const ignoredInIndex = ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"];
	const stagedIgnored = nulFields(
		(await runGit(ignoredInIndex, { cwd: root, signal: options.signal, neutral: options.neutral })).stdout,
	);
	const seededIgnored = new Set(
		stagedIgnored.length === 0 ? [] : nulFields((await runGit(ignoredInIndex, git)).stdout),
	);
	return stagedIgnored.filter((path) => !seededIgnored.has(path));
}

/**
 * Files staged in the user's index as additions to HEAD that an ignore rule matches (`git add -f`): one listing of the
 * staged additions, then the ignore rules on those paths alone.
 */
async function ignoredAdditionsToHead(checkout: Checkout, signal?: AbortSignal): Promise<string[]> {
	const { root, head } = checkout;
	const added = nulFields(
		(
			await runGit(["diff-index", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=A", head], {
				cwd: root,
				signal,
			})
		).stdout,
	);
	if (added.length === 0) return [];
	const ignored = await runGit(["check-ignore", "--no-index", "--stdin", "-z"], {
		cwd: root,
		signal,
		input: `${added.join("\0")}\0`,
		allowExitCodes: [1],
	});
	return nulFields(ignored.stdout);
}

async function writeTreeThrough(
	index: string,
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	options: WorkingTreeOptions,
	how: { readonly refresh: boolean; readonly forceAdded: (git: GitRunOptions) => Promise<string[]> },
): Promise<WorkingTreeState> {
	const { root } = checkout;
	const git: GitRunOptions = {
		cwd: root,
		env: { GIT_INDEX_FILE: index },
		signal: options.signal,
		neutral: options.neutral,
	};
	const config = options.attributesFile === undefined ? [] : ["-c", `core.attributesFile=${options.attributesFile}`];
	await runGit([...config, "read-tree", "--reset", options.seedTree ?? checkout.head], git);
	if (how.refresh) {
		await runGit([...config, "update-index", "-q", "--refresh"], { ...git, allowExitCodes: [1] });
	}
	const changed = nulFields(
		(await runGit([...config, "diff-files", "-z", "--name-only", "--no-renames"], git)).stdout,
	);
	const forceAdded = await how.forceAdded(git);
	// An untracked repository inside the checkout is listed as its directory, ending in `/`: its files are not captured.
	const untracked = [
		...nulFields((await runGit(["ls-files", "-z", "--others", "--exclude-standard"], git)).stdout),
		...forceAdded,
	];
	const omitted: Extract<WorktreeSnapshotOmission, { readonly path: string }>[] = [];
	const admitted: string[] = [];
	let total = 0;
	const candidates = [
		...changed.map((path) => ({ path, tracked: true })),
		...untracked.map((path) => ({ path, tracked: false })),
	].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	for (const { path, tracked } of candidates) {
		const exclusion = policy.exclusion(path);
		if (exclusion) {
			omitted.push({ reason: exclusion, path });
			continue;
		}
		if (!tracked && !settings.includeUntracked) {
			omitted.push({ reason: "untracked-excluded", path });
			continue;
		}
		if (path.endsWith("/")) {
			omitted.push({ reason: "nested-repository", path });
			continue;
		}
		const bytes = await fileBytes(join(root, path));
		if (bytes > settings.maxFileBytes) {
			omitted.push({ reason: "over-file-cap", path, bytes });
			continue;
		}
		if (total + bytes > settings.maxSnapshotBytes) {
			omitted.push({ reason: "over-snapshot-cap", path, bytes });
			continue;
		}
		total += bytes;
		admitted.push(path);
	}
	if (options.seedTree !== undefined && omitted.length > 0) {
		await runGit(["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul", checkout.head], {
			...git,
			env: { ...git.env, GIT_LITERAL_PATHSPECS: "1" },
			input: `${omitted.map((omission) => omission.path).join("\0")}\0`,
		});
	}
	if (admitted.length > 0) {
		await runGit([...config, "update-index", "-z", "--add", "--remove", "--replace", "--stdin"], {
			...git,
			input: `${admitted.join("\0")}\0`,
		});
	}
	return { tree: await gitText(["write-tree"], git), omitted };
}

/**
 * The modes a capture of the checkout at `root` carries over from the tree of an earlier snapshot, as
 * {@link withRecordedModes} does: executable files where the repository does not trust the file system's executable bits
 * (`core.filemode=false`), links where it has no symbolic links (`core.symlinks=false`). None where it trusts both, so
 * a capture records the same tree from whichever earlier snapshot it starts.
 */
async function carriedModes(root: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
	const settings = await runGit(["config", "-z", "--type=bool", "--get-regexp", "^core\\.(filemode|symlinks)$"], {
		cwd: root,
		signal,
		allowExitCodes: [1],
	});
	const trusted = new Map([
		["core.filemode", true],
		["core.symlinks", true],
	]);
	for (const field of nulFields(settings.stdout)) {
		const [key = "", value] = field.split("\n");
		trusted.set(key, value === "true");
	}
	const carried = new Set<string>();
	if (!trusted.get("core.filemode")) carried.add("100755");
	if (!trusted.get("core.symlinks")) carried.add("120000");
	return carried;
}

/**
 * `tree`, the tree of a checkout's working files as Git reads them, with the modes `recorded`, the tree of an earlier
 * snapshot, gives its files: where the repository does not trust the file system's executable bits
 * (`core.filemode=false`) or has no symbolic links (`core.symlinks=false`), as on Windows, each regular file of `tree`
 * that `recorded` holds as executable or as a link gets that mode with its current content. Git would otherwise record
 * the checked-out file as a regular one (#4932). An edit keeps the mode, as Git keeps a tracked entry's mode where it
 * cannot read one from the file; a link's new content is its new target. Files the capture leaves out (`omitted`) keep
 * HEAD's entry. The modes go into a tree of this capture's own, never into the checkout's private index, which every
 * capture of the checkout reads from: `tree` itself when no file gets another mode.
 */
async function withRecordedModes(
	root: string,
	tree: string,
	recorded: string | undefined,
	omitted: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<string> {
	if (recorded === undefined || recorded === tree) return tree;
	const carried = await carriedModes(root, signal);
	if (carried.size === 0) return tree;
	// A recorded tree this store no longer holds has no modes to give: Git fails, printing no entries.
	const diff = await runGit(["diff-tree", "-r", "--raw", "-z", "--no-renames", recorded, tree], {
		cwd: root,
		signal,
		allowExitCodes: [128],
	});
	const fields = nulFields(diff.stdout);
	const entries: string[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const [oldMode = "", newMode, , newBlob] = fields[index]!.slice(1).split(" ");
		const path = fields[index + 1]!;
		if (carried.has(oldMode) && newMode === "100644" && !omitted.has(path)) {
			entries.push(`${oldMode} ${newBlob}\t${path}\0`);
		}
	}
	if (entries.length === 0) return tree;
	return withScratchDirectory(async (scratch) => {
		const git: GitRunOptions = { cwd: root, env: { GIT_INDEX_FILE: join(scratch, "index") }, signal };
		await runGit(["read-tree", tree], git);
		await runGit(["update-index", "-z", "--index-info"], { ...git, input: entries.join("") });
		return gitText(["write-tree"], git);
	});
}

async function fileBytes(path: string): Promise<number> {
	try {
		return (await lstat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
			return 0;
		}
		throw unreadablePathError(path, error);
	}
}

type PathOmission = Extract<WorktreeSnapshotOmission, { readonly path: string }>;

/** How long checking the submodules of one capture may take; a submodule not checked by then is listed as unchecked. */
export const SUBMODULE_CHECK_TIMEOUT_MS = 10_000;

/**
 * Submodules whose work a snapshot does not record: uncommitted changes or untracked files, or a checked-out commit
 * that no remote-tracking ref of the submodule reaches. Only checkouts with a `.gitmodules` file are checked, and only
 * submodules checked out here. A check that fails or runs past {@link SUBMODULE_CHECK_TIMEOUT_MS} lists its submodule
 * as `submodule-unchecked` instead of failing the capture.
 */
async function submoduleOmissions(root: string, signal?: AbortSignal): Promise<PathOmission[]> {
	if (!(await pathExists(join(root, ".gitmodules")))) return [];
	const bounded = AbortSignal.any([AbortSignal.timeout(SUBMODULE_CHECK_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	const unchecked = (path: string, error: unknown): PathOmission[] => {
		if (signal?.aborted) throw error;
		return [{ reason: "submodule-unchecked", path }];
	};
	let paths: string[];
	try {
		const { stdout } = await runGit(
			["config", "-z", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
			{ cwd: root, signal: bounded, allowExitCodes: [1] },
		);
		paths = nulFields(stdout).map((field) => field.slice(field.indexOf("\n") + 1));
	} catch (error) {
		return unchecked(".gitmodules", error);
	}
	const candidates = [...new Set(paths)].sort();
	const present = await Promise.all(
		candidates.map(async (path) => {
			const fromRoot = relative(root, resolve(root, path));
			const inside =
				fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
			return inside && (await pathExists(join(root, fromRoot, ".git")));
		}),
	);
	const checkedOut = candidates.filter((_, index) => present[index]);
	const results = await Promise.all(
		checkedOut.map(async (path): Promise<PathOmission[]> => {
			const git: GitRunOptions = { cwd: join(root, path), signal: bounded };
			try {
				const [status, unpushed] = await Promise.all([
					runGit(["status", "--porcelain", "-z"], git),
					runGit(["rev-list", "-n", "1", "HEAD", "--not", "--remotes"], git),
				]);
				return [
					...(status.stdout.byteLength > 0 ? [{ reason: "submodule-changes" as const, path }] : []),
					...(unpushed.stdout.byteLength > 0 ? [{ reason: "unpushed-submodule-commit" as const, path }] : []),
				];
			} catch (error) {
				return unchecked(path, error);
			}
		}),
	);
	return results.flat();
}

interface RepositoryConfig {
	readonly remotes: string[];
	readonly autocrlf: string | null;
	readonly eol: string | null;
}

export async function readRepositoryConfig(root: string, signal?: AbortSignal): Promise<RepositoryConfig> {
	const { stdout } = await runGit(
		["config", "-z", "--get-regexp", "^(remote\\..+\\.url|core\\.autocrlf|core\\.eol)$"],
		{ cwd: root, signal, allowExitCodes: [1] },
	);
	const remotes: string[] = [];
	let autocrlf: string | null = null;
	let eol: string | null = null;
	for (const field of nulFields(stdout)) {
		const newline = field.indexOf("\n");
		const key = newline < 0 ? field : field.slice(0, newline);
		const value = newline < 0 ? "" : field.slice(newline + 1);
		if (key === "core.autocrlf") autocrlf = value;
		else if (key === "core.eol") eol = value;
		else remotes.push(redactUrlCredentials(value));
	}
	return { remotes, autocrlf, eol };
}

const FILTER_ATTRIBUTE = /^(?!\s*#).*?(?:^|\s)filter=(\S+)/gm;

async function readFilters(
	root: string,
	config: RepositoryConfig,
	signal?: AbortSignal,
): Promise<WorktreeSnapshotFilters | null> {
	const attributeFiles = nulFields(
		(await runGit(["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"], { cwd: root, signal }))
			.stdout,
	);
	const drivers = new Set<string>();
	for (const file of attributeFiles) {
		let text: string;
		try {
			text = await readFile(join(root, file), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw unreadablePathError(join(root, file), error);
		}
		for (const match of text.matchAll(FILTER_ATTRIBUTE)) drivers.add(match[1]!);
	}
	if (config.autocrlf === null && config.eol === null && drivers.size === 0) return null;
	return { autocrlf: config.autocrlf, eol: config.eol, drivers: [...drivers].sort() };
}

interface HistoryCapture {
	readonly bundle: WorktreeSnapshotBundle | null;
	readonly omitted: readonly WorktreeSnapshotOmission[];
	readonly blob?: SnapshotBlob;
}

const COMMIT_TOKEN = /^([0-9a-f]{40}|[0-9a-f]{64})(?: \(from [0-9a-f]+\))?$/;

/** Commits of `commits` that add or modify a deny-listed path, with those paths. */
async function deniedHistory(
	root: string,
	commits: readonly string[],
	signal?: AbortSignal,
): Promise<{ readonly commits: string[]; readonly paths: string[] }> {
	const known = new Set(commits);
	const { stdout } = await runGit(
		["diff-tree", "--stdin", "-r", "-z", "--name-only", "--no-renames", "--diff-filter=ACMRT", "--root", "-m"],
		{ cwd: root, signal, input: `${commits.join("\n")}\n` },
	);
	const deniedCommits = new Set<string>();
	const paths = new Set<string>();
	let current: string | undefined;
	for (const token of nulFields(stdout)) {
		const commit = COMMIT_TOKEN.exec(token)?.[1];
		if (commit !== undefined && known.has(commit)) {
			current = commit;
			continue;
		}
		if (current !== undefined && isDeniedSnapshotPath(token)) {
			deniedCommits.add(current);
			paths.add(token);
		}
	}
	return {
		commits: commits.filter((commit) => deniedCommits.has(commit)),
		paths: [...paths].sort(),
	};
}

/**
 * Writes to `file` the bundle of `head` without the commits `boundary` reaches, under the bundle ref `HEAD`, through a
 * temporary ref pinned to `head`: bundling the symbolic `HEAD` would take whatever commit it names by then (#4900).
 * The ref is removed even when the capture is aborted.
 */
async function bundlePinned(
	root: string,
	head: string,
	boundary: readonly string[],
	file: string,
	signal?: AbortSignal,
): Promise<void> {
	const ref = `refs/atomic/capture/${randomUUID()}`;
	await runGit(["update-ref", "--no-deref", ref, head, ""], { cwd: root, signal });
	try {
		const input = `${[ref, ...boundary.map((commit) => `^${commit}`)].join("\n")}\n`;
		await runGit(["bundle", "create", "-q", file, "--stdin"], { cwd: root, signal, input });
	} finally {
		await runGit(["update-ref", "--no-deref", "-d", ref, head], { cwd: root });
	}
}

/**
 * `data` with its single ref, which must be `head`, named `HEAD` as restores fetch it, or null when the bundle names
 * another commit or more than one.
 */
function namedHead(
	data: Uint8Array,
	head: string,
): { readonly data: Uint8Array; readonly prerequisites: string[] } | null {
	const bytes = Buffer.from(data);
	const end = bytes.indexOf("\n\n");
	if (end < 0) return null;
	const lines = bytes.subarray(0, end).toString("utf8").split("\n");
	const refs = lines.filter((line) => !/^[#@-]/.test(line));
	if (refs.length !== 1 || refs[0]!.split(" ", 1)[0] !== head) return null;
	const header = lines.map((line) => (line === refs[0] ? `${head} HEAD` : line)).join("\n");
	return {
		data: new Uint8Array(Buffer.concat([Buffer.from(header, "utf8"), bytes.subarray(end)])),
		prerequisites: lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1).split(" ", 1)[0]!),
	};
}

/**
 * The bundle in `file` as stored, when Git reads its only head as `head` and it holds exactly `commits`, the commits
 * checked against the deny-list; otherwise null.
 */
async function verifiedBundle(
	root: string,
	head: string,
	commits: readonly string[],
	file: string,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const named = namedHead(new Uint8Array(await readFile(file)), head);
	if (named === null) return null;
	await writeFile(file, named.data);
	if ((await gitText(["bundle", "list-heads", file], { cwd: root, signal })) !== `${head} HEAD`) return null;
	const input = `${[head, ...named.prerequisites.map((commit) => `^${commit}`)].join("\n")}\n`;
	const bundled = (await gitText(["rev-list", "--stdin"], { cwd: root, signal, input })).split("\n").filter(Boolean);
	const checked = new Set(commits);
	return bundled.length === checked.size && bundled.every((commit) => checked.has(commit)) ? named.data : null;
}

async function captureHistory(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	previous: WorktreeSnapshot | undefined,
	scratch: string,
	signal?: AbortSignal,
): Promise<HistoryCapture> {
	const { root, head } = checkout;
	const listed = (await gitText(["rev-list", "--boundary", head, "--not", "--remotes"], { cwd: root, signal }))
		.split("\n")
		.filter(Boolean);
	const unpushed = listed.filter((line) => !line.startsWith("-"));
	const boundary = listed.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
	if (unpushed.length === 0) return { bundle: null, omitted: [] };
	const sameHistory = (commits: readonly string[]) =>
		previous?.head === head && commits.length === unpushed.length && commits.every((c, i) => c === unpushed[i]);
	if (previous?.bundle && sameHistory(previous.bundle.commits)) return { bundle: previous.bundle, omitted: [] };
	const denied = await deniedHistory(root, unpushed, signal);
	if (denied.commits.length > 0) {
		return { bundle: null, omitted: [{ reason: "unpushed-history-denied", ...denied }] };
	}
	const file = join(scratch, "history.bundle");
	await bundlePinned(root, head, boundary, file, signal);
	const data = await verifiedBundle(root, head, unpushed, file, signal);
	// Not the commits that were checked: record the snapshot without its history rather than store them (#4900).
	if (data === null) return { bundle: null, omitted: [] };
	if (data.byteLength > settings.maxSnapshotBytes) {
		return { bundle: null, omitted: [{ reason: "bundle-over-cap", commits: unpushed, bytes: data.byteLength }] };
	}
	const blob = snapshotBlob(data);
	return { bundle: { blob: blob.hash, bytes: data.byteLength, commits: unpushed }, omitted: [], blob };
}

async function objectExists(root: string, object: string, signal?: AbortSignal): Promise<boolean> {
	const { exitCode } = await runGit(["cat-file", "-e", object], { cwd: root, signal, allowExitCodes: [1, 128] });
	return exitCode === 0;
}

/**
 * The working-tree omissions of a snapshot as `reason path` keys, in the path order capture lists them. Sizes are left
 * out, so a file that keeps growing past a cap is the same omission; history omissions depend only on HEAD and are
 * compared through it.
 */
function pathOmissionKeys(omitted: readonly WorktreeSnapshotOmission[]): string[] {
	return omitted.flatMap((omission) => ("path" in omission ? [`${omission.reason}\0${omission.path}`] : []));
}

function snapshotId(
	fields: Omit<WorktreeSnapshot, "id" | "capturedAt" | "version" | "omitted" | "filters">,
	omissions: readonly string[],
): string {
	return sha256Hex(
		JSON.stringify([
			fields.root,
			fields.remotes,
			fields.branch,
			fields.head,
			fields.tree,
			fields.envHash,
			fields.chain,
			fields.bundle?.blob ?? null,
			omissions,
		]),
	).slice(0, 32);
}

/**
 * Records the state of the Git checkout containing `dir`. Resolves `unavailable` (with the typed reason) when Git is
 * missing, `dir` is outside a work tree, the repository has no commits, or a path the snapshot reads cannot be read,
 * and `unchanged` with `previous` when HEAD, the recomputed tree and the files it leaves out all equal it. Never
 * changes the user's index, refs or files, apart from a temporary ref under `refs/atomic/capture/` that bundling unpushed
 * commits creates and removes.
 */
export async function captureWorktreeSnapshot(
	dir: string,
	options: CaptureWorktreeSnapshotOptions = {},
): Promise<WorktreeSnapshotCapture> {
	if (typeof dir !== "string" || dir.length === 0) throw new WorkspaceConfigError("sdk", "dir", "a directory path");
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	if (!settings.enabled) return { status: "disabled" };
	try {
		return await captureCheckout(() => locateCheckout(dir, options.signal), settings, options);
	} catch (error) {
		if (isWorkspaceSnapshotError(error)) return { status: "unavailable", reason: error };
		throw error;
	}
}

/**
 * {@link captureWorktreeSnapshot} of the checkout that {@link locateCheckout} returned, which is not looked up again.
 * With `wroteBy`, a {@link nextCaptureTick} taken once the writes the capture must hold ended, it also takes the tree
 * of a scan of the checkout's working files that started after that.
 */
export async function captureLocatedCheckout(
	checkout: Checkout,
	options: CaptureWorktreeSnapshotOptions = {},
	wroteBy?: number,
): Promise<WorktreeSnapshotCapture> {
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	if (!settings.enabled) return { status: "disabled" };
	try {
		return await captureCheckout(async () => checkout, settings, options, wroteBy);
	} catch (error) {
		if (isWorkspaceSnapshotError(error)) return { status: "unavailable", reason: error };
		throw error;
	}
}

/**
 * Captures a checkout with `capture` and records the result with `record`, which writes the session entry that
 * references it and rejects with a `blobs-collected` {@link WorkspaceSnapshotError}, writing nothing, when a collection
 * deleted one of its blobs after the capture stored them (#5077). The capture's blobs are then stored again and the
 * record retried; when that fails too, the checkout is captured once more and recorded. A third failure rejects with
 * the error, so a snapshot is recorded only with its blobs, or not at all.
 */
export async function recordWorktreeCapture(
	blobs: SnapshotBlobStore,
	capture: () => Promise<WorktreeSnapshotCapture>,
	record: (capture: WorktreeSnapshotCapture) => Promise<void>,
): Promise<void> {
	const first = await capture();
	try {
		return await record(first);
	} catch (error) {
		if (!isBlobsCollectedError(error)) throw error;
	}
	if (first.status === "captured") {
		await blobs.putBlobs(first.blobs);
		try {
			return await record(first);
		} catch (error) {
			if (!isBlobsCollectedError(error)) throw error;
		}
	}
	return record(await capture());
}

/** Whether `error` says a snapshot was not recorded because a collection deleted one of its blobs (#5077). */
export function isBlobsCollectedError(error: unknown): error is WorkspaceSnapshotError {
	return isWorkspaceSnapshotError(error) && error.code === "blobs-collected";
}

async function captureCheckout(
	locate: () => Promise<Checkout | WorktreeSnapshotUnavailableReason>,
	settings: WorktreeSnapshotSettings,
	options: CaptureWorktreeSnapshotOptions,
	wroteBy?: number,
): Promise<WorktreeSnapshotCapture> {
	const { signal } = options;
	const gitUnavailable = await installedGitUnavailable();
	if (gitUnavailable !== undefined) return { status: "unavailable", reason: gitUnavailable };
	const checkout = await locate();
	if (checkout instanceof Error) return { status: "unavailable", reason: checkout };
	const { root, head } = checkout;
	const candidate = options.previous?.root === root ? options.previous : undefined;
	const previous =
		candidate !== undefined &&
		options.blobs !== undefined &&
		!(await options.blobs.refreshBlobs(snapshotBlobHashes(candidate)))
			? undefined
			: candidate;
	const capture = await captureIndexOf(checkout, resolve(defaultWorktreeSnapshotStoreDir()), signal);
	const read = await readWorkingFiles(checkout, settings, capture, signal, wroteBy);
	const modeTree = previous?.tree ?? (await restoredTreeOf(capture.gitDir));
	const omittedPaths = new Set(read.state.omitted.flatMap((omission) => ("path" in omission ? [omission.path] : [])));
	const state = {
		...read.state,
		tree: await withRecordedModes(root, read.state.tree, modeTree, omittedPaths, signal),
	};
	const pathOmissions = read.omitted;
	const omissions = pathOmissionKeys(pathOmissions);
	if (
		previous &&
		previous.head === head &&
		previous.tree === state.tree &&
		JSON.stringify(pathOmissionKeys(previous.omitted)) === JSON.stringify(omissions)
	) {
		return { status: "unchanged", snapshot: previous, binding: bindingOf(previous) };
	}
	return withScratchDirectory(async (scratch) => {
		const config = await readRepositoryConfig(root, signal);
		const branch = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], {
			cwd: root,
			signal,
			allowExitCodes: [1],
		});
		const snapshotCommit = await writeSnapshotCommit({ cwd: root, signal }, head, state.tree);
		const incremental =
			previous !== undefined &&
			previous.head === head &&
			previous.chain.length < settings.fullEvery &&
			(await objectExists(root, previous.tree, signal));
		const baseTree = incremental
			? previous.tree
			: await gitText(["rev-parse", `${head}^{tree}`], { cwd: root, signal });
		const blobs: SnapshotBlob[] = [];
		let patch: SnapshotBlob | undefined;
		if (baseTree !== state.tree) {
			const { stdout } = await runGit(
				[
					"diff-tree",
					"-p",
					"--binary",
					"--full-index",
					"--no-renames",
					"--no-ext-diff",
					"--no-textconv",
					"--ignore-submodules=none",
					"-r",
					baseTree,
					state.tree,
				],
				{ cwd: root, signal },
			);
			patch = snapshotBlob(new Uint8Array(stdout));
			blobs.push(patch);
		}
		const link: WorktreeSnapshotChainLink = {
			tree: state.tree,
			patch: patch?.hash ?? null,
			bytes: patch?.data.byteLength ?? 0,
		};
		const chain = incremental ? [...previous.chain, link] : [link];
		const history = await captureHistory(checkout, settings, previous, scratch, signal);
		if (history.blob) blobs.push(history.blob);
		const fields = {
			root,
			remotes: config.remotes,
			branch: branch.exitCode === 0 ? branch.stdout.toString("utf8").trim() : null,
			head,
			snapshot: snapshotCommit,
			tree: state.tree,
			envHash: await computeEnvironmentHash(root),
			delta: { base: incremental ? previous.id : "head", patch: link.patch, bytes: link.bytes },
			chain,
			bundle: history.bundle,
		};
		const snapshot: WorktreeSnapshot = {
			version: 1,
			id: snapshotId(fields, omissions),
			...fields,
			omitted: [...pathOmissions, ...history.omitted],
			filters: await readFilters(root, config, signal),
			capturedAt: new Date().toISOString(),
		};
		if (options.blobs) await options.blobs.putBlobs(blobs);
		return { status: "captured", snapshot, binding: bindingOf(snapshot), blobs };
	});
}
