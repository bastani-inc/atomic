/**
 * `atomic blueprint prebuild` (#4748): builds a repository ahead of time, in a trusted job such as a default-branch CI
 * run or on a developer's machine, so a later resume claims a ready worktree instead of building one. With `park`, the
 * declared `kind: build` output moves into the seed directory that `atomic blueprint cache-key` names, for a cache
 * save; a resume on another machine adopts it.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MemorySnapshotBlobStore } from "../../worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot, readRepositoryConfig } from "../../worktree-snapshot/capture.ts";
import { runGit } from "../../worktree-snapshot/git.ts";
import {
	admitPooledWorktree,
	discardPooledWorktree,
	evictIdleWorktrees,
	type PoolOwner,
	releaseRestoredWorktree,
} from "../../worktree-snapshot/pool.ts";
import { repositoryIdOf } from "../../worktree-snapshot/repository-identity.ts";
import { removeRestoredWorktree, restoreWorktreeAt, storeCheckoutHead } from "../../worktree-snapshot/restore.ts";
import {
	insideThroughDirectories,
	seedDirectory,
	seedManifestPath,
	seedPathSegments,
	withSeedLock,
	writeSeedManifest,
} from "../../worktree-snapshot/seeds.ts";
import type { WorktreeSnapshot, WorktreeSnapshotSettings } from "../../worktree-snapshot/types.ts";
import { type ResumeTimings, ResumeTimingsRecorder, timeCheckoutRestore } from "../timings.ts";
import { type BlueprintBuildOutcome, runBlueprintBuild } from "./build.ts";
import { blueprintCacheKeys } from "./cache.ts";
import { blueprintRepository } from "./resume.ts";

/** Who holds a worktree while a prebuild builds it. */
export const PREBUILD_OWNER: PoolOwner = Object.freeze({ kind: "prebuild", id: "prebuild" });

export interface PrebuildRepositoryOptions {
	readonly agentDir: string;
	/** The restore store the worktree, its pool record and the seeds go to. */
	readonly storeDir: string;
	/** The snapshot settings idle worktrees were recorded under, for eviction. */
	readonly settings: WorktreeSnapshotSettings;
	/** `snapshots.pool.maxIdlePerRepository`: idle worktrees of the repository kept after the prebuild. */
	readonly maxIdlePerRepository: number;
	/** Move the declared `kind: build` output into the seed directory for a cache save. */
	readonly park?: boolean;
	/** The deprecated `resume.setupCommand`, run as a resume would. */
	readonly setupCommand?: string;
	/** What `~` in the blueprint's `cache:` paths expands to. Default: the user's home directory. */
	readonly home?: string;
	readonly signal?: AbortSignal;
}

/** `built`: an idle worktree is ready. `partial` and `failed`: the blueprint build did not finish; nothing changed. */
export type PrebuildStatus = "built" | "partial" | "failed";

export interface PrebuildOutcome {
	readonly status: PrebuildStatus;
	readonly head: string;
	/** The idle pooled worktree the prebuild left; undefined when it did not build. */
	readonly path: string | undefined;
	/** Root-relative build output moved into the seed directory. */
	readonly parked: readonly string[];
	readonly build: BlueprintBuildOutcome;
	/** The restore and the blueprint steps, as a resume records them; parking is `parkMs`. */
	readonly timings: ResumeTimings;
	readonly parkMs: number | null;
	/** Why declared cache paths were left out. */
	readonly warnings: readonly string[];
}

/**
 * Restores the committed HEAD of the checkout at `root` into a new pooled worktree, builds it with the blueprints
 * (`initialize` and `maintenance`, as a resume does), and leaves it idle for a later resume to claim; the oldest idle
 * worktrees beyond `maxIdlePerRepository` go. Only committed content is restored, filtered by the snapshot deny list,
 * so ignored and untracked files such as `.env` never reach it. A build that fails removes the new worktree and keeps
 * earlier worktrees and seeds. Rejects when the checkout has no remote or uncommitted changes to tracked files, or the
 * restore fails. Runs project code: callers check that the project is trusted.
 */
