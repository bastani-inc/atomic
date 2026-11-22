import { randomUUID } from "node:crypto";
import {
	copyFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
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
 * longer has, and the next capture reseeds. Releases before `pristine` kept the files a capture added in the index, and
 * read HEAD's tree into it again in every capture; they ignore the two fields, and their records have neither.
 */
interface IndexRecord {
	readonly version: number;
	readonly seed: IndexSeed | null;
	readonly index: string;
	/** The commit whose tree the index holds, with no file a capture added: a capture of that HEAD reads it as is. */
	readonly pristine?: string;
	/** The tree `write-tree` gives for that index, once a capture learned it. */
	readonly tree?: string;
	/** Whether that index holds a submodule, once a capture read it. */
	readonly submodules?: boolean;
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
 * {@link writeWorkingTree} for a capture, through the private index `capture.index` kept between captures as the tree
 * of HEAD alone ({@link writeScannedTree}). Its entries keep the file times of the last capture's refresh, so unchanged
 * files are not read again; it is reseeded from the user's index whenever that changed, and reads HEAD's tree again
 * when HEAD moved. Any failure with it, such as a corrupt or truncated file, removes it and captures as
 * {@link writeWorkingTree} does: the tree is always computed from the working files. Runs in the index's turn
 * ({@link inTurn}).
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
		// A lock a killed Git left on the working copy fails Git's writes to it: capture without it, which removes it.
		if (await pathExists(`${working}.lock`)) throw new Error(`${working} is locked`);
		const seed = await indexSeedOf(userIndexPath);
		await mkdir(dirname(index), { recursive: true });
		const record = await recordOf(index);
		const reseed =
			record === undefined || !sameSeed(seed, record.seed) || !(await copyRecorded(index, record.index, working));
		if (reseed) {
			await rm(working, { force: true });
			await seedFromUserIndex(userIndexPath, working);
		}
		// The copy has the recorded bytes: it is HEAD's tree alone when the record says so for this HEAD.
		const pristine = !reseed && record?.pristine === checkout.head;
		const { state, headTree, submodules } = await writeScannedTree(
			working,
			checkout,
			settings,
			policy,
			scratch,
			{ pristine, tree: pristine ? record?.tree : undefined, submodules: pristine ? record?.submodules : undefined },
			() => ignoredAdditionsToHead(checkout, userIndexPath, scratch, signal),
			signal,
		);
		const written: IndexRecord = {
			version: CAPTURE_INDEX_VERSION,
			seed,
			index: sha256Hex(await readFile(working)),
			pristine: checkout.head,
			...(headTree === undefined ? {} : { tree: headTree }),
			...(submodules === undefined ? {} : { submodules }),
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
 * The files staged as additions to HEAD in each user's index this process listed, by index path: the hash of the
 * index's bytes and the HEAD they were listed against, the listing, which follows from those two alone, and whether it
 * holds a submodule.
 */
const stagedAdditions = new Map<
	string,
	{ readonly key: string; readonly added: readonly string[]; readonly submodules: boolean }
>();

/** The command that lists the files staged in an index as additions to `head`. */
function stagedAdditionsCommand(head: string, raw: boolean): string[] {
	return [
		"diff-index",
		"--cached",
		...(raw ? ["--raw", "--ignore-submodules=none"] : ["--name-only"]),
		"-z",
		"--no-renames",
		"--diff-filter=A",
		head,
	];
}

/**
 * Files staged in the user's index at `userIndexPath` as additions to HEAD that an ignore rule matches (`git add -f`):
 * the staged additions, then the ignore rules on those paths alone. The additions are listed again only when the
 * index's bytes or HEAD changed since the last listing, and then from a copy, in `scratch`, of exactly the bytes the
 * listing is kept for: the user's index can change meanwhile. Whether Git lists a staged submodule follows its
 * `ignore` setting, which the index does not hold, so while the index stages one the additions are listed every time.
 */
async function ignoredAdditionsToHead(
	checkout: Checkout,
	userIndexPath: string,
	scratch: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const { root, head } = checkout;
	let bytes: Buffer | null;
	try {
		bytes = await readFile(userIndexPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unreadablePathError(userIndexPath, error);
		bytes = null;
	}
	const key = `${bytes === null ? "none" : sha256Hex(bytes)}\0${head}`;
	let listed = stagedAdditions.get(userIndexPath);
	if (listed?.key !== key) {
		// A checkout without an index lists from an absent copy, as Git lists from its absent index: nothing.
		const copy = join(scratch, "user-index");
		if (bytes !== null) await writeFile(copy, bytes);
		// Every addition with its mode, whatever any submodule's `ignore` setting says.
		const fields = nulFields(
			(await runGit(stagedAdditionsCommand(head, true), { cwd: root, env: { GIT_INDEX_FILE: copy }, signal }))
				.stdout,
		);
		const added: string[] = [];
		let submodules = false;
		for (let index = 0; index + 1 < fields.length; index += 2) {
			if (fields[index]!.slice(1).split(" ")[1] === "160000") submodules = true;
			added.push(fields[index + 1]!);
		}
		listed = { key, added, submodules };
		stagedAdditions.set(userIndexPath, listed);
	}
	const added = listed.submodules
		? nulFields((await runGit(stagedAdditionsCommand(head, false), { cwd: root, signal })).stdout)
		: listed.added;
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
	const { admitted, omitted } = await admittedFiles(root, changed, untracked, settings, policy);
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
 * Which of the files that differ from HEAD (`changed`) and the untracked ones (`untracked`) a snapshot records
 * (`admitted`), in path order, and which it leaves out and why: the policy, the settings, then the size caps.
 */
async function admittedFiles(
	root: string,
	changed: readonly string[],
	untracked: readonly string[],
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
): Promise<{ readonly admitted: string[]; readonly omitted: PathOmission[] }> {
	const omitted: PathOmission[] = [];
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
	return { admitted, omitted };
}

/**
 * The settings and arguments of the `status` that lists, through a private index holding HEAD's tree, the files that
 * differ from it and the untracked ones, as `update-index --refresh`, `diff-files` and `ls-files --others
 * --exclude-standard` list them, apart from submodules: the untracked cache, which `ls-files` does not read, is not
 * used, and submodules are not looked into at all, so `status` starts no Git process in a submodule's repository, where
 * its settings and optional locks would reach (`diff-files` lists submodules: {@link writeScannedTree}).
 */
const SCAN_COMMAND = [
	"-c",
	"core.untrackedCache=false",
	"status",
	"--porcelain=v2",
	"-z",
	"--untracked-files=all",
	"--no-renames",
	"--ignore-submodules=all",
];

/**
 * The files that differ from the private index `git` names, which holds HEAD's tree, and the untracked ones, from one
 * `status` that also refreshes the index's file times. `askDiffFiles`: it listed an entry other than a changed or an
 * untracked file, such as an unmerged one, so `diff-files` lists the changed files.
 */
async function scanWorkingFiles(
	git: GitRunOptions,
): Promise<{ readonly changed: string[]; readonly untracked: string[]; readonly askDiffFiles: boolean }> {
	// The refreshed times are written back, as `update-index --refresh` writes them, even where optional locks are off.
	const { stdout } = await runGit(SCAN_COMMAND, { ...git, env: { ...git.env, GIT_OPTIONAL_LOCKS: "1" } });
	const fields = nulFields(stdout);
	const changed: string[] = [];
	const untracked: string[] = [];
	let askDiffFiles = false;
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (field.startsWith("? ")) {
			untracked.push(field.slice(2));
		} else if (field.startsWith("1 ")) {
			// `1 XY sub mH mI mW hH hI path`: Y is the file against the index.
			if (field[3] !== ".") changed.push(field.split(" ").slice(8).join(" "));
		} else {
			// A rename (with its original path next), an unmerged path or anything else: not one of HEAD's files alone.
			askDiffFiles = true;
			if (field.startsWith("2 ")) index++;
		}
	}
	return { changed, untracked, askDiffFiles };
}

/** The number of bytes of an object id of the repository whose HEAD commit is `head`, as Git writes it in an index. */
function objectIdBytes(head: string): number {
	return head.length / 2;
}

/**
 * Whether the Git index `bytes`, with object ids of `oidBytes` bytes, holds a submodule (an entry of mode 160000), read
 * from its entries in index versions 2 to 4. Undefined when its bytes cannot be read that way, such as an index split
 * into a shared file that holds most of its entries.
 */
function indexHoldsSubmodule(bytes: Uint8Array, oidBytes: number): boolean | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// The entries and extensions end where the checksum of the whole file starts.
	const end = bytes.byteLength - oidBytes;
	if (end < 12 || view.getUint32(0) !== 0x44495243) return undefined;
	const version = view.getUint32(4);
	if (version < 2 || version > 4) return undefined;
	let submodule = false;
	let offset = 12;
	for (let entry = view.getUint32(8); entry > 0; entry--) {
		// Ten 32-bit fields (times, device, inode, mode, owner, size), the object id, then 16-bit flags.
		const flags = offset + 40 + oidBytes;
		if (flags + 2 > end) return undefined;
		if ((view.getUint32(offset + 24) & 0o170000) === 0o160000) submodule = true;
		const extended = (view.getUint16(flags) & 0x4000) !== 0;
		if (extended && version < 3) return undefined;
		let name = flags + 2 + (extended ? 2 : 0);
		if (version === 4) {
			// How much of the previous entry's name this one keeps, as a variable-length number, then the rest of it.
			do {
				if (name >= end) return undefined;
			} while ((bytes[name++]! & 0x80) !== 0);
		}
		const nul = bytes.indexOf(0, name);
		if (nul < 0 || nul >= end) return undefined;
		// Versions 2 and 3 pad each entry with NULs to a multiple of 8 bytes; version 4 does not pad.
		offset = version === 4 ? nul + 1 : offset + ((nul - offset + 8) & ~7);
	}
	while (offset + 8 <= end) {
		// A split index (`link`) keeps the rest of its entries in a shared index.
		if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === "link") return undefined;
		offset += 8 + view.getUint32(offset + 4);
	}
	return offset === end ? submodule : undefined;
}

/**
 * The tree of a capture's working files through the private index `index`, kept between captures as HEAD's tree alone,
 * refreshed: `pristine` says it already is HEAD's tree, so it is not read again, `tree` is the tree it gives when
 * known, and `submodules` whether it holds one, when known. One `status` lists the files that differ from it and the
 * untracked ones ({@link scanWorkingFiles}); where the index holds a submodule, or may, `update-index --refresh` and
 * `diff-files` list the changed files, submodules included, as before. The files the snapshot records go into a copy,
 * in `scratch`, so `index` stays HEAD's tree. Records exactly the tree and omissions {@link writeTreeThrough} records
 * with a refresh and the files staged despite an ignore rule. Resolves the tree `index` gives and whether it holds a
 * submodule, when this capture learned them.
 */
async function writeScannedTree(
	index: string,
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	scratch: string,
	known: { readonly pristine: boolean; readonly tree: string | undefined; readonly submodules: boolean | undefined },
	forceAdded: () => Promise<string[]>,
	signal?: AbortSignal,
): Promise<{
	readonly state: WorkingTreeState;
	readonly headTree: string | undefined;
	readonly submodules: boolean | undefined;
}> {
	const { root } = checkout;
	const git: GitRunOptions = { cwd: root, env: { GIT_INDEX_FILE: index }, signal };
	if (!known.pristine) await runGit(["read-tree", "--reset", checkout.head], git);
	// The index holds HEAD's tree now: whether it holds a submodule follows from its entries.
	const submodules =
		(known.pristine ? known.submodules : undefined) ??
		indexHoldsSubmodule(await readFile(index), objectIdBytes(checkout.head));
	const scan = await scanWorkingFiles(git);
	let { changed } = scan;
	if (scan.askDiffFiles || submodules !== false) {
		await runGit(["update-index", "-q", "--refresh"], { ...git, allowExitCodes: [1] });
		changed = nulFields((await runGit(["diff-files", "-z", "--name-only", "--no-renames"], git)).stdout);
	}
	const untracked = [...scan.untracked, ...(await forceAdded())];
	const { admitted, omitted } = await admittedFiles(root, changed, untracked, settings, policy);
	const headTree = known.pristine ? known.tree : undefined;
	if (admitted.length === 0) {
		const tree = headTree ?? (await gitText(["write-tree"], git));
		return { state: { tree, omitted }, headTree: tree, submodules };
	}
	const recorded = join(scratch, "capture-index");
	await copyWithTimes(index, recorded);
	const files: GitRunOptions = { ...git, env: { GIT_INDEX_FILE: recorded } };
	await runGit(["update-index", "-z", "--add", "--remove", "--replace", "--stdin"], {
		...files,
		input: `${admitted.join("\0")}\0`,
	});
	return { state: { tree: await gitText(["write-tree"], files), omitted }, headTree, submodules };
}

/**
 * Copies `from` to `to` with `from`'s times: Git trusts an index entry's file times only when they are older than the
 * index file's, so a copy must not look newer than the index it copies.
 */
async function copyWithTimes(from: string, to: string): Promise<void> {
	await copyFile(from, to);
	const { atime, mtimeMs } = await stat(from);
	await utimes(to, atime, new Date(mtimeMs));
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
 * capture of the checkout reads from: `tree` itself when no file gets another mode. `read` is `recorded` when Git read
 * it to compare, which shows that the repository holds it.
 */
async function withRecordedModes(
	root: string,
	tree: string,
	recorded: string | undefined,
	omitted: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<{ readonly tree: string; readonly read?: string }> {
	if (recorded === undefined || recorded === tree) return { tree };
	const carried = await carriedModes(root, signal);
	if (carried.size === 0) return { tree };
	// A recorded tree this store no longer holds has no modes to give: Git fails, printing no entries.
	const diff = await runGit(["diff-tree", "-r", "--raw", "-z", "--no-renames", recorded, tree], {
		cwd: root,
		signal,
		allowExitCodes: [128],
	});
	const read = diff.exitCode === 0 ? recorded : undefined;
	const fields = nulFields(diff.stdout);
	const entries: string[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const [oldMode = "", newMode, , newBlob] = fields[index]!.slice(1).split(" ");
		const path = fields[index + 1]!;
		if (carried.has(oldMode) && newMode === "100644" && !omitted.has(path)) {
			entries.push(`${oldMode} ${newBlob}\t${path}\0`);
		}
	}
	if (entries.length === 0) return { tree, read };
	return withScratchDirectory(async (scratch) => {
		const git: GitRunOptions = { cwd: root, env: { GIT_INDEX_FILE: join(scratch, "index") }, signal };
		await runGit(["read-tree", tree], git);
		await runGit(["update-index", "-z", "--index-info"], { ...git, input: entries.join("") });
		return { tree: await gitText(["write-tree"], git), read };
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
	/**
	 * The settings Git packs a bundle with, `pack.*` and `core.*` (such as `pack.compression`, `pack.window` or
	 * `core.bigFileThreshold`), as a hash: they change a bundle's size without changing the packs.
	 */
	readonly packing: string;
}

export async function readRepositoryConfig(root: string, signal?: AbortSignal): Promise<RepositoryConfig> {
	const { stdout } = await runGit(["config", "-z", "--get-regexp", "^(remote\\..+\\.url|(core|pack)\\..+)$"], {
		cwd: root,
		signal,
		allowExitCodes: [1],
	});
	const remotes: string[] = [];
	const packing: string[] = [];
	let autocrlf: string | null = null;
	let eol: string | null = null;
	for (const field of nulFields(stdout)) {
		const newline = field.indexOf("\n");
		const key = newline < 0 ? field : field.slice(0, newline);
		const value = newline < 0 ? "" : field.slice(newline + 1);
		if (key.startsWith("remote.")) {
			remotes.push(redactUrlCredentials(value));
			continue;
		}
		packing.push(field);
		if (key === "core.autocrlf") autocrlf = value;
		else if (key === "core.eol") eol = value;
	}
	return { remotes, autocrlf, eol, packing: sha256Hex(packing.join("\0")) };
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

/** Why a snapshot leaves its checkout's unpushed commits out. */
type HistoryOmission = Extract<
	WorktreeSnapshotOmission,
	{ readonly reason: "unpushed-history-denied" | "bundle-over-cap" }
>;

/**
 * The unpushed commits a capture of each checkout in this process last left out, by checkout root: the hash of their
 * exact list (`fingerprint`), the omission recorded for it, and for a bundle over the cap, the repository's packs and
 * packing settings the commits were bundled with ({@link packingOf}). Which of those commits add or modify a
 * deny-listed path follows from the list alone, and the size of their bundle from the list, the packs and the settings,
 * so a later capture of the same list records the same omission without checking and bundling the commits again, which
 * takes seconds for a long history no remote has.
 */
const leftOutHistory = new Map<
	string,
	{ readonly fingerprint: string; readonly omission: HistoryOmission; readonly packs: string | undefined }
>();

/**
 * How far over the cap an earlier bundle of the same commits, from the same packs, must have been for a capture to
 * leave them out without bundling them again: packing the same commits again can give a slightly smaller bundle.
 * Nearer the cap they are bundled again.
 */
const OVER_CAP_REUSE_MARGIN = 0.1;

/** How deep Git follows object directories that borrow from others (`objects/info/alternates`). */
const ALTERNATES_DEPTH = 5;

/**
 * The packs of the repository with the Git directory `gitDir`, and of the object directories it borrows objects from
 * (`objects/info/alternates`), as a hash of their file names and sizes; undefined when they cannot all be read. A
 * bundle of the same commits packed from the same packs has nearly the same size; a repack or `git gc` replaces them
 * and can make it much smaller. Objects written loose since then are not part of it: an unpushed commit's objects stay
 * loose until a repack packs them, and objects written later are no part of the commits' bundle.
 */
async function packsOf(gitDir: string): Promise<string | undefined> {
	let objects: string;
	try {
		// A linked worktree's Git directory names the repository's own, which holds the objects.
		objects = join(resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim()), "objects");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		objects = join(gitDir, "objects");
	}
	const listed: string[] = [];
	const visited = new Set<string>();
	const visit = async (directory: string, depth: number): Promise<boolean> => {
		if (visited.has(directory)) return true;
		if (depth > ALTERNATES_DEPTH) return false;
		visited.add(directory);
		let names: string[];
		let alternates: string;
		try {
			names = (await readdir(join(directory, "pack"))).sort();
			for (const name of names)
				listed.push(`${directory}\0${name}\0${(await stat(join(directory, "pack", name))).size}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		try {
			alternates = await readFile(join(directory, "info", "alternates"), "utf8");
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
		for (const line of alternates.split(/\r?\n/)) {
			if (line === "" || line.startsWith("#")) continue;
			// A quoted path is one Git unquotes first; it is not followed here, and the packs count as unknown.
			if (line.startsWith('"') || !(await visit(resolve(directory, line), depth + 1))) return false;
		}
		return true;
	};
	return (await visit(objects, 0)) ? sha256Hex(listed.join("\n")) : undefined;
}

/**
 * The repository's packs ({@link packsOf}) and its packing settings `packing` ({@link RepositoryConfig.packing}) as
 * one hash; undefined when the packs cannot be read.
 */
async function packingOf(gitDir: string, packing: string): Promise<string | undefined> {
	const packs = await packsOf(gitDir);
	return packs === undefined ? undefined : sha256Hex(`${packs}\n${packing}`);
}

/** The repository's packing settings as they are now ({@link RepositoryConfig.packing}); undefined when unreadable. */
async function packingSettingsNow(root: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		return (await readRepositoryConfig(root, signal)).packing;
	} catch (error) {
		signal?.throwIfAborted();
		if (isWorkspaceSnapshotError(error) || isGitUnavailableError(error)) throw error;
		return undefined;
	}
}

/**
 * Whether `omission`, recorded for the same unpushed commits, still leaves them out under `settings`: a denied commit
 * always does; a bundle over the cap does while the repository's packs and packing settings are those it was bundled
 * with (`packs`, as {@link packingOf} gives them for this capture: `current`) and its size exceeds the cap by more than
 * {@link OVER_CAP_REUSE_MARGIN}.
 */
async function stillLeftOut(
	omission: HistoryOmission,
	packs: string | undefined,
	current: () => Promise<string | undefined>,
	settings: WorktreeSnapshotSettings,
): Promise<boolean> {
	if (omission.reason === "unpushed-history-denied") return true;
	if (packs === undefined || omission.bytes <= settings.maxSnapshotBytes * (1 + OVER_CAP_REUSE_MARGIN)) return false;
	return (await current()) === packs;
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
		// The ref goes on the command line: Git before 2.31 bundles no ref it reads from standard input. The commits
		// the bundle starts from can be many, so they are read from there.
		const input = boundary.map((commit) => `^${commit}\n`).join("");
		await runGit(["bundle", "create", "-q", file, ref, "--stdin"], { cwd: root, signal, input });
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

/** The commits of `head` no remote-tracking ref reaches, newest first, and the reached commits they start from. */
interface UnpushedHistory {
	readonly unpushed: readonly string[];
	readonly boundary: readonly string[];
}

async function unpushedHistory(root: string, head: string, signal?: AbortSignal): Promise<UnpushedHistory> {
	const listed = (await gitText(["rev-list", "--boundary", head, "--not", "--remotes"], { cwd: root, signal }))
		.split("\n")
		.filter(Boolean);
	return {
		unpushed: listed.filter((line) => !line.startsWith("-")),
		boundary: listed.filter((line) => line.startsWith("-")).map((line) => line.slice(1)),
	};
}

/** Whether a snapshot's omission of its checkout's history, `omission`, still holds for `unpushed` under `settings`. */
function historyStillLeftOut(
	omission: HistoryOmission,
	unpushed: readonly string[],
	settings: WorktreeSnapshotSettings,
): boolean {
	if (omission.reason === "unpushed-history-denied") {
		// Pushing a denied commit makes it no longer the snapshot's to leave out.
		const listed = new Set(unpushed);
		return omission.commits.every((commit) => listed.has(commit));
	}
	return (
		omission.bytes > settings.maxSnapshotBytes &&
		omission.commits.length === unpushed.length &&
		omission.commits.every((commit, index) => commit === unpushed[index])
	);
}

function isHistoryOmission(omission: WorktreeSnapshotOmission): omission is HistoryOmission {
	return omission.reason === "unpushed-history-denied" || omission.reason === "bundle-over-cap";
}

/**
 * The unpushed history of `checkout` for a capture whose repository config, read at its start, has the packing
 * settings `packing` ({@link RepositoryConfig.packing}).
 */
async function captureHistory(
	checkout: Checkout,
	gitDir: string,
	settings: WorktreeSnapshotSettings,
	packing: string,
	previous: WorktreeSnapshot | undefined,
	scratch: string,
	signal?: AbortSignal,
	listed?: UnpushedHistory,
): Promise<HistoryCapture> {
	const { root, head } = checkout;
	const { unpushed, boundary } = listed ?? (await unpushedHistory(root, head, signal));
	if (unpushed.length === 0) return { bundle: null, omitted: [] };
	const sameHistory = (commits: readonly string[]) =>
		previous?.head === head && commits.length === unpushed.length && commits.every((c, i) => c === unpushed[i]);
	if (previous?.bundle && sameHistory(previous.bundle.commits)) return { bundle: previous.bundle, omitted: [] };
	const fingerprint = sha256Hex(unpushed.join("\n"));
	const remembered = leftOutHistory.get(root);
	if (
		remembered?.fingerprint === fingerprint &&
		(await stillLeftOut(remembered.omission, remembered.packs, () => packingOf(gitDir, packing), settings))
	) {
		return { bundle: null, omitted: [remembered.omission] };
	}
	const leaveOut = (omission: HistoryOmission, packs?: string): HistoryCapture => {
		leftOutHistory.set(root, { fingerprint, omission, packs });
		return { bundle: null, omitted: [omission] };
	};
	const denied = await deniedHistory(root, unpushed, signal);
	if (denied.commits.length > 0) return leaveOut({ reason: "unpushed-history-denied", ...denied });
	const packs = await packingOf(gitDir, packing);
	const file = join(scratch, "history.bundle");
	await bundlePinned(root, head, boundary, file, signal);
	const data = await verifiedBundle(root, head, unpushed, file, signal);
	// Not the commits that were checked: record the snapshot without its history rather than store them (#4900).
	if (data === null) return { bundle: null, omitted: [] };
	if (data.byteLength > settings.maxSnapshotBytes) {
		// The size is kept for the packs and settings only when they are the same after bundling as before it.
		const now = await packingSettingsNow(root, signal);
		const bundledFrom = now !== undefined && packs === (await packingOf(gitDir, now)) ? packs : undefined;
		return leaveOut({ reason: "bundle-over-cap", commits: unpushed, bytes: data.byteLength }, bundledFrom);
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
 * out, so a file that keeps growing past a cap is the same omission; history omissions are compared through HEAD and
 * the unpushed commits ({@link historyStillLeftOut}).
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
 * and `unchanged` with `previous` when HEAD, the recomputed tree and the files it leaves out all equal it and the
 * unpushed commits it left out, if any, are still left out ({@link historyStillLeftOut}). Never
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
	const modes = await withRecordedModes(root, read.state.tree, modeTree, omittedPaths, signal);
	const state = { ...read.state, tree: modes.tree };
	const pathOmissions = read.omitted;
	const omissions = pathOmissionKeys(pathOmissions);
	let listed: UnpushedHistory | undefined;
	if (
		previous &&
		previous.head === head &&
		previous.tree === state.tree &&
		JSON.stringify(pathOmissionKeys(previous.omitted)) === JSON.stringify(omissions)
	) {
		const unchanged = { status: "unchanged", snapshot: previous, binding: bindingOf(previous) } as const;
		// Unpushed history the previous snapshot left out may have been pushed since, or fit under the cap now.
		const leftOut = previous.omitted.filter(isHistoryOmission);
		if (leftOut.length === 0) return unchanged;
		listed = await unpushedHistory(root, head, signal);
		const { unpushed } = listed;
		if (leftOut.every((omission) => historyStillLeftOut(omission, unpushed, settings))) return unchanged;
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
			// Comparing modes with the previous tree read it, where the repository does not trust file modes.
			(modes.read === previous.tree || (await objectExists(root, previous.tree, signal)));
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
		const history = await captureHistory(
			checkout,
			capture.gitDir,
			settings,
			config.packing,
			previous,
			scratch,
			signal,
			listed,
		);
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
