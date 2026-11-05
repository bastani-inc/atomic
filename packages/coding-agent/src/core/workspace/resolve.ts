import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import { attachCleanupCause, WorkspaceBindingError, type WorkspaceGitPhase } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import { processAlive, withRepositoryLock } from "./lease.ts";
import { waitFor } from "./process.ts";
import { redactCredentials } from "./redact.ts";
import {
	assertWorkspace,
	classifyRepository,
	recordedRepo,
	type Workspace,
	type WorkspaceRepository,
	type WorkspaceSandbox,
} from "./spec.ts";

/**
 * The portable identity of a workspace from #4245's worktree snapshots: the remotes that hold its history, the commit
 * it is based on, the Git tree of its content and a fingerprint of its dependency inputs. Declared here with #4245's
 * exact fields until that change lands; its export then replaces this declaration.
 */
export interface WorkspaceBinding {
	remotes: string[];
	head: string;
	tree: string;
	envHash: string;
}

/** #4245's binding plus the repository, branch and worktree a workspace is bound to. */
export type WorktreeBinding = WorkspaceBinding & {
	readonly repo: string;
	readonly branch: string;
	readonly worktree: string;
};

/** A resolved workspace, as recorded in the journal and the session. JSON-safe and credential-free. */
export type BoundWorkspace = WorktreeBinding & {
	readonly kind: "bound-workspace";
	readonly version: 1;
	/** Directory git commands run in: the local repository root, or the shared object store of a remote. */
	readonly repository: string;
	readonly base: string;
	readonly baseCommit: string;
	readonly sandbox: WorkspaceSandbox;
	readonly label?: string;
};

export interface ResolveWorkspaceOptions {
	readonly signal?: AbortSignal;
}

/** A repository opened for binding: a local repository root or the shared store of a remote. */
export interface OpenRepository {
	readonly spec: WorkspaceRepository;
	/** Directory git commands run in. */
	readonly root: string;
	/** Canonical git common directory: the repository identity worktrees are checked against. */
	readonly commonDir: string;
	/** Set when this resolution created the shared store, so it is already fetched. */
	readonly fresh?: true;
}

const LOCKFILES = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"composer.lock",
	join(".devcontainer", "devcontainer.json"),
] as const;

const pendingClones = new Map<string, Promise<void>>();
const pendingWorktrees = new Map<string, Promise<void>>();

/** Atomic's home directory (`~/.atomic`), the parent of the agent directory. */
export function atomicHome(): string {
	return dirname(getAgentDir());
}

