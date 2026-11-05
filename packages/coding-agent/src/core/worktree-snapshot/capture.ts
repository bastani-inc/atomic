import { copyFile, lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { computeEnvironmentHash, sha256Hex, snapshotBlob } from "./env-hash.ts";
import {
	type GitUnavailableError,
	isGitUnavailableError,
	WorkspaceConfigError,
	WorkspaceSnapshotError,
} from "./errors.ts";
import { type GitRunOptions, gitText, nulFields, redactUrlCredentials, runGit } from "./git.ts";
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
	/** The last snapshot recorded for this checkout: the no-op comparison and the incremental delta base. */
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
		throw error;
	}
	try {
		const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, signal, allowExitCodes: [128] });
		if (top.exitCode !== 0) return new WorkspaceSnapshotError("not-a-repository", dir);
		const root = top.stdout.toString("utf8").replace(/\n$/, "");
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

/**
 * Writes the policy-filtered working tree of `root` as a Git tree through a private index seeded from HEAD, leaving
 * the user's index, refs and files untouched. Denied and ignored tracked paths keep their HEAD content.
 */
export async function writeWorkingTree(
	checkout: Checkout,
	settings: WorktreeSnapshotSettings,
	policy: SnapshotPathPolicy,
	scratch: string,
	options: { readonly signal?: AbortSignal; readonly neutral?: boolean },
): Promise<WorkingTreeState> {
	const { root } = checkout;
	const index = join(scratch, "index");
	const git: GitRunOptions = {
		cwd: root,
		env: { GIT_INDEX_FILE: index },
		signal: options.signal,
		neutral: options.neutral,
	};
	const userIndex = await gitText(["rev-parse", "--git-path", "index"], { cwd: root, signal: options.signal });
	try {
		await copyFile(isAbsolute(userIndex) ? userIndex : resolve(root, userIndex), index);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await runGit(["read-tree", "--reset", checkout.head], git);
	const changed = nulFields((await runGit(["diff-files", "-z", "--name-only", "--no-renames"], git)).stdout);
	const untracked = nulFields((await runGit(["ls-files", "-z", "--others", "--exclude-standard"], git)).stdout).filter(
		(path) => !path.endsWith("/"),
	);
	const omitted: WorktreeSnapshotOmission[] = [];
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
	if (admitted.length > 0) {
		await runGit(["update-index", "-z", "--add", "--remove", "--stdin"], {
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
		throw error;
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

const FILTER_ATTRIBUTE = /(?:^|\s)filter=(\S+)/gm;

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
			throw error;
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

function snapshotId(fields: Omit<WorktreeSnapshot, "id" | "capturedAt" | "version" | "omitted" | "filters">): string {
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
		]),
	).slice(0, 32);
}

/**
 * Records the state of the Git checkout containing `dir`. Resolves `unavailable` (with the typed reason) when Git is
 * missing, `dir` is outside a work tree, or the repository has no commits, and `unchanged` with `previous` when HEAD
 * and the recomputed tree both equal it. Never changes the user's index, refs or files.
 */
export async function captureWorktreeSnapshot(
	dir: string,
	options: CaptureWorktreeSnapshotOptions = {},
): Promise<WorktreeSnapshotCapture> {
	if (typeof dir !== "string" || dir.length === 0) throw new WorkspaceConfigError("sdk", "dir", "a directory path");
	const settings = resolveWorktreeSnapshotSettings(options.settings, "sdk", "settings");
	if (!settings.enabled) return { status: "disabled" };
	const { signal } = options;
	const checkout = await locateCheckout(dir, signal);
	if (checkout instanceof Error) return { status: "unavailable", reason: checkout };
	const { root, head } = checkout;
	const previous = options.previous?.root === root ? options.previous : undefined;
	return withScratchDirectory(async (scratch) => {
		const policy = await loadSnapshotPathPolicy(root);
		const state = await writeWorkingTree(checkout, settings, policy, scratch, { signal });
		if (previous && previous.head === head && previous.tree === state.tree) {
			return { status: "unchanged", snapshot: previous, binding: bindingOf(previous) };
		}
		const config = await readRepositoryConfig(root, signal);
		const branch = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], {
			cwd: root,
			signal,
			allowExitCodes: [1],
		});
		const snapshotCommit = await gitText(
			["commit-tree", "--no-gpg-sign", "-p", head, "-m", "Atomic worktree snapshot", state.tree],
			{ cwd: root, signal, env: SNAPSHOT_IDENTITY },
		);
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
			id: snapshotId(fields),
			...fields,
			omitted: [...state.omitted, ...history.omitted],
			filters: await readFilters(root, config, signal),
			capturedAt: new Date().toISOString(),
		};
		if (options.blobs) await options.blobs.putBlobs(blobs);
		return { status: "captured", snapshot, binding: bindingOf(snapshot), blobs };
	});
}
