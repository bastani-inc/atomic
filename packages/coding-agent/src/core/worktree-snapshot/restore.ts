import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { locateCheckout, readRepositoryConfig, withScratchDirectory, writeWorkingTree } from "./capture.ts";
import { computeEnvironmentHash, sha256Hex } from "./env-hash.ts";
import {
	isWorkspaceGitError,
	WorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorFields,
} from "./errors.ts";
import { type GitRunOptions, gitText, nulFields, runGit } from "./git.ts";
import { loadSnapshotPathPolicy } from "./policy.ts";
import { resolveWorktreeSnapshotSettings, type WorktreeSnapshotSettingsInput } from "./settings.ts";
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
	/** Settings the snapshot was captured with; verification applies the same exclusions. */
	readonly settings?: WorktreeSnapshotSettingsInput;
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
		throw error;
	}
	if (!empty) throw new WorkspaceRestoreError("unsafe-target", { snapshotId, target, reason: "not-empty" });
}

async function hasObject(git: GitRunOptions, object: string): Promise<boolean> {
	const { exitCode } = await runGit(["cat-file", "-e", object], { ...git, allowExitCodes: [1, 128] });
	return exitCode === 0;
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

async function ensureObjectStore(storeDir: string, remotes: readonly string[], signal?: AbortSignal): Promise<string> {
	const repositories = join(storeDir, "repositories");
	const store = join(repositories, `${sha256Hex(remotes.join("\n")).slice(0, 24)}.git`);
	await mkdir(repositories, { recursive: true });
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
			await runGit(["fetch", "-q", "--no-tags", "--no-write-fetch-head", remote, ...missing], git);
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
			failure = (await fetchCommits(git, snapshot.remotes, bundlePrerequisites(data))) ?? failure;
			const file = join(scratch, "history.bundle");
			await writeFile(file, data);
			try {
				await runGit(["fetch", "-q", "--no-tags", "--no-write-fetch-head", file, "HEAD"], git);
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
			await writeFile(file, patch);
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

async function materialize(
	git: GitRunOptions,
	target: string,
	head: string,
	tree: string,
	scratch: string,
	signal?: AbortSignal,
): Promise<void> {
	await runGit(["worktree", "add", "-q", "--detach", "--no-checkout", target, head], git);
	const attributes = join(scratch, "empty-attributes");
	await writeFile(attributes, "");
	const neutral: GitRunOptions = { cwd: target, signal, neutral: true, env: { GIT_LFS_SKIP_SMUDGE: "1" } };
	await runGit(["-c", `core.attributesFile=${attributes}`, "read-tree", "--reset", "-u", tree], neutral);
	await runGit(["read-tree", head], neutral);
	await runGit(["update-index", "-q", "--refresh"], { ...neutral, allowExitCodes: [1] });
}

async function removeWorktree(git: GitRunOptions, target: string, created: boolean): Promise<void> {
	await runGit(["worktree", "remove", "--force", target], { ...git, signal: undefined, allowExitCodes: [128] });
	await rm(target, { recursive: true, force: true });
	if (!created) await mkdir(target, { recursive: true });
	await runGit(["worktree", "prune"], { ...git, signal: undefined });
}

function resolveSnapshot(
	target: WorkspaceBinding | WorktreeSnapshot,
	snapshots: readonly WorktreeSnapshot[] | undefined,
): WorktreeSnapshot | null {
	if (isSnapshot(target)) return target;
	const candidates = (snapshots ?? []).filter(
		(snapshot) => snapshot.tree === target.tree && snapshot.head === target.head,
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
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	const { signal } = options;
	const snapshot = resolveSnapshot(target, options.snapshots);
	const storeDir = resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir());
	const path = resolve(
		options.into ??
			join(storeDir, "worktrees", `${(snapshot?.id ?? target.tree).slice(0, 12)}-${randomUUID().slice(0, 8)}`),
	);
	await checkTarget(path, snapshot?.id ?? null);
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
	const warn = (warning: WorktreeRestoreWarning) => {
		warnings.push(warning);
		options.onWarning?.(warning);
	};
	return withScratchDirectory(async (scratch) => {
		const store = await ensureObjectStore(storeDir, target.remotes, signal);
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
		const created = !(await exists(path));
		let failure: Error | undefined;
		try {
			await mkdir(path, { recursive: true });
			await materialize(git, path, target.head, target.tree, scratch, signal);
			if (snapshot?.filters?.drivers.includes("lfs")) {
				const worktree: GitRunOptions = { cwd: path, signal };
				try {
					await runGit(["lfs", "pull"], worktree);
				} catch (error) {
					if (!isWorkspaceGitError(error)) throw error;
					warn({ code: "lfs-objects-unavailable", paths: await lfsPaths(worktree) });
				}
			}
			const checkout = await locateCheckout(path, signal);
			if (checkout instanceof Error) throw checkout;
			const policy = await loadSnapshotPathPolicy(path);
			const actual = await withScratchDirectory((verifyScratch) =>
				writeWorkingTree(checkout, settings, policy, verifyScratch, { signal, neutral: true }),
			);
			if (checkout.head !== target.head || actual.tree !== target.tree) {
				throw new WorkspaceRestoreError("tree-mismatch", {
					snapshotId: snapshot?.id ?? null,
					target: path,
					expectedTree: target.tree,
					actualTree: actual.tree,
				});
			}
		} catch (error) {
			failure = error as Error;
			try {
				await removeWorktree(git, path, created);
			} catch (cleanupCause) {
				Object.defineProperty(failure, "cleanupCause", { value: cleanupCause, configurable: true });
			}
			throw failure;
		}
		if (snapshot) for (const warning of snapshotRestoreWarnings(snapshot)) warn(warning);
		return {
			path,
			snapshot,
			binding: { remotes: [...target.remotes], head: target.head, tree: target.tree, envHash: target.envHash },
			warnings,
		};
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Removes a worktree that a restore created, for callers that roll back a multi-checkout restore; a path that no
 * longer exists is already removed. Refuses, with
 * `unsafe-target` (reason `not-restored`), any directory that is not a worktree of a shared store under `storeDir`,
 * so it can never touch a user's checkout.
 */
export async function removeRestoredWorktree(
	path: string,
	options: { readonly storeDir?: string; readonly signal?: AbortSignal } = {},
): Promise<void> {
	const target = resolve(path);
	if (!(await exists(target))) return;
	const repositories = join(resolve(options.storeDir ?? defaultWorktreeSnapshotStoreDir()), "repositories");
	const common = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: target,
		signal: options.signal,
		allowExitCodes: [128],
	});
	const store = common.stdout.toString("utf8").trim();
	if (
		common.exitCode !== 0 ||
		!isWithin(repositories, store) ||
		relative(store, target) === "" ||
		isWithin(store, target)
	) {
		throw new WorkspaceRestoreError("unsafe-target", { snapshotId: null, target, reason: "not-restored" });
	}
	await removeWorktree({ cwd: repositories, env: { GIT_DIR: store }, signal: options.signal }, target, true);
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
	/** Settings the binding's snapshot was captured with, so the same paths are excluded. */
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
	const checkout = await locateCheckout(dir, options.signal);
	if (checkout instanceof Error) throw checkout;
	const policy = await loadSnapshotPathPolicy(checkout.root);
	const state = await withScratchDirectory((scratch) =>
		writeWorkingTree(checkout, settings, policy, scratch, { signal: options.signal }),
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
