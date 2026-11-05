import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { attachCleanupCause, WorkspaceBindingError, type WorkspaceGitPhase } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
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

interface OpenRepository {
	readonly spec: WorkspaceRepository;
	/** Directory git commands run in. */
	readonly root: string;
	/** Canonical git common directory: the repository identity worktrees are checked against. */
	readonly commonDir: string;
	/** Set when this resolution cloned the shared store, so it is already fresh. */
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
const pendingFetches = new Map<string, Promise<void>>();
const pendingWorktrees = new Map<string, Promise<void>>();

/** Atomic's home directory (`~/.atomic`), the parent of the agent directory. */
export function atomicHome(): string {
	return dirname(getAgentDir());
}

function safeSegment(segment: string): string {
	return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Shared object store for a remote: one bare clone per repository per host. */
export function sharedStorePath(remote: Extract<WorkspaceRepository, { kind: "remote" }>): string {
	const segments = remote.segments.map(safeSegment);
	const last = segments.pop()!;
	return join(atomicHome(), "repos", safeSegment(remote.host), ...segments, `${last}.git`);
}

function repositoryKey(spec: WorkspaceRepository, root: string): string[] {
	if (spec.kind === "remote") return [safeSegment(spec.host), ...spec.segments.map(safeSegment)];
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return ["local", `${safeSegment(basename(root))}-${digest}`];
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

async function cloneStore(spec: Extract<WorkspaceRepository, { kind: "remote" }>, store: string): Promise<void> {
	const staging = `${store}.tmp-${randomUUID()}`;
	await filesystem("create directory", dirname(store), () => mkdir(dirname(store), { recursive: true }));
	try {
		await git(dirname(store), ["clone", "--bare", spec.url, staging], "clone");
		await git(staging, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], "clone");
		await git(staging, ["fetch", "origin"], "fetch");
		await filesystem("rename", staging, () => rename(staging, store));
	} catch (error) {
		const cleanupCause = await rm(staging, { recursive: true, force: true }).then(
			() => undefined,
			(cause: unknown) => cause,
		);
		if (existsSync(join(store, "HEAD"))) return;
		throw attachCleanupCause(error, cleanupCause);
	}
}

/** Shared work keeps running for other waiters; each waiter stops waiting when its own signal aborts. */
function waitFor<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return shared;
	signal.throwIfAborted();
	return new Promise<T>((resolvePromise, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		shared.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
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
		shared(pendingClones, store, () => cloneStore(spec, store)),
		signal,
	);
	const root = await realpath(store);
	return { spec, root, commonDir: root, fresh: true };
}

function fetchStore(repository: OpenRepository): Promise<void> {
	return shared(pendingFetches, repository.root, async () => {
		await git(repository.root, ["fetch", "origin"], "fetch");
	});
}

async function commitOf(repository: OpenRepository, ref: string): Promise<string | undefined> {
	const result = await probe(repository.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

async function defaultBase(repository: OpenRepository): Promise<string> {
	if (repository.spec.kind === "local") return "HEAD";
	return `origin/${await git(repository.root, ["symbolic-ref", "--short", "HEAD"], "validate")}`;
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

async function addWorktree(repository: OpenRepository, path: string, branch: string, baseTip: string): Promise<void> {
	await filesystem("create directory", dirname(path), () => mkdir(dirname(path), { recursive: true }));
	await git(repository.root, ["worktree", "prune"], "worktree-add");
	if ((await commitOf(repository, `refs/heads/${branch}`)) !== undefined) {
		await git(repository.root, ["worktree", "add", path, branch], "worktree-add");
		return;
	}
	const start = (await commitOf(repository, `refs/remotes/origin/${branch}`)) ?? baseTip;
	await git(repository.root, ["worktree", "add", "-b", branch, path, start], "worktree-add");
}

async function bindWorktree(
	repository: OpenRepository,
	repo: string,
	requested: string,
	branch: string,
	baseTip: string,
): Promise<string> {
	let path = requested;
	if (requested === "auto") {
		const existing = (await listWorktrees(repository)).find(
			(candidate) => candidate.branch === branch && existsSync(candidate.path),
		);
		path =
			existing?.path ?? join(atomicHome(), "worktrees", ...repositoryKey(repository.spec, repository.root), branch);
	}
	const pending = pendingWorktrees.get(path);
	if (pending !== undefined || !existsSync(path))
		await (pending ?? shared(pendingWorktrees, path, () => addWorktree(repository, path, branch, baseTip)));
	await verifyWorktree(repository, repo, path, branch);
	return realpath(path);
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

async function resolveBase(repository: OpenRepository, repo: string, base: string): Promise<string> {
	const tip = await commitOf(repository, base);
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
	const base = input.base ?? (await defaultBase(repository));
	const branch = input.branch ?? (await defaultBranch(repository, repo, base));
	if (
		repository.spec.kind === "remote" &&
		!repository.fresh &&
		(await commitOf(repository, `refs/heads/${branch}`)) === undefined
	)
		await fetchStore(repository);
	const baseTip = await resolveBase(repository, repo, base);
	const worktree = await bindWorktree(repository, repo, input.worktree ?? "auto", branch, baseTip);
	const described = await describeWorktree(worktree);
	const binding: BoundWorkspace = Object.freeze({
		kind: "bound-workspace",
		version: 1,
		repo,
		repository: repository.root,
		branch,
		worktree,
		base,
		baseCommit: await mergeBase(worktree, baseTip),
		sandbox: input.sandbox,
		...(input.label !== undefined ? { label: input.label } : {}),
		...described,
	});
	return { binding, commonDir: repository.commonDir };
}

/**
 * Resolve a workspace to a verified worktree. A local repository must be a repository root; a remote is cloned once
 * per host into `<atomic home>/repos/…` and worktrees are added from that store. A missing branch is created from
 * `base`. An existing worktree must belong to the repository and be on the branch. The same workspace value resolves
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
