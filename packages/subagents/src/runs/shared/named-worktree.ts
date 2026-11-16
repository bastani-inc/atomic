import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { ensureWorktreeIgnore, resolveRepoCwdRelative, runGit } from "./worktree.js";
import { findCanonicalGitRoot } from "./worktree-root.js";

export interface NamedWorktreeRequest {
	readonly branch: string;
	readonly base?: string;
	readonly path?: string;
}

export interface NamedWorktree {
	readonly repo: string;
	readonly path: string;
	readonly agentCwd: string;
	readonly branch: string;
	readonly baseCommit: string;
}

interface ListedWorktree {
	readonly path: string;
	readonly branch?: string;
}

const CONCURRENT_ADD_WAIT_MS = 30_000;
const CONCURRENT_ADD_POLL_MS = 100;
const INHERITED_LOCKS_ENV = "ATOMIC_NAMED_WORKTREE_LOCKS";
const CONCURRENT_GIT_FAILURE =
	/failed to read ['"].*[/\\]locked['"]|\.lock['"]?: File exists|another git process|cannot lock references/i;
const CONCURRENT_ADD_FAILURE = /already exists|already checked out|already used by worktree|is a missing but/i;

class GitFailure extends Error {}

export class WorktreeBusyError extends Error {
	constructor(worktreePath: string, indexLock: string | null) {
		super(
			`worktree: another git process seems to be running at ${worktreePath}. Wait for it to finish and retry. ${
				indexLock === null
					? "If no git process is running, inspect this incomplete worktree with git worktree list and repair it before retrying."
					: `If no git process is running, remove ${indexLock} and retry.`
			}`,
		);
		this.name = "WorktreeBusyError";
	}
}

function gitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0)
		throw new GitFailure(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function comparablePath(value: string): string {
	const resolved = path.resolve(value);
	let canonical: string;
	try {
		canonical = fs.realpathSync(resolved);
	} catch {
		const parent = path.dirname(resolved);
		canonical = parent === resolved ? resolved : path.join(comparablePath(parent), path.basename(resolved));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function checkoutBlocker(gitDir: string): string | null | undefined {
	const indexLock = path.join(gitDir, "index.lock");
	if (fs.existsSync(indexLock)) return indexLock;
	if (/^(?:0{40}|0{64})$/.test(fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim())) return null;
	return undefined;
}

function targetCheckoutBlocker(commonDir: string, worktreePath: string): string | null | undefined {
	if (comparablePath(path.join(worktreePath, ".git")) === comparablePath(commonDir)) return checkoutBlocker(commonDir);
	let ids: string[];
	const admin = path.join(commonDir, "worktrees");
	try {
		ids = fs.readdirSync(admin);
	} catch {
		return undefined;
	}
	const target = comparablePath(path.join(worktreePath, ".git"));
	for (const id of ids) {
		const entry = path.join(admin, id);
		try {
			const gitdir = fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim();
			if (comparablePath(path.resolve(entry, gitdir)) !== target) continue;
			return checkoutBlocker(entry);
		} catch {}
	}
	return undefined;
}

function lockPaths(commonDir: string, branch: string, worktreePath: string): string[] {
	const lockDir = path.join(comparablePath(commonDir), "worktrees", ".atomic-named-worktree-locks");
	fs.mkdirSync(lockDir, { recursive: true });
	const key = (kind: string, value: string): string =>
		path.join(lockDir, `${kind}-${createHash("sha256").update(value).digest("hex")}.lock`);
	return [
		key("path", comparablePath(worktreePath)),
		key("branch", process.platform === "win32" ? branch.toLowerCase() : branch),
	];
}

async function withTargetLocks<T>(paths: string[], create: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
	const inherited: string[] = JSON.parse(process.env[INHERITED_LOCKS_ENV] ?? "[]");
	if (inherited.some((lockPath) => path.dirname(lockPath) === path.dirname(paths[0]!)))
		throw new Error(
			"worktree: a checkout hook cannot synchronously create another named worktree in the same repository. Finish the current checkout and retry outside the hook.",
		);
	const held: NonNullable<ReturnType<typeof tryAdvisoryLock>>[] = [];
	try {
		for (const lockPath of paths) {
			let lock = tryAdvisoryLock(lockPath, 0);
			while (lock === null) {
				await sleep(CONCURRENT_ADD_POLL_MS);
				lock = tryAdvisoryLock(lockPath, 0);
			}
			held.push(lock);
		}
		return await create({ [INHERITED_LOCKS_ENV]: JSON.stringify([...inherited, ...paths]) });
	} finally {
		for (const lock of held.reverse()) lock.release();
	}
}

function listWorktrees(repo: string): ListedWorktree[] {
	const listed: ListedWorktree[] = [];
	for (const block of gitChecked(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		if (!worktreePath) continue;
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		listed.push({ path: worktreePath, ...(branch ? { branch } : {}) });
	}
	return listed;
}

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

export async function ensureNamedWorktree(cwd: string, request: NamedWorktreeRequest): Promise<NamedWorktree> {
	const branch = request.branch;
	const formatted = runGit(cwd, ["check-ref-format", "--branch", branch]);
	if (formatted.status !== 0 || formatted.stdout.trim() !== branch || branch.includes("@{"))
		throw new Error(`worktree.branch "${request.branch}" is not a valid branch name.`);
	let deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
	const waiting = (): boolean => performance.now() < deadline;
	const failed = (what: string, error: unknown): Error => {
		if (!(error instanceof GitFailure) && error instanceof Error && error.message.startsWith("worktree"))
			return error;
		const detail = error instanceof Error ? error.message : String(error);
		return new Error(`worktree: ${what}: ${detail}`, { cause: error });
	};
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
	const { cwdRelative, repo, commonDir } = await retried(`could not find the repository of ${cwd}`, () => {
		const cwdRelative = resolveRepoCwdRelative(cwd);
		const toplevel = path.resolve(gitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim());
		const repo = findCanonicalGitRoot(toplevel);
		if (repo === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
		const commonDir = path.resolve(repo, gitChecked(repo, ["rev-parse", "--git-common-dir"]).trim());
		return { cwdRelative, repo, commonDir };
	});
	const defaultPath = request.path === undefined;
	const worktreePath = defaultPath
		? path.join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"))
		: path.resolve(cwd, request.path!);
	const checkingOut = `could not check out branch "${branch}" at ${worktreePath}`;
	try {
		return await withTargetLocks(lockPaths(commonDir, branch, worktreePath), async (env) => {
			deadline = performance.now() + CONCURRENT_ADD_WAIT_MS;
			const ready = async (): Promise<NamedWorktree> => ({
				repo,
				path: worktreePath,
				agentCwd: withAgentCwd(worktreePath, cwdRelative),
				branch,
				baseCommit: await retried(checkingOut, () =>
					gitChecked(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
				),
			});
			let addFailure: { message: string; branchExisted: boolean } | undefined;
			for (;;) {
				let decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
				if (decision.kind === "wait" && !waiting())
					decision = await retried(checkingOut, () => decideWorktree(repo, commonDir, branch, worktreePath));
				if (decision.kind === "wait") {
					if (!waiting()) throw new WorktreeBusyError(worktreePath, decision.indexLock);
					await sleep(CONCURRENT_ADD_POLL_MS);
					continue;
				}
				if (decision.kind === "reuse") return ready();
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
					env,
				);
				if (added.status === 0) return ready();
				addFailure = {
					message: added.stderr.trim() || added.stdout.trim() || "git worktree add failed",
					branchExisted: branchExists,
				};
				await sleep(CONCURRENT_ADD_POLL_MS);
			}
		});
	} catch (error) {
		throw failed(checkingOut, error);
	}
}

type WorktreeDecision = { kind: "reuse" | "create" } | { kind: "wait"; indexLock: string | null };

function decideWorktree(repo: string, commonDir: string, branch: string, worktreePath: string): WorktreeDecision {
	const before = targetCheckoutBlocker(commonDir, worktreePath);
	if (before !== undefined) return { kind: "wait", indexLock: before };
	const target = comparablePath(worktreePath);
	const worktrees = listWorktrees(repo);
	const after = targetCheckoutBlocker(commonDir, worktreePath);
	if (after !== undefined) return { kind: "wait", indexLock: after };
	const atPath = worktrees.find((worktree) => comparablePath(worktree.path) === target);
	if (atPath?.branch === branch) return { kind: "reuse" };
	const elsewhere = worktrees.find((worktree) => worktree.branch === branch);
	if (elsewhere)
		throw new Error(
			`worktree: branch "${branch}" is already checked out at ${path.resolve(elsewhere.path)}, so it cannot be checked out at ${worktreePath}. Pass that path as worktree.path to reuse it, or name another branch.`,
		);
	if (atPath || (fs.existsSync(worktreePath) && !isEmptyDirectory(worktreePath)))
		throw new Error(
			`worktree: ${worktreePath} already exists and is not the worktree of branch "${branch}". Choose another worktree.path or branch.`,
		);
	return { kind: "create" };
}
