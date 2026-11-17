import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { failureDebugFields, reportDebugAsync as reportDebug } from "../debug.ts";
import { releaseLock } from "../lock-release.ts";
import { renameWithRetry } from "../rename-retry.ts";
import { timeRestorePhase } from "../resume/timings.ts";
import { admitPooledWorktree, discardPooledWorktree, type PoolOwner, releaseRestoredWorktree } from "./pool.ts";
import { type RepositoryId, sharedRepositoryIdOf } from "./repository-identity.ts";
import { restoreWorktreeAt } from "./restore.ts";
import { lockShared } from "./shared-clock.ts";
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
	await renameWithRetry(`${file}.tmp`, file);
}

/** Why no seed was adopted. */
/**
 * `missing`: no seed of the repository. `busy`: a prebuild is replacing it. `path-taken`: the worktree path it was
 * built at is in use. `restore-failed`: its commit could not be restored. `unavailable`: its lock could not be taken
 * or was observed lost before adoption committed by removing the manifest.
 */
export type NoSeedReason = "missing" | "busy" | "path-taken" | "restore-failed" | "unavailable";

/** The seed lock's constants: a stopped process loses it after 30 seconds. */
const SEED_LOCK_STALE_MS = 30_000;
const SEED_LOCK_UPDATE_MS = 10_000;
const SEED_LOCK_POLL_MS = 50;
const SEED_LOCK_WAIT_MS = 120_000;
export const SEED_LOCK_REFUSED_MS = 10_000;

function refusedForAMoment(error: unknown, since: number): boolean {
	return (
		(error as NodeJS.ErrnoException).code === "EPERM" &&
		process.platform === "win32" &&
		Date.now() - since < SEED_LOCK_REFUSED_MS
	);
}

function seedHeldAndWaiting(error: unknown, wait: boolean, startedAt: number): boolean {
	return wait && (error as NodeJS.ErrnoException).code === "ELOCKED" && Date.now() - startedAt < SEED_LOCK_WAIT_MS;
}

async function lockSeed(
	file: string,
	wait: boolean,
	onLost: (error: Error) => void,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	await mkdir(dirname(file), { recursive: true });
	const startedAt = Date.now();
	let refusedSince: number | undefined;
	for (;;) {
		signal?.throwIfAborted();
		try {
			return await lockShared(file, {
				realpath: false,
				stale: SEED_LOCK_STALE_MS,
				update: SEED_LOCK_UPDATE_MS,
				retries: 0,
				onCompromised: (error) => {
					reportDebug("storage", "worktree-seed-lock-lost", { file, ...failureDebugFields(error) });
					onLost(error);
				},
			});
		} catch (error) {
			const since = refusedSince ?? Date.now();
			if (refusedForAMoment(error, since)) refusedSince = since;
			else if (seedHeldAndWaiting(error, wait, startedAt)) refusedSince = undefined;
			else throw error;
		}
		await sleep(SEED_LOCK_POLL_MS, undefined, { signal });
	}
}

/**
 * Runs `action` holding the seed lock of `repository`, which serializes parking a seed and adopting it, so an adoption
 * never moves the output of another generation than its manifest names. With `wait`, a held lock is waited for, for
 * up to two minutes, polling every 50 ms; without, it rejects with `ELOCKED`. Rejects if lock loss is observed before
 * the action completes. Adoption checks ownership itself and keeps its completed result after removing the manifest.
 */
export async function withSeedLock<T>(
	storeDir: string,
	repository: RepositoryId,
	wait: boolean,
	action: () => Promise<T>,
): Promise<T> {
	return withSeedLockHeld(storeDir, repository, wait, async (assertHeld) => {
		const result = await action();
		assertHeld();
		return result;
	});
}

async function withSeedLockHeld<T>(
	storeDir: string,
	repository: RepositoryId,
	wait: boolean,
	action: (assertHeld: () => void) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const file = seedManifestPath(storeDir, repository);
	let lost: Error | undefined;
	const unlock = await lockSeed(
		file,
		wait,
		(error) => {
			lost ??= error;
		},
		signal,
	);
	const assertHeld = () => {
		if (lost !== undefined) throw lost;
	};
	try {
		return await action(assertHeld);
	} finally {
		await releaseLock(unlock, file);
	}
}

export type SeedAdoption =
	| {
			readonly adopted: true;
			/** The idle pooled worktree the seed became, at the manifest's commit and tree. */
			readonly path: string;
			/** The parked paths moved into it. */
			readonly moved: readonly string[];
			/** Parked paths left out: their place holds something, lies below a file or link, or the move failed. */
			readonly skipped: readonly string[];
	  }
	| { readonly adopted: false; readonly reason: NoSeedReason };

