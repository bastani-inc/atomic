import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { failureDebugFields, reportDebug } from "../debug.ts";
import { timeRestorePhase } from "../resume/timings.ts";
import { admitPooledWorktree, discardPooledWorktree, type PoolOwner, releaseRestoredWorktree } from "./pool.ts";
import { type RepositoryId, repositoryIdOf } from "./repository-identity.ts";
import { restoreWorktreeAt } from "./restore.ts";
import type { WorktreeSnapshot } from "./types.ts";

/**
 * Seeds (#4748): the build output `atomic blueprint prebuild --park` moved out of a prebuilt worktree, under
 * `<storeDir>/seeds/<repositoryId>/`, with a manifest at `<storeDir>/seeds/<repositoryId>.json` naming the commit and
 * tree it was built for. A CI cache restores both on another machine; a resume there that has no idle worktree to claim
 * adopts them as one.
 */

/** What a resume that adopts a seed restores and where its build output goes. */
export interface SeedManifest {
	readonly version: 1;
	readonly repository: RepositoryId;
	readonly head: string;
	readonly tree: string;
	readonly envHash: string;
	/** Root-relative, `/`-separated directories parked under the seed directory. */
	readonly paths: readonly string[];
	/** The worktree the output was built in: path-sensitive output is valid there only. */
	readonly worktree: string;
	readonly parkedAt: string;
}

/** Who holds a worktree adopted from a seed until a claim takes it. */
export const SEED_OWNER: PoolOwner = Object.freeze({ kind: "prebuild", id: "seed" });

export function seedDirectory(storeDir: string, repository: RepositoryId): string {
	return join(resolve(storeDir), "seeds", repository);
}

export function seedManifestPath(storeDir: string, repository: RepositoryId): string {
	return join(resolve(storeDir), "seeds", `${repository}.json`);
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `path` as directory names, or undefined when it is not a plain root-relative path outside `.git`. */
export function seedPathSegments(path: string): string[] | undefined {
	const segments = path.split("/");
	const plain = segments.every(
		(segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\:]/.test(segment),
	);
	return plain && segments[0]!.toLowerCase() !== ".git" ? segments : undefined;
}

function isManifest(value: unknown, repository: RepositoryId): value is SeedManifest {
	const manifest = value as Partial<SeedManifest> | null;
	return (
		manifest?.version === 1 &&
		manifest.repository === repository &&
		typeof manifest.head === "string" &&
		OBJECT_ID.test(manifest.head) &&
		typeof manifest.tree === "string" &&
		OBJECT_ID.test(manifest.tree) &&
		typeof manifest.envHash === "string" &&
		Array.isArray(manifest.paths) &&
		manifest.paths.every((path) => typeof path === "string" && seedPathSegments(path) !== undefined) &&
		typeof manifest.worktree === "string" &&
		typeof manifest.parkedAt === "string"
	);
}

/** The seed manifest of `repository`; undefined when there is none or it is not one of `repository`'s. */
export async function readSeedManifest(storeDir: string, repository: RepositoryId): Promise<SeedManifest | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(seedManifestPath(storeDir, repository), "utf8"));
	} catch {
		return undefined;
	}
	return isManifest(value, repository) ? value : undefined;
}

export async function writeSeedManifest(storeDir: string, manifest: SeedManifest): Promise<void> {
	const file = seedManifestPath(storeDir, manifest.repository);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
	await rename(`${file}.tmp`, file);
}

/** Why no seed was adopted. */
/**
 * `missing`: no seed of the repository. `busy`: a prebuild is replacing it. `path-taken`: the worktree path it was
 * built at is in use. `restore-failed`: its commit could not be restored.
 */
export type NoSeedReason = "missing" | "busy" | "path-taken" | "restore-failed";

/** The seed lock's constants: a stopped process loses it after 30 seconds. */
const SEED_LOCK_STALE_MS = 30_000;
const SEED_LOCK_UPDATE_MS = 10_000;

/**
 * Runs `action` holding the seed lock of `repository`, which serializes parking a seed and adopting it, so an adoption
 * never moves the output of another generation than its manifest names. With `wait`, a held lock is waited for, for
 * up to about two minutes; without, it rejects with `ELOCKED`.
 */
export async function withSeedLock<T>(
	storeDir: string,
	repository: RepositoryId,
	wait: boolean,
	action: () => Promise<T>,
): Promise<T> {
	const file = seedManifestPath(storeDir, repository);
	await mkdir(dirname(file), { recursive: true });
	const unlock = await lockfile.lock(file, {
		realpath: false,
		stale: SEED_LOCK_STALE_MS,
		update: SEED_LOCK_UPDATE_MS,
		retries: wait ? { retries: 120, minTimeout: 100, maxTimeout: 1_000 } : 0,
		onCompromised: (error) =>
			reportDebug("storage", "worktree-seed-lock-lost", { file, ...failureDebugFields(error) }),
	});
	try {
		return await action();
	} finally {
		await unlock().catch(() => {});
	}
}

