import {
	copyFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { canonicalizeWorktreePath, captureIndexPath, defaultWorktreeSnapshotStoreDir } from "./paths.ts";
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

interface Checkout {
	readonly root: string;
	readonly head: string;
}

/**
 * The checkout containing `dir` and its HEAD commit, or the reason it has none: Git is missing, `dir` is outside a
 * work tree, or the repository has no commits.
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
		const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, signal, allowExitCodes: [128] });
		if (top.exitCode !== 0) return new WorkspaceSnapshotError("not-a-repository", dir);
		const root = canonicalizeWorktreePath(top.stdout.toString("utf8").replace(/\n$/, ""));
		const head = await runGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
			cwd: root,
			signal,
			allowExitCodes: [1, 128],
		});
		if (head.exitCode !== 0) return new WorkspaceSnapshotError("unborn-head", root);
		return { root, head: head.stdout.toString("utf8").trim() };
	} catch (error) {
		if (isGitUnavailableError(error)) return error;
		throw error;
	}
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

async function userIndexPathOf(root: string, signal?: AbortSignal): Promise<string> {
	const userIndex = await gitText(["rev-parse", "--git-path", "index"], { cwd: root, signal });
	return isAbsolute(userIndex) ? userIndex : resolve(root, userIndex);
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
	await seedFromUserIndex(await userIndexPathOf(checkout.root, options.signal), index);
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

/** The seed recorded next to `index`, when it is of this version; anything else reads as none. */
async function recordedSeedOf(index: string): Promise<IndexSeed | null | undefined> {
	try {
		const record = JSON.parse(await readFile(`${index}.json`, "utf8")) as {
			readonly version?: number;
			readonly seed?: IndexSeed | null;
		};
		return record.version === CAPTURE_INDEX_VERSION ? record.seed : undefined;
	} catch {
		return undefined;
	}
}

function sameSeed(left: IndexSeed | null, right: IndexSeed | null | undefined): boolean {
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

/**
 * {@link writeWorkingTree} for a capture, through a private index kept between captures under `storeDir`. Its entries
 * keep the file times of the last capture's refresh, so unchanged files are not read again; it is reseeded from the
 * user's index whenever that changed. Any failure with it, such as a corrupt or truncated file, removes it and
 * captures as {@link writeWorkingTree} does: the tree is always computed from the working files.
 */
async function writeCapturedTree(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	scratch: string,
	storeDir: string,
	signal?: AbortSignal,
): Promise<WorkingTreeState> {
	const { root } = checkout;
	const [gitDir = "", userIndex = ""] = (
		await gitText(["rev-parse", "--absolute-git-dir", "--git-path", "index"], { cwd: root, signal })
	).split("\n");
	const userIndexPath = isAbsolute(userIndex) ? userIndex : resolve(root, userIndex);
	const index = captureIndexPath(storeDir, gitDir, root);
	if (!usableOutside(root, index)) return writeWorkingTree(checkout, settings, policy, scratch, { signal });
	return inTurn(index, async () => {
		const working = `${index}.${process.pid}.tmp`;
		try {
			const seed = await indexSeedOf(userIndexPath);
			await mkdir(dirname(index), { recursive: true });
			const reseed = !sameSeed(seed, await recordedSeedOf(index)) || !(await copyKeepingTime(index, working));
			if (reseed) {
				await rm(working, { force: true });
				await seedFromUserIndex(userIndexPath, working);
			}
			const state = await writeTreeThrough(
				working,
				checkout,
				settings,
				policy,
				{ signal },
				{
					refresh: true,
					forceAdded: () => ignoredAdditionsToHead(checkout, signal),
				},
			);
			if (reseed) await writeAtomically(`${index}.json`, JSON.stringify({ version: CAPTURE_INDEX_VERSION, seed }));
			await rename(working, index);
			return state;
		} catch {
			const remove = (files: readonly string[]) =>
				Promise.all(files.map((file) => rm(file, { force: true }))).catch(() => undefined);
			await remove([working, `${working}.lock`]);
			signal?.throwIfAborted();
			await remove([index, `${index}.json`]);
			return writeWorkingTree(checkout, settings, policy, scratch, { signal });
		}
	});
}

/**
 * Whether a private index at `index` may be used for the checkout at `root`: its path resolves, and it is outside the
 * checkout, which would otherwise capture the index's own files.
 */
function usableOutside(root: string, index: string): boolean {
	let real: string;
	try {
		real = canonicalizeWorktreePath(index);
	} catch {
		return false;
	}
	const fromRoot = relative(root, real);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

/** Copies `from` to `to` with `from`'s modification time; false when `from` does not exist. */
async function copyKeepingTime(from: string, to: string): Promise<boolean> {
	try {
		await copyFile(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const { atime, mtime } = await stat(from);
	await utimes(to, atime, mtime);
	return true;
}

async function writeAtomically(file: string, data: string): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, data);
	await rename(temporary, file);
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
	const untracked = [
		...nulFields((await runGit(["ls-files", "-z", "--others", "--exclude-standard"], git)).stdout).filter(
			(path) => !path.endsWith("/"),
		),
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

async function captureHistory(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	previous: WorktreeSnapshot | undefined,
	scratch: string,
	signal?: AbortSignal,
): Promise<HistoryCapture> {
	const { root, head } = checkout;
	const unpushed = (await gitText(["rev-list", head, "--not", "--remotes"], { cwd: root, signal }))
		.split("\n")
		.filter(Boolean);
	if (unpushed.length === 0) return { bundle: null, omitted: [] };
	const sameHistory = (commits: readonly string[]) =>
		previous?.head === head && commits.length === unpushed.length && commits.every((c, i) => c === unpushed[i]);
	if (previous?.bundle && sameHistory(previous.bundle.commits)) return { bundle: previous.bundle, omitted: [] };
	const denied = await deniedHistory(root, unpushed, signal);
	if (denied.commits.length > 0) {
		return { bundle: null, omitted: [{ reason: "unpushed-history-denied", ...denied }] };
	}
	const file = join(scratch, "history.bundle");
	await runGit(["bundle", "create", "-q", file, "HEAD", "--not", "--remotes"], { cwd: root, signal });
	const data = new Uint8Array(await readFile(file));
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
 * changes the user's index, refs or files.
 */
export async function captureWorktreeSnapshot(
	dir: string,
	options: CaptureWorktreeSnapshotOptions = {},
): Promise<WorktreeSnapshotCapture> {
	if (typeof dir !== "string" || dir.length === 0) throw new WorkspaceConfigError("sdk", "dir", "a directory path");
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	if (!settings.enabled) return { status: "disabled" };
	try {
		return await captureCheckout(dir, settings, options);
	} catch (error) {
		if (isWorkspaceSnapshotError(error)) return { status: "unavailable", reason: error };
		throw error;
	}
}

async function captureCheckout(
	dir: string,
	settings: WorktreeSnapshotSettings,
	options: CaptureWorktreeSnapshotOptions,
): Promise<WorktreeSnapshotCapture> {
	const { signal } = options;
	const gitUnavailable = await installedGitUnavailable();
	if (gitUnavailable !== undefined) return { status: "unavailable", reason: gitUnavailable };
	const checkout = await locateCheckout(dir, signal);
	if (checkout instanceof Error) return { status: "unavailable", reason: checkout };
	const { root, head } = checkout;
	const candidate = options.previous?.root === root ? options.previous : undefined;
	const previous =
		candidate !== undefined &&
		options.blobs !== undefined &&
		!(await options.blobs.refreshBlobs(snapshotBlobHashes(candidate)))
			? undefined
			: candidate;
	return withScratchDirectory(async (scratch) => {
		const policy = await loadSnapshotPathPolicy(root);
		const state = await writeCapturedTree(
			checkout,
			settings,
			policy,
			scratch,
			resolve(defaultWorktreeSnapshotStoreDir()),
			signal,
		);
		const omissions = pathOmissionKeys(state.omitted);
		if (
			previous &&
			previous.head === head &&
			previous.tree === state.tree &&
			JSON.stringify(pathOmissionKeys(previous.omitted)) === JSON.stringify(omissions)
		) {
			return { status: "unchanged", snapshot: previous, binding: bindingOf(previous) };
		}
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
			omitted: [...state.omitted, ...history.omitted],
			filters: await readFilters(root, config, signal),
			capturedAt: new Date().toISOString(),
		};
		if (options.blobs) await options.blobs.putBlobs(blobs);
		return { status: "captured", snapshot, binding: bindingOf(snapshot), blobs };
	});
}
