import * as fs from "node:fs";
import * as path from "node:path";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { ensureWorktreeIgnore, resolveRepoCwdRelative, runGit } from "./worktree.js";
import { findCanonicalGitRoot } from "./worktree-root.js";

/** A worktree the caller names for a launch (#5202): its branch, where the branch starts, and where it is checked out. */
export interface NamedWorktreeRequest {
	readonly branch: string;
	readonly base?: string;
	readonly path?: string;
}

/** A named worktree, ready for a child: the caller's, so it is never removed with the run. */
export interface NamedWorktree {
	/** The repository's main checkout. */
	readonly repo: string;
	readonly path: string;
	/** Where the child runs: the worktree, or the same subdirectory of it the launch's cwd is of the repository. */
	readonly agentCwd: string;
	readonly branch: string;
	/** The commit the worktree was at when the launch found or created it. */
	readonly baseCommit: string;
}

interface ListedWorktree {
	readonly path: string;
	readonly branch?: string;
	readonly locked: boolean;
}

/** How long a launch tries again a git failure that looks like another git command's lock. */
const CONCURRENT_ADD_WAIT_MS = 30_000;
const CONCURRENT_ADD_POLL_MS = 100;
/**
 * How old the `locked` marker of a `git worktree add` can be and still be an add in progress, waited for however long
 * this launch has taken so far. An older one is left by a git that did not finish, and is decided on as it is.
 */
const ADD_IN_PROGRESS_MAX_AGE_MS = 10 * 60_000;

/**
 * A git failure a concurrent `git worktree add` causes: its `locked` marker read as it vanishes, an index.lock, or a
 * ref lock. Worth trying again once that add is done.
 */
const CONCURRENT_GIT_FAILURE = /failed to read ['"].*[/\\]locked['"]|\.lock['"]?: File exists|another git process/i;

/**
 * A `git worktree add` failure another launch's add of the same branch or path causes: the branch it just created, or
 * the worktree it is creating, found by this add. Deciding again sees what that launch made.
 */
const CONCURRENT_ADD_FAILURE = /already exists|already checked out|already used by worktree|is a missing but/i;

/** A git command that failed, with git's own message. */
class GitFailure extends Error {}

function gitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0)
		throw new GitFailure(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a `git worktree add` is mid-way in `repo`: its `locked` marker is there, recent, and its checkout not yet
 * done.
 */
function worktreeAddInProgress(repo: string): boolean {
	const admin = path.join(repo, ".git", "worktrees");
	let ids: string[];
	try {
		ids = fs.readdirSync(admin);
	} catch {
		return false;
	}
	return ids.some((id) => {
		try {
			const locked = fs.statSync(path.join(admin, id, "locked"));
			return (
				Date.now() - locked.mtimeMs < ADD_IN_PROGRESS_MAX_AGE_MS && !fs.existsSync(path.join(admin, id, "index"))
			);
		} catch {
			return false;
		}
	});
}

async function withAddLock<T>(repo: string, create: () => Promise<T>): Promise<T> {
	const commonDir = path.resolve(repo, gitChecked(repo, ["rev-parse", "--git-common-dir"]).trim());
	const lockPath = path.join(commonDir, "atomic-named-worktree.lock");
	const deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
	let lock = tryAdvisoryLock(lockPath, 0);
	while (lock === null) {
		if (performance.now() >= deadline)
			throw new Error(
				`worktree: timed out waiting for named-worktree creation in ${repo}. Wait for the current checkout to finish and retry; checkout hooks must not synchronously create another named worktree.`,
			);
		await sleep(CONCURRENT_ADD_POLL_MS);
		lock = tryAdvisoryLock(lockPath, 0);
	}
	try {
		return await create();
	} finally {
		lock.release();
	}
}

function comparablePath(value: string): string {
	let resolved = path.resolve(value);
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		/* not there (yet) */
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function listWorktrees(repo: string): ListedWorktree[] {
	const listed: ListedWorktree[] = [];
	for (const block of gitChecked(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!worktreePath) continue;
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		const locked = lines.some((line) => line === "locked" || line.startsWith("locked "));
		listed.push({ path: worktreePath, ...(branch ? { branch } : {}), locked });
	}
	return listed;
}

/** Where a new branch starts when the launch names no base: HEAD's upstream, or HEAD. */
function defaultBase(cwd: string): string {
	const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return upstream.status === 0 ? upstream.stdout.trim() : "HEAD";
}

function isEmptyDirectory(target: string): boolean {
	return fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0;
}

function withAgentCwd(worktreePath: string, cwdRelative: string): string {
	const nested = path.join(worktreePath, cwdRelative);
	return fs.existsSync(nested) ? nested : worktreePath;
}

/**
 * Check out `request.branch` in a worktree at `request.path` (default `.atomic/worktrees/<branch>` in the repository
 * `cwd` is in) before a child starts in it (#5202). The worktree is reused when that branch is already checked out
 * there; a new branch starts at `request.base`, else HEAD's upstream, else HEAD; an existing branch is checked out as
 * it is. Throws, creating nothing, when the branch is checked out elsewhere or the path holds something else.
 *
 * Concurrent launches of one branch are expected: while another launch's `git worktree add` is in progress, however
 * long it takes, a git failure it causes is tried again and the decision to reuse, refuse or create is made again once
 * it is done. Any git failure left is reported as a `worktree: …` error with git's message as its cause.
 */
export async function ensureNamedWorktree(cwd: string, request: NamedWorktreeRequest): Promise<NamedWorktree> {
	const branch = request.branch;
	// `--branch` expands names such as `@{-1}`: only a name that is its own branch name is accepted.
	const formatted = runGit(cwd, ["check-ref-format", "--branch", branch]);
	if (formatted.status !== 0 || formatted.stdout.trim() !== branch || branch.includes("@{"))
		throw new Error(`worktree.branch "${request.branch}" is not a valid branch name.`);
	const deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
	let repoOfAdds: string | undefined;
	/** Whether a failure may yet clear: briefly, and for as long as another launch's worktree add is in progress. */
	const waiting = (): boolean =>
		performance.now() < deadline || (repoOfAdds !== undefined && worktreeAddInProgress(repoOfAdds));
	const failed = (what: string, error: unknown): Error => {
		if (!(error instanceof GitFailure) && error instanceof Error && error.message.startsWith("worktree"))
			return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new Error(`worktree: ${what}: ${detail}`, { cause: error });
	};
	/** `attempt`, tried again while a failure looks like another git command's lock, until the wait is over. */
	const retried = async <T>(what: string, attempt: () => T | Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await attempt();
			} catch (error) {
				const wrapped = failed(what, error);
				if (!(error instanceof GitFailure) || !CONCURRENT_GIT_FAILURE.test(error.message) || !waiting())
					throw wrapped;
				await sleep(CONCURRENT_ADD_POLL_MS);
			}
		}
	};
	const { cwdRelative, repo } = await retried(`could not find the repository of ${cwd}`, () => {
		const cwdRelative = resolveRepoCwdRelative(cwd);
		const toplevel = path.resolve(gitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim());
		const repo = findCanonicalGitRoot(toplevel);
		if (repo === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
		return { cwdRelative, repo };
	});
	repoOfAdds = repo;
	const defaultPath = request.path === undefined;
	const worktreePath = defaultPath
		? path.join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"))
		: path.resolve(cwd, request.path!);
	const checkingOut = `could not check out branch "${branch}" at ${worktreePath}`;
	const ready = async (): Promise<NamedWorktree> => ({
		repo,
		path: worktreePath,
		agentCwd: withAgentCwd(worktreePath, cwdRelative),
		branch,
		baseCommit: await retried(checkingOut, () => gitChecked(worktreePath, ["rev-parse", "HEAD"]).trim()),
	});
	// Reused, or refused, without waiting for other launches' adds; created one launch at a time.
	if ((await retried(checkingOut, () => decideWorktree(repo, branch, worktreePath))) === "reuse") return ready();
	return retried(checkingOut, () =>
		withAddLock(repo, async () => {
			let addFailure: { message: string; branchExisted: boolean } | undefined;
			for (;;) {
				const decision = await retried(checkingOut, () => decideWorktree(repo, branch, worktreePath));
				if (decision === "reuse") return ready();
				if (decision === "wait") {
					await sleep(CONCURRENT_ADD_POLL_MS);
					continue;
				}
				const branchExists = runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
				if (
					addFailure !== undefined &&
					(!waiting() ||
						(!CONCURRENT_GIT_FAILURE.test(addFailure.message) &&
							(branchExists === addFailure.branchExisted || !CONCURRENT_ADD_FAILURE.test(addFailure.message))))
				)
					throw failed(checkingOut, new GitFailure(addFailure.message));
				if (defaultPath) await retried(checkingOut, () => ensureWorktreeIgnore(repo));
				const added = runGit(
					repo,
					branchExists
						? ["worktree", "add", worktreePath, branch]
						: ["worktree", "add", "--no-track", "-b", branch, worktreePath, request.base ?? defaultBase(cwd)],
				);
				if (added.status === 0) return ready();
				// A git outside Atomic may be checking the branch out there meanwhile: decide again.
				addFailure = {
					message: added.stderr.trim() || added.stdout.trim() || "git worktree add failed",
					branchExisted: branchExists,
				};
				if (!waiting()) throw failed(checkingOut, new GitFailure(addFailure.message));
				await sleep(CONCURRENT_ADD_POLL_MS);
			}
		}),
	);
}

/**
 * Whether `branch` is already checked out at `worktreePath`, to be reused, or still to be created. An add another
 * launch has in progress is waited for rather than reused half-done or refused. Throws when the branch is checked out
 * elsewhere, or the path holds something else.
 */
function decideWorktree(repo: string, branch: string, worktreePath: string): "reuse" | "create" | "wait" {
	const target = comparablePath(worktreePath);
	// Checked before the listing too: an add that finishes between the two leaves a listing older than the check.
	const inProgressBefore = worktreeAddInProgress(repo);
	const worktrees = listWorktrees(repo);
	const atPath = worktrees.find((worktree) => comparablePath(worktree.path) === target);
	const inProgress = inProgressBefore || worktreeAddInProgress(repo);
	if (atPath?.branch === branch) return atPath.locked && inProgress ? "wait" : "reuse";
	const elsewhere = worktrees.find((worktree) => worktree.branch === branch);
	if (elsewhere)
		throw new Error(
			`worktree: branch "${branch}" is already checked out at ${path.resolve(elsewhere.path)}, so it cannot be checked out at ${worktreePath}. Pass that path as worktree.path to reuse it, or name another branch.`,
		);
	if (atPath || (fs.existsSync(worktreePath) && !isEmptyDirectory(worktreePath))) {
		if (inProgress) return "wait";
		// The path is refused only when a listing taken after no add was in progress still shows it on another branch.
		const again = listWorktrees(repo).find((worktree) => comparablePath(worktree.path) === target);
		if (again?.branch !== atPath?.branch || again?.locked !== atPath?.locked) return "wait";
		throw new Error(
			`worktree: ${worktreePath} already exists and is not the worktree of branch "${branch}". Choose another worktree.path or branch.`,
		);
	}
	return "create";
}