function safeSegment(segment: string): string {
	return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * A path segment that names `name` alone: kept when it is already safe, else made safe and suffixed with a digest of
 * `name`, so remotes whose names differ only in unsafe characters never share a store, and `.` or `..` never climb.
 */
function storeSegment(name: string): string {
	const safe = safeSegment(name);
	return safe === name && name !== "." && name !== ".." ? name : `${safe}-${shortDigest(name)}`;
}

function shortDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Where a remote lives under the Atomic home: `<host>/<path segments>`. A `file://` remote is named by its last
 * segment and a digest of its path instead, so a deeply nested source does not nest the store and its worktrees.
 */
function remoteKey(remote: Extract<WorkspaceRepository, { kind: "remote" }>): string[] {
	const segments = remote.segments.map(storeSegment);
	if (remote.host !== "file") return [storeSegment(remote.host), ...segments];
	return ["file", `${segments.at(-1)}-${shortDigest(remote.segments.join("/"))}`];
}

export function sharedStorePath(remote: Extract<WorkspaceRepository, { kind: "remote" }>): string {
	const key = remoteKey(remote);
	const last = key.pop()!;
	return join(atomicHome(), "repos", ...key, `${last}.git`);
}

function repositoryKey(spec: WorkspaceRepository, root: string): string[] {
	if (spec.kind === "remote") return remoteKey(spec);
	return ["local", `${safeSegment(basename(root))}-${shortDigest(root)}`];
}

/** Run a filesystem step; a failure with an errno code becomes a typed `filesystem-failed` binding error. */
async function filesystem<T>(operation: string, path: string, step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (error) {
		const errno = (error as { readonly code?: unknown }).code;
		if (typeof errno !== "string") throw error;
		throw new WorkspaceBindingError({ code: "filesystem-failed", fields: { operation, path, errno }, cause: error });
	}
}

function git(cwd: string, args: readonly string[], phase: WorkspaceGitPhase, signal?: AbortSignal) {
	return gitOutput({ cwd, args, phase, signal });
}

function probe(cwd: string, args: readonly string[], signal?: AbortSignal) {
	return runWorkspaceGit({ cwd, args, phase: "probe", allowFailure: true, signal });
}

async function canonical(path: string): Promise<string | undefined> {
	return existsSync(path) ? realpath(path) : undefined;
}

async function openLocal(
	spec: Extract<WorkspaceRepository, { kind: "local" }>,
	repo: string,
	signal?: AbortSignal,
): Promise<OpenRepository> {
	const notARepository = () =>
		new WorkspaceBindingError({ code: "invalid-repository", reason: "not-a-repository", fields: { repo } });
	const root = await canonical(spec.path);
	if (root === undefined) throw notARepository();
	const located = await probe(root, ["rev-parse", "--show-toplevel", "--git-common-dir"], signal);
	if (located.status !== 0) throw notARepository();
	const [toplevel = "", commonDir = ""] = located.stdout.trim().split("\n");
	const top = await realpath(toplevel);
	if (top !== root)
		throw new WorkspaceBindingError({
			code: "invalid-repository",
			reason: "not-a-repository-root",
			fields: { repo, actual: top },
		});
	return { spec, root, commonDir: await realpath(resolve(root, commonDir)) };
}

/**
 * Create the shared object store of a remote: a bare repository whose only branches are the remote's, tracked as
 * `origin/*`, so a later fetch updates every branch the store knows. Local branches appear only as worktrees need them.
 */
async function createStore(spec: Extract<WorkspaceRepository, { kind: "remote" }>, store: string): Promise<void> {
	const staging = `${store}.tmp-${randomUUID()}`;
	await filesystem("create directory", dirname(store), () => mkdir(dirname(store), { recursive: true }));
	try {
		await git(dirname(store), ["init", "--bare", staging], "clone");
		await git(staging, ["remote", "add", "origin", spec.url], "clone");
		await git(staging, ["fetch", "origin"], "fetch");
		// A remote whose HEAD names no branch still binds explicit refs; only a default base then fails.
		await runWorkspaceGit({
			cwd: staging,
			args: ["remote", "set-head", "origin", "--auto"],
			phase: "fetch",
			allowFailure: true,
		});
		await filesystem("move clone to", store, () => rename(staging, store));
	} catch (error) {
		const cleanupCause = await rm(staging, { recursive: true, force: true }).then(
			() => undefined,
			(cause: unknown) => cause,
		);
		if (existsSync(join(store, "HEAD"))) return;
		throw attachCleanupCause(error, cleanupCause);
	}
}

function shared<T>(pending: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
	let current = pending.get(key);
	if (current === undefined) {
		current = start().finally(() => pending.delete(key));
		pending.set(key, current);
	}
	return current;
}

async function openRemote(
	spec: Extract<WorkspaceRepository, { kind: "remote" }>,
	signal?: AbortSignal,
): Promise<OpenRepository> {
	const store = sharedStorePath(spec);
	if (existsSync(join(store, "HEAD"))) {
		const root = await realpath(store);
		return { spec, root, commonDir: root };
	}
	await waitFor(
		shared(pendingClones, store, () => createStore(spec, store)),
		signal,
	);
	const root = await realpath(store);
	return { spec, root, commonDir: root, fresh: true };
}

/** The commit `ref` names in `repository`, or undefined when it names none. */
export async function commitOf(repository: { readonly root: string }, ref: string): Promise<string | undefined> {
	const result = await probe(repository.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

async function isAncestor(repository: OpenRepository, ancestor: string, descendant: string): Promise<boolean> {
	return (await probe(repository.root, ["merge-base", "--is-ancestor", ancestor, descendant])).status === 0;
}

async function defaultBase(repository: OpenRepository, repo: string): Promise<string> {
	if (repository.spec.kind === "local") return "HEAD";
	const head = await probe(repository.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (head.status === 0) return head.stdout.trim();
	throw new WorkspaceBindingError({ code: "unknown-base", fields: { repo, base: "origin/HEAD" } });
}

async function currentBranch(worktree: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await probe(worktree, ["symbolic-ref", "--short", "HEAD"], signal);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

async function defaultBranch(repository: OpenRepository, repo: string, base: string): Promise<string> {
	if (repository.spec.kind === "remote") return base.replace(/^origin\//, "");
	const branch = await currentBranch(repository.root);
	if (branch === undefined)
		throw new WorkspaceBindingError({
			code: "wrong-branch",
			reason: "detached-head",
			fields: { repo, worktree: repository.root, expected: "a branch", actual: "detached HEAD" },
		});
	return branch;
}

/** Verify that `worktree` is a root worktree of `repository` checked out on `branch`. */
export async function verifyWorktree(
	repository: { readonly commonDir: string },
	repo: string,
	worktree: string,
	branch: string,
	signal?: AbortSignal,
): Promise<void> {
	const root = await realpath(worktree);
	const located = await probe(root, ["rev-parse", "--show-toplevel", "--git-common-dir"], signal);
	if (located.status !== 0)
		throw new WorkspaceBindingError({
			code: "wrong-repository",
			reason: "not-a-worktree",
			fields: { repo, worktree, expected: repository.commonDir, actual: "not a git worktree" },
		});
	const [toplevel = "", commonDir = ""] = located.stdout.trim().split("\n");
	const top = await realpath(toplevel);
	if (top !== root)
		throw new WorkspaceBindingError({
			code: "wrong-repository",
			reason: "not-a-worktree-root",
			fields: { repo, worktree, expected: root, actual: top },
		});
	const actual = await realpath(resolve(root, commonDir));
	if (actual !== repository.commonDir)
		throw new WorkspaceBindingError({
			code: "wrong-repository",
			reason: "different-repository",
			fields: { repo, worktree, expected: repository.commonDir, actual },
		});
	const current = await currentBranch(root, signal);
	if (current !== branch)
		throw new WorkspaceBindingError({
			code: "wrong-branch",
			reason: current === undefined ? "detached-head" : "different-branch",
			fields: { repo, worktree, expected: branch, actual: current ?? "detached HEAD" },
		});
}

interface ListedWorktree {
	readonly path: string;
	readonly branch?: string;
}

async function listWorktrees(repository: OpenRepository): Promise<ListedWorktree[]> {
	const output = await git(repository.root, ["worktree", "list", "--porcelain"], "validate");
	const worktrees: ListedWorktree[] = [];
	for (const block of output.split(/\n\n+/)) {
		const lines = block.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		if (path !== undefined) worktrees.push({ path, ...(branch !== undefined ? { branch } : {}) });
	}
	return worktrees;
}

/**
 * Check out `branch` at `path`. A store's local branch follows the remote: it starts from `origin/<branch>`, is
 * fast-forwarded when the remote is ahead, and is kept when it holds commits the remote lacks; a branch that diverged
 * from the remote fails closed. A local repository's branches are its own and are used as they are.
 */
async function checkoutBranch(
	repository: OpenRepository,
	repo: string,
	path: string,
	branch: string,
	missingBranchStart: () => Promise<string>,
	onSpawn: (pid: number) => void,
): Promise<void> {
	const local = await commitOf(repository, `refs/heads/${branch}`);
	const remote = await commitOf(repository, `refs/remotes/origin/${branch}`);
	const add = (args: readonly string[]) =>
		runWorkspaceGit({
			cwd: repository.root,
			args: ["worktree", "add", "--lock", "--reason", WORKTREE_ADDING_REASON, ...args],
			phase: "worktree-add",
			onSpawn,
		});
	if (local === undefined) {
		await add(["-b", branch, path, remote ?? (await missingBranchStart())]);
		return;
	}
	if (repository.spec.kind === "remote" && remote !== undefined && remote !== local) {
		if (await isAncestor(repository, local, remote))
			await git(repository.root, ["branch", "--force", branch, remote], "worktree-add");
		else if (!(await isAncestor(repository, remote, local)))
			throw new WorkspaceBindingError({
				code: "drift",
				reason: "branch-diverged",
				fields: { repo, repository: repository.root, branch, worktree: path, expected: remote, actual: local },
			});
	}
	await add([path, branch]);
}

/**
 * The reason Atomic locks a worktree with while adding it. Git writes it before the worktree's `.git` file and Atomic
 * unlocks only after the checkout finished, so a worktree still locked with it was never handed to anyone.
 */
export const WORKTREE_ADDING_REASON = "atomic workspace: adding";
/** The lock git itself writes while adding a worktree without `--lock` (untranslated). */
const GIT_ADDING_MARKER = "initializing";

type WorktreeState =
	| { readonly kind: "missing" }
	/** Settled: a worktree, or a directory `verifyWorktree` reports on. */
	| { readonly kind: "complete" }
	/** The directory exists but has no `.git` yet: an addition may be starting. */
	| { readonly kind: "unsettled" }
	| { readonly kind: "interrupted"; readonly adminDir: string; readonly marker: string }
	| { readonly kind: "orphaned"; readonly adminDir: string };

/**
 * The text of `file`, undefined when it does not exist, or `directory` when it is one. Another process may add or
 * remove these files at any moment, so they are read once rather than checked first.
 */
async function readState(file: string): Promise<string | undefined | "directory"> {
	try {
		return await readFile(file, "utf-8");
	} catch (error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === "ENOENT") return undefined;
		if (code === "EISDIR") return "directory";
		if (typeof code !== "string") throw error;
		throw new WorkspaceBindingError({
			code: "filesystem-failed",
			fields: { operation: "read", path: file, errno: code },
			cause: error,
		});
	}
}

/** What is at `path`, judged by its `.git` link into `repository` and that worktree's lock. */
async function worktreeState(repository: OpenRepository, path: string): Promise<WorktreeState> {
	if (!existsSync(path)) return { kind: "missing" };
	const link = await readState(join(path, ".git"));
	if (link === undefined) return { kind: "unsettled" };
	const gitdir = /^gitdir: (.+)$/m.exec(link)?.[1];
	if (gitdir === undefined) return { kind: "complete" };
	const adminDir = resolve(path, gitdir.trim());
	const parent = (await canonical(dirname(adminDir))) ?? dirname(adminDir);
	if (parent !== join(repository.commonDir, "worktrees")) return { kind: "complete" };
	if (!existsSync(adminDir)) return { kind: "orphaned", adminDir };
	const marker = (await readState(join(adminDir, "locked")))?.trim();
	return marker === WORKTREE_ADDING_REASON || marker === GIT_ADDING_MARKER
		? { kind: "interrupted", adminDir, marker }
		: { kind: "complete" };
}

/** The git process adding a worktree, recorded so a later bind can tell whether that addition is still running. */
interface WorktreeAdder {
	readonly host: string;
	readonly pid: number;
	/** When the platform reports it cheaply (Linux), so a later process given the same pid is not mistaken for it. */
	readonly startTime: string | null;
}

/** Where the adder of `path` is recorded: beside the repository's other locks, one file per worktree path. */
export function worktreeAdderRecord(commonDir: string, path: string): string {
	return join(commonDir, "atomic-worktree-adders", `${shortDigest(resolve(path))}.json`);
}

function processStartTime(pid: number): string | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch (error) {
		if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
		throw error;
	}
}

function recordAdder(record: string, pid: number): void {
	const adder: WorktreeAdder = { host: hostname(), pid, startTime: processStartTime(pid) };
	const staging = `${record}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(record), { recursive: true });
		writeFileSync(staging, JSON.stringify(adder));
		renameSync(staging, record);
	} catch (error) {
		const errno = (error as { readonly code?: unknown }).code;
		if (typeof errno !== "string") throw error;
		throw new WorkspaceBindingError({
			code: "filesystem-failed",
			fields: { operation: "record the git adding", path: record, errno },
			cause: error,
		});
	}
}

/**
 * The addition still running at `path`: its recorded adder while that process lives (one on another host cannot be
 * checked, so it counts as running), `null` when nothing names the adder but the checkout's index lock is still there,
 * or undefined when no addition can be running.
 */
async function runningAddition(
	repository: OpenRepository,
	path: string,
	adminDir: string,
): Promise<WorktreeAdder | null | undefined> {
	const recorded = await readState(worktreeAdderRecord(repository.commonDir, path));
	if (recorded === undefined || recorded === "directory")
		return existsSync(join(adminDir, "index.lock")) ? null : undefined;
	const adder = JSON.parse(recorded) as WorktreeAdder;
	if (adder.host !== hostname()) return adder;
	if (!processAlive(adder.pid)) return undefined;
	const startTime = processStartTime(adder.pid);
	return adder.startTime === null || startTime === null || startTime === adder.startTime ? adder : undefined;
}

let additionWait = { probes: 2_400, intervalMs: 250 };

/** Internal seam: how often, and how many times, a bind looks again at an addition another git is still running. */
export function setWorktreeAdditionWait(wait: { readonly probes: number; readonly intervalMs: number }): () => void {
	const previous = additionWait;
	additionWait = wait;
	return () => {
		additionWait = previous;
	};
}

function isAtomicWorktreePath(path: string): boolean {
	const inside = relative(join(atomicHome(), "worktrees"), path);
	return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * Remove what an interrupted addition left at `path`, so it can be added again. Atomic's own interrupted additions are
 * always removed; git's, and orphaned directories, only under Atomic's worktree directory, never at a caller's path.
 */
async function removeIncompleteWorktree(
	repository: OpenRepository,
	repo: string,
	path: string,
	branch: string,
	state: Extract<WorktreeState, { kind: "interrupted" | "orphaned" }>,
): Promise<WorktreeBusy | undefined> {
	const fields = {
		repo,
		repository: repository.root,
		branch,
		worktree: path,
		adminDir: state.adminDir,
		marker: state.kind === "interrupted" ? state.marker : "",
	};
	if (fields.marker !== WORKTREE_ADDING_REASON && !isAtomicWorktreePath(path))
		throw new WorkspaceBindingError({
			code: "incomplete-worktree",
			reason: state.kind === "orphaned" ? "orphaned-directory" : "interrupted-add",
			fields,
		});
	if (state.kind === "interrupted") {
		const adder = await runningAddition(repository, path, state.adminDir);
		if (adder !== undefined) return { fields, adder };
	}
	if (state.kind === "orphaned") {
		await filesystem("remove orphaned worktree", path, () => rm(path, { recursive: true }));
		return;
	}
	try {
		await git(repository.root, ["worktree", "remove", "--force", "--force", path], "worktree-add");
	} catch (error) {
		throw new WorkspaceBindingError({ code: "incomplete-worktree", reason: "repair-failed", fields, cause: error });
	}
	return undefined;
}

/** An interrupted addition that may still be running, so it must not be repaired yet. */
interface WorktreeBusy {
	readonly fields: Readonly<Record<string, string>>;
	readonly adder: WorktreeAdder | null;
}

function additionInProgress(busy: WorktreeBusy): WorkspaceBindingError {
	return new WorkspaceBindingError({
		code: "incomplete-worktree",
		reason: "addition-in-progress",
		fields: {
			...busy.fields,
			adderPid: busy.adder?.pid ?? null,
			adderHost: busy.adder?.host ?? null,
			adderStartTime: busy.adder?.startTime ?? null,
		},
	});
}

/**
 * Add `path` under the repository lock, removing an interrupted addition first. An addition whose git may still be
 * running is never removed: the lock is released, and the bind looks again until that git has exited or the wait
 * runs out, which fails with a retryable `addition-in-progress`.
 */
async function addWorktree(
	repository: OpenRepository,
	repo: string,
	path: string,
	branch: string,
	steps: EnsureWorktreeSteps,
): Promise<void> {
	for (let probe = 1; ; probe++) {
		const busy = await withRepositoryLock(repository.commonDir, async () => {
			const state = await worktreeState(repository, path);
			if (state.kind === "complete" || state.kind === "unsettled") return undefined;
			if (state.kind !== "missing") {
				const running = await removeIncompleteWorktree(repository, repo, path, branch, state);
				if (running !== undefined) return running;
			}
			if (repository.spec.kind === "remote" && repository.fresh !== true)
				await git(repository.root, ["fetch", "origin"], "fetch");
			await steps.prepare?.();
			await git(repository.root, ["worktree", "prune"], "worktree-add");
			const record = worktreeAdderRecord(repository.commonDir, path);
			try {
				await checkoutBranch(repository, repo, path, branch, steps.missingBranchStart, (pid) =>
					recordAdder(record, pid),
				);
				await git(repository.root, ["worktree", "unlock", path], "worktree-add");
			} catch (error) {
				const cleanupCause = await rm(record, { force: true }).then(
					() => undefined,
					(cause: unknown) => cause,
				);
				throw attachCleanupCause(error, cleanupCause);
			}
			await filesystem("remove the record of the git adding", record, () => rm(record, { force: true }));
			return undefined;
		});
		if (busy === undefined) return;
		if (probe >= additionWait.probes) throw additionInProgress(busy);
		await new Promise((resolveWait) => setTimeout(resolveWait, additionWait.intervalMs));
	}
}

export interface EnsureWorktreeSteps {
	/** Runs before a missing worktree is added, after a store fetch; a failure leaves nothing added. */
	readonly prepare?: () => Promise<unknown>;
	/** Commit a branch that exists neither locally nor on the remote starts from. */
	readonly missingBranchStart: () => Promise<string>;
}

/**
 * Make `path` a verified worktree of `repository` on `branch`, adding it when it is missing. One addition per path runs
 * in this process, and one repository change at a time across processes: the repository lock is held while a shared
 * store is fetched and the worktree is added, and a path another process finished adding meanwhile is used as it is.
 * A worktree is locked while it is added, so one that is still being added, or whose addition was interrupted, is
 * never used: the first waits for the lock, the second is removed and added again.
 */
export async function ensureWorktree(
	repository: OpenRepository,
	repo: string,
	path: string,
	branch: string,
	steps: EnsureWorktreeSteps,
	signal?: AbortSignal,
): Promise<string> {
	const pending = pendingWorktrees.get(path);
	if (pending !== undefined || (await worktreeState(repository, path)).kind !== "complete")
		await waitFor(
			pending ?? shared(pendingWorktrees, path, () => addWorktree(repository, repo, path, branch, steps)),
			signal,
		);
	await verifyWorktree(repository, repo, path, branch, signal);
	return realpath(path);
}

async function worktreePath(repository: OpenRepository, requested: string, branch: string): Promise<string> {
	if (requested !== "auto") return requested;
	const existing = (await listWorktrees(repository)).find(
		(candidate) => candidate.branch === branch && existsSync(candidate.path),
	);
	return existing?.path ?? join(atomicHome(), "worktrees", ...repositoryKey(repository.spec, repository.root), branch);
}

/** Snapshot tree of the working state (tracked and untracked, honouring ignores), without touching the real index. */
async function snapshotTree(worktree: string): Promise<string> {
	const index = join(tmpdir(), `atomic-workspace-${randomUUID()}.index`);
	const env = { GIT_INDEX_FILE: index };
	const run = (args: readonly string[]) => gitOutput({ cwd: worktree, args, phase: "snapshot", env });
	try {
		await run(["read-tree", "HEAD"]);
		await run(["add", "--all"]);
		return await run(["write-tree"]);
	} finally {
		await rm(index, { force: true });
	}
}

/** Every remote URL of the repository, credentials removed, sorted and without duplicates. */
export async function remotesOf(worktree: string, signal?: AbortSignal): Promise<string[]> {
	const result = await probe(worktree, ["config", "--get-regexp", "^remote\\..*\\.url$"], signal);
	const remotes = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		const match = /^remote\..+\.url (.+)$/.exec(line.trim());
		if (match !== null) remotes.add(redactCredentials(match[1]!));
	}
	return [...remotes].sort();
}

async function environmentHash(worktree: string): Promise<string> {
	const digest = createHash("sha256");
	for (const file of LOCKFILES) {
		const path = join(worktree, file);
		if (!existsSync(path)) continue;
		digest.update(
			`${file}\0${createHash("sha256")
				.update(await readFile(path))
				.digest("hex")}\n`,
		);
	}
	return digest.digest("hex");
}

/** Read the recorded fields of a bound worktree: HEAD, snapshot tree, remotes and environment hash. */
async function describeWorktree(
	worktree: string,
): Promise<Pick<WorktreeBinding, "head" | "tree" | "remotes" | "envHash">> {
	const head = await git(worktree, ["rev-parse", "HEAD"], "snapshot");
	const tree = await snapshotTree(worktree);
	return { head, tree, remotes: await remotesOf(worktree), envHash: await environmentHash(worktree) };
}

/** The commit `base` names. In a shared store, the name of a remote branch means that branch as the remote has it. */
async function resolveBase(repository: OpenRepository, repo: string, base: string): Promise<string> {
	const remoteBranch =
		repository.spec.kind === "remote" && !base.startsWith("origin/")
			? await commitOf(repository, `refs/remotes/origin/${base}`)
			: undefined;
	const tip = remoteBranch ?? (await commitOf(repository, base));
	if (tip !== undefined) return tip;
	throw new WorkspaceBindingError({ code: "unknown-base", fields: { repo, base } });
}

async function mergeBase(worktree: string, baseTip: string): Promise<string> {
	const merged = await probe(worktree, ["merge-base", baseTip, "HEAD"]);
	return merged.status === 0 ? merged.stdout.trim() : baseTip;
}

/** Open the repository a workspace names: validate a local root, or clone a remote once into the shared store. */
export async function openWorkspaceRepository(repo: string, signal?: AbortSignal): Promise<OpenRepository> {
	const spec = classifyRepository(repo);
	if (spec === undefined)
		throw new WorkspaceBindingError({
			code: "invalid-repository",
			reason: "not-a-repository",
			fields: { repo: recordedRepo(repo) },
		});
	return spec.kind === "local" ? openLocal(spec, recordedRepo(repo), signal) : openRemote(spec, signal);
}

interface Resolution {
	readonly binding: BoundWorkspace;
	readonly commonDir: string;
}

/** One resolution per workspace value: every session, task and child bound to the same value shares it. */
const resolutions = new WeakMap<Workspace, Promise<Resolution>>();

async function bindNew(input: Workspace): Promise<Resolution> {
	const repo = recordedRepo(input.repo);
	const repository = await openWorkspaceRepository(input.repo);
	const base = input.base ?? (await defaultBase(repository, repo));
	const branch = input.branch ?? (await defaultBranch(repository, repo, base));
	let baseTip: Promise<string> | undefined;
	const tipOfBase = () => {
		baseTip ??= resolveBase(repository, repo, base);
		return baseTip;
	};
	const path = await worktreePath(repository, input.worktree ?? "auto", branch);
	const worktree = await ensureWorktree(repository, repo, path, branch, {
		prepare: tipOfBase,
		missingBranchStart: tipOfBase,
	});
	const described = await describeWorktree(worktree);
	const binding: BoundWorkspace = Object.freeze({
		kind: "bound-workspace",
		version: 1,
		repo,
		repository: repository.root,
		branch,
		worktree,
		base,
		baseCommit: await mergeBase(worktree, await tipOfBase()),
		sandbox: input.sandbox,
		...(input.label !== undefined ? { label: input.label } : {}),
		...described,
	});
	return { binding, commonDir: repository.commonDir };
}

/** Make later resolutions of `input` return `binding`, a binding restored from a record instead of resolved anew. */
export function adoptWorkspaceBinding(input: Workspace, binding: BoundWorkspace, commonDir: string): void {
	resolutions.set(input, Promise.resolve({ binding, commonDir }));
}

/**
 * Resolve a workspace to a verified worktree. A local repository must be a repository root; a remote is cloned once
 * per host into `<atomic home>/repos/…` and worktrees are added from that store, which is fetched before each addition
 * so a branch starts from the remote's latest commits. A missing branch is created from `base`. An existing worktree
 * must belong to the repository and be on the branch. The same workspace value resolves
 * once; later calls re-verify that worktree. A resolved binding is returned as is. Cancelling `signal` stops waiting
 * with `signal.reason`; shared git work started for other callers runs to completion.
 */
export async function resolveWorkspace(
	input: Workspace | BoundWorkspace,
	options: ResolveWorkspaceOptions = {},
): Promise<BoundWorkspace> {
	if (isBoundWorkspace(input)) return input;
	assertWorkspace(input, "workspace");
	const { signal } = options;
	await assertWorkspaceGitAvailable(signal);
	const pending = resolutions.get(input);
	if (pending !== undefined) {
		const { binding, commonDir } = await waitFor(pending, signal);
		if (existsSync(binding.worktree)) {
			await verifyWorktree({ commonDir }, binding.repo, binding.worktree, binding.branch, signal);
			return binding;
		}
	}
	const started = bindNew(input);
	resolutions.set(input, started);
	started.catch(() => resolutions.delete(input));
	return (await waitFor(started, signal)).binding;
}

export function isBoundWorkspace(value: unknown): value is BoundWorkspace {
	const candidate = value as Partial<BoundWorkspace> | null | undefined;
	return candidate?.kind === "bound-workspace" && typeof candidate.worktree === "string";
}