export interface AdoptPrebuiltSeedOptions {
	readonly storeDir: string;
	readonly signal?: AbortSignal;
}

/**
 * Turns the seed of `snapshot`'s repository into an idle pooled worktree a claim can take (#4748): restores the
 * manifest's commit and tree into a new slot, moves each parked path into its place there when nothing is there yet,
 * and releases the slot. The manifest goes once the seed is adopted, so it is adopted once. A missing or foreign seed,
 * or a restore that fails, adopts nothing and leaves the seed as it was; rejects only when `signal` aborted. A
 * checkout whose remotes name no one repository, as one without remotes, has no seed (#4989).
 */
export async function adoptPrebuiltSeed(
	snapshot: Pick<WorktreeSnapshot, "remotes" | "root">,
	options: AdoptPrebuiltSeedOptions,
): Promise<SeedAdoption> {
	const storeDir = resolve(options.storeDir);
	const repository = sharedRepositoryIdOf(snapshot.remotes, snapshot.root);
	if (repository === undefined || (await readSeedManifest(storeDir, repository)) === undefined) {
		return { adopted: false, reason: "missing" };
	}
	try {
		return await withSeedLockHeld(
			storeDir,
			repository,
			false,
			(assertHeld) => adoptLocked(snapshot, storeDir, repository, options, assertHeld),
			options.signal,
		);
	} catch (error) {
		options.signal?.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return { adopted: false, reason: "busy" };
		// A seed lock that cannot be taken, as in a read-only seed directory, only loses the seed.
		reportDebug("storage", "worktree-seed-lock-failed", { repository, ...failureDebugFields(error) });
		return { adopted: false, reason: "unavailable" };
	}
}

async function adoptLocked(
	snapshot: Pick<WorktreeSnapshot, "remotes" | "root">,
	storeDir: string,
	repository: RepositoryId,
	options: AdoptPrebuiltSeedOptions,
	assertHeld: () => void,
): Promise<SeedAdoption> {
	const manifest = await readSeedManifest(storeDir, repository);
	assertHeld();
	if (manifest === undefined) return { adopted: false, reason: "missing" };
	const state = { snapshotId: null, head: manifest.head, tree: manifest.tree };
	let lease: Awaited<ReturnType<typeof admitPooledWorktree>> | undefined;
	try {
		lease = await admitPooledWorktree(
			{
				storeDir,
				remotes: snapshot.remotes,
				root: snapshot.root,
				lastState: state,
				envHash: manifest.envHash,
				signal: options.signal,
			},
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
		await restoreWorktreeAt(binding, lease.path, { storeDir, root: snapshot.root, signal: options.signal });
	} catch (error) {
		if (lease !== undefined) await discardPooledWorktree(lease);
		options.signal?.throwIfAborted();
		reportDebug("storage", "worktree-seed-restore-failed", { repository, ...failureDebugFields(error) });
		return { adopted: false, reason: "restore-failed" };
	}
	const slot = lease.path;
	try {
		assertHeld();
		const { moved, skipped } = await timeRestorePhase("seed", () =>
			moveSeeds(seedDirectory(storeDir, repository), slot, manifest.paths, assertHeld),
		);
		assertHeld();
		await rm(seedManifestPath(storeDir, repository), { force: true }).catch(() => {});
		const removeSeeds = async () => {
			assertHeld();
			await rm(seedDirectory(storeDir, repository), { recursive: true, force: true });
		};
		await removeSeeds().catch((error) => {
			reportDebug("storage", "worktree-seed-cleanup-skipped", { repository, ...failureDebugFields(error) });
		});
		return { adopted: true, path: slot, moved, skipped };
	} finally {
		await releaseRestoredWorktree(lease, state);
	}
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

/** Moves each parked path from `seeds` to its place in `worktree`, where nothing may be yet. */
async function moveSeeds(seeds: string, worktree: string, paths: readonly string[], assertHeld: () => void) {
	const moved: string[] = [];
	const skipped: string[] = [];
	for (const path of paths) {
		assertHeld();
		const segments = seedPathSegments(path)!;
		const from = join(seeds, ...segments);
		const to = join(worktree, ...segments);
		try {
			if ((await entryAt(from)) === undefined) continue;
			if ((await entryAt(to)) !== undefined || !(await insideThroughDirectories(worktree, segments))) {
				skipped.push(path);
				continue;
			}
			assertHeld();
			await mkdir(dirname(to), { recursive: true });
			assertHeld();
			await renameWithRetry(from, to);
			moved.push(path);
		} catch (error) {
			reportDebug("storage", "worktree-seed-move-failed", { path, ...failureDebugFields(error) });
			skipped.push(path);
		}
		assertHeld();
	}
	return { moved, skipped };
}
