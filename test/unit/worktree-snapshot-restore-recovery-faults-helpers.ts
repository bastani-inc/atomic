import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	restoreWorktree,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import type { GitSandbox } from "../helpers/worktree-snapshot.js";

/** One Git process the code under test starts, and the hooks that let a test act at that exact moment. */
export interface SpawnedGit {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string | undefined>;
}
export interface SpawnOverride {
	readonly command?: string;
	readonly args?: readonly string[];
}
export interface LockOptions {
	readonly onCompromised: (error: Error) => void;
}
export type Release = () => Promise<void>;
export type RealLock = (file: string, options: LockOptions) => Promise<Release>;

export interface FaultState {
	spawns: SpawnedGit[];
	spawnHook:
		| undefined
		| ((args: readonly string[], cwd: string, env: Record<string, string | undefined>) => SpawnOverride | undefined);
	lstat: undefined | ((path: string) => void);
	realpath: undefined | ((path: string) => void);
	writeFile: undefined | ((path: string) => void);
	rm: undefined | ((path: string) => void);
	lock: undefined | ((file: string, options: LockOptions, real: RealLock) => Promise<Release>);
	uuids: string[];
}

export function resetFaultState(faults: FaultState): void {
	faults.spawns.length = 0;
	faults.spawnHook = undefined;
	faults.lstat = undefined;
	faults.realpath = undefined;
	faults.writeFile = undefined;
	faults.rm = undefined;
	faults.lock = undefined;
	faults.uuids.length = 0;
}

/** A Git invocation's arguments past the leading `-c key=value` pairs. */
export function command(args: readonly string[]): string[] {
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (rest.length === 0 && args[index] === "-c") index++;
		else rest.push(args[index]!);
	}
	return rest;
}

export const is = (args: readonly string[], ...prefix: string[]) =>
	prefix.every((word, index) => command(args)[index] === word);

export async function dirtyCloneIn(
	sandbox: GitSandbox,
	files?: Record<string, string>,
): Promise<{ readonly snapshot: WorktreeSnapshot; readonly blobs: MemorySnapshotBlobStore }> {
	const { clone } = await sandbox.remoteWithClone("work", files);
	sandbox.write(join(clone, "dirty.txt"), "recorded\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") throw new Error("capture failed");
	return { snapshot: captured.snapshot, blobs };
}

/** The shared store a restore of `snapshot` keeps under `storeDir`. */
export function storeOf(storeDir: string, snapshot: WorktreeSnapshot): string {
	const name = createHash("sha256").update(snapshot.remotes.join("\n")).digest("hex").slice(0, 24);
	return join(storeDir, "repositories", `${name}.git`);
}

/** Git's registered worktree paths, spelled as `resolve` spells them: Git for Windows lists them with `/`. */
export async function registeredIn(sandbox: GitSandbox, store: string): Promise<string[]> {
	const listing = await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "list", "--porcelain");
	return listing
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length)));
}

/** Whether `listed` names `path`, ignoring case on Windows as its file system does. */
export function lists(listed: readonly string[], path: string): boolean {
	const fold = (entry: string) => (process.platform === "win32" ? resolve(entry).toLowerCase() : resolve(entry));
	return listed.some((entry) => fold(entry) === fold(path));
}

export const warning = (
	path: string,
	kind: "worktree" | "record" | "records-directory" = "worktree",
): WorktreeRestoreWarning => ({ code: "stale-restore-retained", path, kind });

export const retainedWarnings = (warnings: readonly WorktreeRestoreWarning[]) =>
	warnings.filter((candidate) => candidate.code === "stale-restore-retained");

/** The staging worktree beside `target` of the restore `id`: `.s-` and 12 hex digits of the id (#5139). */
export const siblingStaging = (target: string, id: string) =>
	join(dirname(target), `.${basename(target)}.s-${id.replaceAll("-", "").slice(0, 12)}`);

/** Where a restore sets the worktree it cleans up aside: its staging path with `.d-` in place of `.s-` (#4748). */
export const asideOf = (staging: string) => staging.replace(/\.s-([0-9a-f]{12})$/, ".d-$1");

export function uuid(): string {
	const hex = createHash("sha256").update(String(Math.random())).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The restores a run under `faults` started: warnings through `onWarning`, and the outcome. */
export async function restoreInto(
	snapshot: WorktreeSnapshot,
	blobs: MemorySnapshotBlobStore,
	storeDir: string,
	into: string,
	signal?: AbortSignal,
) {
	const warnings: WorktreeRestoreWarning[] = [];
	const outcome = await restoreWorktree(snapshot, {
		blobs,
		storeDir,
		into,
		signal,
		onWarning: (w) => warnings.push(w),
	}).then(
		(restored) => ({ restored, error: undefined }),
		(error: unknown) => ({ restored: undefined, error }),
	);
	return { warnings, ...outcome };
}

/** Aborts `controller` with `reason` as the restore's `read-tree --reset -u` starts, after staging exists. */
export function failAtCheckoutWith(
	faults: FaultState,
	controller: AbortController,
	reason: unknown,
	beforeAbort?: () => void,
): void {
	faults.spawnHook = (args) => {
		if (is(args, "read-tree", "--reset", "-u")) {
			beforeAbort?.();
			queueMicrotask(() => controller.abort(reason));
		}
		return undefined;
	};
}

/** The staging path of the `git worktree add` a restore starts. */
export function stagingOf(args: readonly string[]): string {
	const rest = command(args);
	return rest[rest.length - 2]!;
}