export type SeedAdoption =
	| {
			readonly adopted: true;
			/** The idle pooled worktree the seed became, at the manifest's commit and tree. */
			readonly path: string;
			/** The parked paths moved into it. */
			readonly moved: readonly string[];
			/** Parked paths left out: their target was not empty, or the move failed. */
			readonly skipped: readonly string[];
	  }
	| { readonly adopted: false; readonly reason: NoSeedReason };

export interface AdoptPrebuiltSeedOptions {
	readonly storeDir: string;
	readonly signal?: AbortSignal;
}

/**
 * Turns the seed of `snapshot`'s repository into an idle pooled worktree a claim can take (#4748): restores the
 * manifest's commit and tree into a new slot, moves each parked path into its empty place there, never over content,
 * and releases the slot. The manifest goes once the seed is adopted, so it is adopted once. A missing or foreign seed,
 * or a restore that fails, adopts nothing and leaves the seed as it was; rejects only when `signal` aborted.
 */
export async function adoptPrebuiltSeed(
	snapshot: Pick<WorktreeSnapshot, "remotes">,
	options: AdoptPrebuiltSeedOptions,
): Promise<SeedAdoption> {
	const storeDir = resolve(options.storeDir);
	const repository = repositoryIdOf(snapshot.remotes);
	if ((await readSeedManifest(storeDir, repository)) === undefined) return { adopted: false, reason: "missing" };
	try {
		return await withSeedLock(storeDir, repository, false, () =>
			adoptLocked(snapshot, storeDir, repository, options),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
		return { adopted: false, reason: "busy" };
	}
}

async function adoptLocked(
	snapshot: Pick<WorktreeSnapshot, "remotes">,
	storeDir: string,
	repository: RepositoryId,
	options: AdoptPrebuiltSeedOptions,
): Promise<SeedAdoption> {
	const manifest = await readSeedManifest(storeDir, repository);
	if (manifest === undefined) return { adopted: false, reason: "missing" };
	const state = { snapshotId: null, head: manifest.head, tree: manifest.tree };
	let lease: Awaited<ReturnType<typeof admitPooledWorktree>> | undefined;
	try {
		lease = await admitPooledWorktree(
			{ storeDir, remotes: snapshot.remotes, lastState: state, envHash: manifest.envHash },
			SEED_OWNER,
		);
		if (lease.path !== resolve(manifest.worktree)) {
			await discardPooledWorktree(lease);
			return { adopted: false, reason: "path-taken" };
		}
		const binding = {
			remotes: [...snapshot.remotes],
			head: manifest.head,
			tree: manifest.tree,
			envHash: manifest.envHash,
		};
		await restoreWorktreeAt(binding, lease.path, { storeDir, signal: options.signal });
	} catch (error) {
		if (lease !== undefined) await discardPooledWorktree(lease);
		options.signal?.throwIfAborted();
		reportDebug("storage", "worktree-seed-restore-failed", { repository, ...failureDebugFields(error) });
		return { adopted: false, reason: "restore-failed" };
	}
	const slot = lease.path;
	const { moved, skipped } = await timeRestorePhase("seed", () =>
		moveSeeds(seedDirectory(storeDir, repository), slot, manifest.paths),
	);
	await rm(seedManifestPath(storeDir, repository), { force: true }).catch(() => {});
	await rm(seedDirectory(storeDir, repository), { recursive: true, force: true }).catch(() => {});
	await releaseRestoredWorktree(lease, state);
	return { adopted: true, path: slot, moved, skipped };
}

async function entryAt(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Whether every existing parent of `segments` under `root` is a real directory, so a move stays inside `root`. */
export async function insideThroughDirectories(root: string, segments: readonly string[]): Promise<boolean> {
	for (let depth = 1; depth < segments.length; depth++) {
		const entry = await entryAt(join(root, ...segments.slice(0, depth)));
		if (entry === undefined) return true;
		if (!entry.isDirectory()) return false;
	}
	return true;
}

/** Moves each parked path from `seeds` to its empty or missing place in `worktree`. */
async function moveSeeds(seeds: string, worktree: string, paths: readonly string[]) {
	const moved: string[] = [];
	const skipped: string[] = [];
	for (const path of paths) {
		const segments = seedPathSegments(path)!;
		const from = join(seeds, ...segments);
		const to = join(worktree, ...segments);
		try {
			if ((await entryAt(from)) === undefined) continue;
			const target = await entryAt(to);
			const empty = target?.isDirectory() === true && (await readdir(to)).length === 0;
			if ((target !== undefined && !empty) || !(await insideThroughDirectories(worktree, segments))) {
				skipped.push(path);
				continue;
			}
			if (empty) await rmdir(to);
			await mkdir(dirname(to), { recursive: true });
			await rename(from, to);
			moved.push(path);
		} catch (error) {
			reportDebug("storage", "worktree-seed-move-failed", { path, ...failureDebugFields(error) });
			skipped.push(path);
		}
	}
	return { moved, skipped };
}