export async function prebuildRepository(root: string, options: PrebuildRepositoryOptions): Promise<PrebuildOutcome> {
	const recorder = new ResumeTimingsRecorder();
	const { signal } = options;
	const storeDir = resolve(options.storeDir);
	const { remotes } = await readRepositoryConfig(root, signal);
	if (remotes.length === 0) {
		throw new Error(`${root} has no Git remote; a prebuilt worktree belongs to the repository its remotes name`);
	}
	const changed = await runGit(["status", "--porcelain", "-z", "--untracked-files=no"], { cwd: root, signal });
	if (changed.stdout.length > 0) {
		throw new Error(`${root} has uncommitted changes to tracked files; prebuild builds the committed HEAD`);
	}
	const blobs = new MemorySnapshotBlobStore();
	const capture = await captureWorktreeSnapshot(root, { settings: { includeUntracked: false }, blobs, signal });
	if (capture.status === "unavailable") throw capture.reason;
	if (capture.status === "disabled") throw new Error("snapshots are disabled");
	const snapshot: WorktreeSnapshot = capture.snapshot;
	const state = { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree };
	// The checkout has the commit, and the credentials to fetch it; the store takes it from there.
	await storeCheckoutHead(storeDir, remotes, root, snapshot.head, signal);
	const lease = await admitPooledWorktree(
		{ storeDir, remotes, lastState: state, envHash: snapshot.envHash },
		PREBUILD_OWNER,
	);
	return recorder.run(async () => {
		let build: BlueprintBuildOutcome;
		try {
			await timeCheckoutRestore(
				root,
				() => restoreWorktreeAt(snapshot, lease.path, { storeDir, blobs, signal }),
				() => "fresh",
			);
			build = await runBlueprintBuild(
				[{ ...blueprintRepository({ root: lease.path, remotes }), initialize: true }],
				{ agentDir: options.agentDir, storeDir, trusted: () => true, setupCommand: options.setupCommand },
				signal,
			);
		} catch (error) {
			await removeRestoredWorktree(lease.path, { storeDir }).catch(() => {});
			await discardPooledWorktree(lease);
			throw error;
		}
		const outcome = { head: snapshot.head, build, parkMs: null, parked: [] as string[], warnings: [] as string[] };
		if (build.status === "partial" || build.status === "failed") {
			await removeRestoredWorktree(lease.path, { storeDir }).catch(() => {});
			await discardPooledWorktree(lease);
			return { ...outcome, status: build.status, path: undefined, timings: recorder.finish() };
		}
		let parkMs: number | null = null;
		try {
			if (options.park) {
				const started = performance.now();
				const keys = await blueprintCacheKeys(root, {
					agentDir: options.agentDir,
					storeDir,
					...(options.home === undefined ? {} : { home: options.home }),
				});
				outcome.warnings.push(...keys.warnings);
				const seeds = seedDirectory(storeDir, repositoryIdOf(remotes));
				const declared = (keys.entries.find((entry) => entry.name === "build")?.paths ?? [])
					.map((path) => relative(seeds, path).split(sep).join("/"))
					.filter((path) => seedPathSegments(path) !== undefined);
				outcome.parked.push(...(await parkBuildOutput(storeDir, lease.path, declared, snapshot)));
				parkMs = Math.floor(performance.now() - started);
			}
		} finally {
			// Built, whether its output was parked or put back: the worktree is idle for a resume to claim.
			await releaseRestoredWorktree(lease, state);
		}
		await evictIdleWorktrees(storeDir, lease.repository, {
			maxIdle: options.maxIdlePerRepository,
			settings: options.settings,
			signal,
		});
		return { ...outcome, parkMs, status: "built" as const, path: lease.path, timings: recorder.finish() };
	});
}

/**
 * Moves each of `declared`, root-relative, from the worktree at `worktree` into a new seed directory of the
 * repository, which then replaces the earlier one under the seed lock, and writes its manifest. A path inside another
 * declared one moves with it; a path that is a symbolic link or lies below one is left alone. Resolves to the paths
 * moved; with none, the earlier seed goes and no manifest is written. A move that fails puts the moved paths back and
 * rejects, keeping the earlier seed.
 */
async function parkBuildOutput(
	storeDir: string,
	worktree: string,
	declared: readonly string[],
	snapshot: WorktreeSnapshot,
): Promise<string[]> {
	const repository = repositoryIdOf(snapshot.remotes);
	const target = seedDirectory(storeDir, repository);
	const staging = join(dirname(target), `.parking-${randomUUID()}`);
	const outermost = declared.filter(
		(path, index) => declared.indexOf(path) === index && !declared.some((other) => path.startsWith(`${other}/`)),
	);
	const parked: string[] = [];
	await mkdir(staging, { recursive: true });
	try {
		try {
			for (const path of outermost) {
				const segments = seedPathSegments(path)!;
				const from = join(worktree, ...segments);
				const entry = await lstat(from).catch(() => undefined);
				if (entry === undefined || entry.isSymbolicLink()) continue;
				if (!(await insideThroughDirectories(worktree, segments))) continue;
				const to = join(staging, ...segments);
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
				parked.push(path);
			}
		} catch (error) {
			for (const path of [...parked].reverse()) {
				const segments = seedPathSegments(path)!;
				await rename(join(staging, ...segments), join(worktree, ...segments)).catch(() => {});
			}
			throw error;
		}
		await withSeedLock(storeDir, repository, true, async () => {
			await rm(seedManifestPath(storeDir, repository), { force: true });
			await rm(target, { recursive: true, force: true });
			if (parked.length === 0) return;
			await rename(staging, target);
			await writeSeedManifest(storeDir, {
				version: 1,
				repository,
				head: snapshot.head,
				tree: snapshot.tree,
				envHash: snapshot.envHash,
				paths: parked,
				worktree,
				parkedAt: new Date().toISOString(),
			});
		});
		return parked;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
