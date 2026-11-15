import * as fs from "node:fs";
import * as path from "node:path";
import { ensureWorktreeIgnore, resolveRepoCwdRelative, runGit, runGitChecked } from "./worktree.js";
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
	for (const block of runGitChecked(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!worktreePath) continue;
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		listed.push({ path: worktreePath, ...(branch ? { branch } : {}) });
	}
	return listed;
}

/** Where a new branch starts when the launch names no base: HEAD's upstream, or HEAD. */
function defaultBase(cwd: string): string {
	const upstream = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	return upstream.status === 0 && upstream.stdout.trim() ? upstream.stdout.trim() : "HEAD";
}

function isEmptyDirectory(target: string): boolean {
	return fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0;
}

function withAgentCwd(worktreePath: string, cwdRelative: string): string {
	if (!cwdRelative) return worktreePath;
	const nested = path.join(worktreePath, cwdRelative);
	return fs.existsSync(nested) ? nested : worktreePath;
}

/**
 * Check out `request.branch` in a worktree at `request.path` (default `.atomic/worktrees/<branch>` in the repository
 * `cwd` is in) before a child starts in it (#5202). The worktree is reused when that branch is already checked out
 * there; a new branch starts at `request.base`, else HEAD's upstream, else HEAD; an existing branch is checked out as
 * it is. Throws, creating nothing, when the branch is checked out elsewhere or the path holds something else.
 */
export function ensureNamedWorktree(cwd: string, request: NamedWorktreeRequest): NamedWorktree {
	const branch = request.branch.trim();
	if (!branch || runGit(cwd, ["check-ref-format", "--branch", branch]).status !== 0)
		throw new Error(`worktree.branch "${request.branch}" is not a valid branch name.`);
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = path.resolve(runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim());
	const repo = findCanonicalGitRoot(toplevel);
	if (repo === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
	const defaultPath = request.path === undefined;
	const worktreePath = defaultPath
		? path.join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"))
		: path.resolve(cwd, request.path!);
	const target = comparablePath(worktreePath);
	const worktrees = listWorktrees(repo);
	const atPath = worktrees.find((worktree) => comparablePath(worktree.path) === target);
	if (atPath?.branch === branch) {
		const baseCommit = runGitChecked(worktreePath, ["rev-parse", "HEAD"]).trim();
		return { repo, path: worktreePath, agentCwd: withAgentCwd(worktreePath, cwdRelative), branch, baseCommit };
	}
	const elsewhere = worktrees.find((worktree) => worktree.branch === branch);
	if (elsewhere)
		throw new Error(
			`worktree: branch "${branch}" is already checked out at ${path.resolve(elsewhere.path)}, so it cannot be checked out at ${worktreePath}. Pass that path as worktree.path to reuse it, or name another branch.`,
		);
	if (atPath || (fs.existsSync(worktreePath) && !isEmptyDirectory(worktreePath)))
		throw new Error(
			`worktree: ${worktreePath} already exists and is not the worktree of branch "${branch}". Choose another worktree.path or branch.`,
		);
	if (defaultPath) ensureWorktreeIgnore(repo);
	const branchExists = runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
	runGitChecked(
		repo,
		branchExists
			? ["worktree", "add", worktreePath, branch]
			: ["worktree", "add", "--no-track", "-b", branch, worktreePath, request.base ?? defaultBase(cwd)],
	);
	const baseCommit = runGitChecked(worktreePath, ["rev-parse", "HEAD"]).trim();
	return { repo, path: worktreePath, agentCwd: withAgentCwd(worktreePath, cwdRelative), branch, baseCommit };
}
