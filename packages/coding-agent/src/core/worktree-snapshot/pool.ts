import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { failureDebugFields, reportDebug } from "../debug.ts";
import { sha256Hex } from "./env-hash.ts";
import { nulFields, runGit } from "./git.ts";
import { canonicalizeWorktreePath } from "./paths.ts";
import { isDeniedSnapshotPath } from "./policy.ts";
import { removeRestoredWorktree, verifyWorktree } from "./restore.ts";
import type { WorktreeSnapshotSettings } from "./types.ts";

/**
 * The per-machine pool of restored worktrees (#4748). A session resume restores into a slot at a stable path,
 * `<storeDir>/worktrees/<repositoryId>-<n>`, described by one record, `<storeDir>/pool/<repositoryId>/<n>.json`, and
 * leased while a session works in it: each process that holds a slot has a lease lock of its own next to the record,
 * and a lock on the record itself serializes changes to the slot. Only session resumes admit slots: worktrees restored
 * for workflow runs, by the SDK into a chosen directory, or by earlier versions have no record and are never pooled.
 *
 * A slot's owner is the holder that last took it, whether it still holds the lease or released it when it closed;
 * only the owner continues in it. Nothing here rewrites an existing worktree.
 */

/** The identity of a repository: the same `sha24(remotes)` that names its shared object store under `repositories/`. */
export type RepositoryId = string & { readonly __brand: "RepositoryId" };
export type SlotNumber = number & { readonly __brand: "SlotNumber" };

/** Who holds a slot: a session, by its id, or a prebuild. */
export interface PoolOwner {
	readonly kind: "session" | "prebuild";
	readonly id: string;
}

/** The state a slot was left in: its HEAD and policy tree, and the snapshot that recorded them when known. */
export interface PoolLastState {
	readonly snapshotId: string | null;
	readonly head: string;
	readonly tree: string;
}

export interface PoolSlotRecord {
	readonly version: 1;
	readonly repository: RepositoryId;
	readonly slot: SlotNumber;
	readonly path: string;
	readonly holder: PoolOwner;
	readonly lastState: PoolLastState;
	readonly envHash: string;
	readonly blueprintDigest: string | null;
	/** When the holder released the slot; null while it is held, or when its holder stopped without releasing it. */
	readonly releasedAt: string | null;
}

/** What a session resume restores into a new slot. */
export interface PoolAdmission {
	readonly storeDir: string;
	readonly remotes: readonly string[];
	/** The state the restore is about to publish. */
	readonly lastState: PoolLastState;
	readonly envHash: string;
}

/** A slot this process holds for an owner. Release it exactly once. */
export interface WorktreeLease {
	readonly storeDir: string;
	readonly repository: RepositoryId;
	readonly slot: SlotNumber;
	readonly path: string;
	readonly owner: PoolOwner;
}

/** Who owns the worktree at a path: no pool record (`"unpooled"`), or its owner and whether a live process holds it. */
export type PooledWorktreeHolder =
	| "unpooled"
	| {
			/** The holder that last took the slot; null when its record cannot be read, which no session owns. */
			readonly owner: PoolOwner | null;
			readonly held: boolean;
	  };

/** `snapshots.pool` settings. */
export interface WorktreePoolSettings {
	/** Idle pooled worktrees kept per repository; the oldest unchanged ones beyond it are removed. Default 2. */
	readonly maxIdlePerRepository: number;
}

/** Default of `snapshots.pool.maxIdlePerRepository`. */
export const DEFAULT_MAX_IDLE_PER_REPOSITORY = 2;

/** The lease constants of restore records: a stopped process loses its lease after 30 seconds. */
const LEASE_STALE_MS = 30_000;
const LEASE_UPDATE_MS = 10_000;
const SLOT_NAME = /^([0-9a-f]{24})-(\d{1,6})$/;
const RECORD_NAME = /^(\d{1,6})\.json$/;

export function repositoryIdOf(remotes: readonly string[]): RepositoryId {
	return sha256Hex(remotes.join("\n")).slice(0, 24) as RepositoryId;
}

export function pooledWorktreePath(storeDir: string, repository: RepositoryId, slot: SlotNumber): string {
	return join(resolve(storeDir), "worktrees", `${repository}-${slot}`);
}

function recordFile(storeDir: string, repository: RepositoryId, slot: SlotNumber): string {
	return join(resolve(storeDir), "pool", repository, `${slot}.json`);
}

interface HeldSlot {
	readonly owner: PoolOwner;
	references: number;
	record: PoolSlotRecord;
	/** Releases this process's lease of the slot. */
	readonly unlease: () => Promise<void>;
}

/** The slots this process holds, by record file. A second hold of a slot by its owner shares the lease. */
const heldSlots = new Map<string, HeldSlot>();
const released = new WeakSet<WorktreeLease>();
/** Names this process's leases; the pid alone could be reused by a later process. */
const PROCESS_LEASE = `${process.pid}-${randomUUID().slice(0, 8)}`;

function sameOwner(a: PoolOwner | null, b: PoolOwner): boolean {
	return a !== null && a.kind === b.kind && a.id === b.id;
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
 * Locks `path` with the restore-record constants: a stopped process loses the lock after 30 seconds. `wait` retries a
 * lock another process holds for a while, as when a slot's record is briefly being written.
 */
function lockPath(path: string, wait: boolean): Promise<() => Promise<void>> {
	return lockfile.lock(path, {
		realpath: false,
		stale: LEASE_STALE_MS,
		update: LEASE_UPDATE_MS,
		retries: wait ? { retries: 60, minTimeout: 20, maxTimeout: 500 } : 0,
		// A lost lock only lets another process take the slot later; it never ends this process.
		onCompromised: (error) =>
			reportDebug("storage", "worktree-pool-lock-lost", { path, ...failureDebugFields(error) }),
	});
}

/**
 * Runs `action` holding the slot's record lock, which serializes changes to one slot across processes: leases are
 * taken and released, and slots evicted, only under it. Without `wait`, a busy slot rejects with `ELOCKED`.
 */
async function withSlotLock<T>(file: string, wait: boolean, action: () => Promise<T>): Promise<T> {
	const unlock = await lockPath(file, wait);
	try {
		return await action();
	} finally {
		await unlock().catch(() => {});
	}
}

/** Takes this process's lease of the slot whose record is `file`: a lock of its own, so other processes can share it. */
function leaseSlot(file: string): Promise<() => Promise<void>> {
	return lockPath(`${file}.${PROCESS_LEASE}.lease`, false);
}

/**
 * The leases other processes hold on the slot whose record is `file`, removing those of processes that stopped. A
 * lease that cannot be read counts as held.
 */
async function otherLeases(file: string): Promise<number> {
	const prefix = `${basename(file)}.`;
	const own = `${basename(file)}.${PROCESS_LEASE}.lease`;
	let live = 0;
	for (const name of await readdir(dirname(file))) {
		if (!name.startsWith(prefix) || !name.endsWith(".lease.lock")) continue;
		const lease = join(dirname(file), name.slice(0, -".lock".length));
		if (basename(lease) === own) continue;
		const held = await lockfile.check(lease, { realpath: false, stale: LEASE_STALE_MS }).catch(() => true);
		if (held) live++;
		else await rm(`${lease}.lock`, { recursive: true, force: true }).catch(() => {});
	}
	return live;
}

/** Whether a live process holds the slot whose record is `file`: this one, or another whose lease is not stale. */
async function isHeld(file: string): Promise<boolean> {
	if (heldSlots.has(file)) return true;
	return (await otherLeases(file).catch(() => 1)) > 0;
}

async function writeRecord(file: string, record: PoolSlotRecord): Promise<void> {
	const temporary = `${file}.${PROCESS_LEASE}.tmp`;
	await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
	await rename(temporary, file);
}

function isOwner(value: unknown): value is PoolOwner {
	const owner = value as Partial<PoolOwner> | null | undefined;
	return (owner?.kind === "session" || owner?.kind === "prebuild") && typeof owner.id === "string";
}

async function readRecord(file: string, storeDir: string, repository: RepositoryId, slot: SlotNumber) {
	const record = JSON.parse(await readFile(file, "utf8")) as Partial<PoolSlotRecord> | null;
	const state = record?.lastState as Partial<PoolLastState> | undefined;
	const valid =
		record?.version === 1 &&
		record.repository === repository &&
		record.slot === slot &&
		record.path === pooledWorktreePath(storeDir, repository, slot) &&
		isOwner(record.holder) &&
		typeof state?.head === "string" &&
		typeof state.tree === "string" &&
		(state.snapshotId === null || typeof state.snapshotId === "string") &&
		typeof record.envHash === "string" &&
		(record.blueprintDigest === null || typeof record.blueprintDigest === "string") &&
		(record.releasedAt === null || typeof record.releasedAt === "string");
	return valid ? (record as PoolSlotRecord) : undefined;
}

function newLease(record: PoolSlotRecord, storeDir: string, owner: PoolOwner): WorktreeLease {
	return Object.freeze({
		storeDir: resolve(storeDir),
		repository: record.repository,
		slot: record.slot,
		path: record.path,
		owner,
	});
}

/**
 * Takes the lowest free slot of the repository `admission.remotes` name and holds it for `owner`, before the restore
 * publishes into its path. A slot is free when it has neither a record nor a directory, and no other process is
 * changing it. Choosing and taking a slot run under a per-repository lock, so concurrent restores, in this process or
 * others, get different slots.
 */
export async function admitPooledWorktree(admission: PoolAdmission, owner: PoolOwner): Promise<WorktreeLease> {
	const storeDir = resolve(admission.storeDir);
	const repository = repositoryIdOf(admission.remotes);
	const directory = join(storeDir, "pool", repository);
	await mkdir(directory, { recursive: true });
	const unlockRepository = await lockfile.lock(directory, {
		realpath: false,
		stale: LEASE_STALE_MS,
		update: LEASE_UPDATE_MS,
		retries: { retries: 100, minTimeout: 20, maxTimeout: 200 },
	});
	try {
		for (let n = 0; ; n++) {
			const slot = n as SlotNumber;
			const file = recordFile(storeDir, repository, slot);
			const path = pooledWorktreePath(storeDir, repository, slot);
			if ((await exists(file)) || (await exists(path))) continue;
			const record: PoolSlotRecord = {
				version: 1,
				repository,
				slot,
				path,
				holder: owner,
				lastState: admission.lastState,
				envHash: admission.envHash,
				blueprintDigest: null,
				releasedAt: null,
			};
			try {
				await withSlotLock(file, false, async () => {
					const unlease = await leaseSlot(file);
					try {
						await writeRecord(file, record);
					} catch (error) {
						await unlease().catch(() => {});
						throw error;
					}
					heldSlots.set(file, { owner, references: 1, record, unlease });
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOCKED") continue;
				throw error;
			}
			return newLease(record, storeDir, owner);
		}
	} finally {
		await unlockRepository().catch(() => {});
	}
}

/** The repository and slot of a pooled worktree path under `storeDir`, or undefined for any other path. */
function slotOf(storeDir: string, root: string): { repository: RepositoryId; slot: SlotNumber } | undefined {
	const worktrees = join(resolve(storeDir), "worktrees");
	const match = SLOT_NAME.exec(basename(root));
	if (!match) return undefined;
	try {
		if (canonicalizeWorktreePath(dirname(root)) !== canonicalizeWorktreePath(worktrees)) return undefined;
	} catch {
		return undefined;
	}
	return { repository: match[1] as RepositoryId, slot: Number(match[2]) as SlotNumber };
}

/** Who owns the worktree at `root`, and whether a live process holds it. Reads, never writes, and never throws. */
export async function pooledWorktreeHolder(storeDir: string, root: string): Promise<PooledWorktreeHolder> {
	const slot = slotOf(storeDir, root);
	if (slot === undefined) return "unpooled";
	const file = recordFile(storeDir, slot.repository, slot.slot);
	let record: PoolSlotRecord | undefined;
	try {
		record = await readRecord(file, storeDir, slot.repository, slot.slot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unpooled";
		record = undefined;
	}
	return { owner: record?.holder ?? null, held: await isHeld(file) };
}

/**
 * Holds the existing pooled slot at `root` for `owner`, who must own it, as when a session continues in its worktree.
 * Processes of the same owner share the slot, each with a lease of its own, so it stays held until the last one
 * releases it or stops. Undefined when `root` is not pooled or another holder owns it.
 */
export async function holdRestoredWorktree(
	storeDir: string,
	root: string,
	owner: PoolOwner,
): Promise<WorktreeLease | undefined> {
	const slot = slotOf(storeDir, root);
	if (slot === undefined) return undefined;
	const file = recordFile(storeDir, slot.repository, slot.slot);
	// Every change to the slot, this process's share of it included, happens under its record lock, so concurrent
	// holds, releases and evictions in this process or others see each other.
	return withSlotLock(file, true, async () => {
		const shared = heldSlots.get(file);
		if (shared !== undefined) {
			if (!sameOwner(shared.owner, owner)) return undefined;
			shared.references++;
			return newLease(shared.record, storeDir, owner);
		}
		const record = await readRecord(file, storeDir, slot.repository, slot.slot).catch(() => undefined);
		if (record === undefined || !sameOwner(record.holder, owner)) return undefined;
		const held: PoolSlotRecord = { ...record, releasedAt: null };
		const unlease = await leaseSlot(file);
		try {
			await writeRecord(file, held);
		} catch (error) {
			await unlease().catch(() => {});
			throw error;
		}
		heldSlots.set(file, { owner, references: 1, record: held, unlease });
		return newLease(held, storeDir, owner);
	});
}

/** Records the state a degraded restore published into a held slot, which differs from the admitted one. */
export async function recordPooledWorktreeState(lease: WorktreeLease, state: PoolLastState): Promise<void> {
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	await withSlotLock(file, true, async () => {
		const held = heldSlots.get(file);
		if (held === undefined || released.has(lease)) return;
		held.record = { ...held.record, lastState: state };
		await writeRecord(file, held.record);
	});
}

/**
 * Releases `lease`. When it was this process's last hold of the slot, this process's lease ends, and the record takes
 * `last` as the slot's known state, kept from the record when `last` is the snapshot the slot was restored or recorded
 * with. The slot becomes idle once no other process holds it either. A write failure keeps the record's earlier state,
 * which only makes the slot look changed, and the lease ends all the same.
 */
export async function releaseRestoredWorktree(lease: WorktreeLease, last?: PoolLastState): Promise<void> {
	if (released.has(lease)) return;
	released.add(lease);
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	const held = heldSlots.get(file);
	if (held === undefined) return;
	if (last !== undefined && last.snapshotId !== held.record.lastState.snapshotId) {
		held.record = { ...held.record, lastState: last };
	}
	let counted = false;
	try {
		await withSlotLock(file, true, async () => {
			counted = true;
			if (--held.references > 0) return;
			heldSlots.delete(file);
			try {
				const idle = (await otherLeases(file)) === 0;
				await writeRecord(file, { ...held.record, releasedAt: idle ? new Date().toISOString() : null });
			} finally {
				// Inside the record lock, so a new hold in this process never meets this lease still taken.
				await held.unlease().catch(() => {});
			}
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-release-failed", { file, ...failureDebugFields(error) });
		// The record lock was never taken: end this process's share all the same; the slot then only looks changed.
		if (!counted && --held.references <= 0) {
			heldSlots.delete(file);
			await held.unlease().catch(() => {});
		}
	}
}

/**
 * Gives up the slot of `lease` whose worktree was never published or has been removed: deletes its record and ends this
 * process's lease, so the slot is free again, whatever other holds of it this process has. Never throws: a record left
 * behind belongs to a slot without a directory, which eviction removes.
 */
export async function discardPooledWorktree(lease: WorktreeLease): Promise<void> {
	released.add(lease);
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	const end = async () => {
		const held = heldSlots.get(file);
		heldSlots.delete(file);
		await held?.unlease().catch(() => {});
	};
	try {
		await withSlotLock(file, true, async () => {
			try {
				if (heldSlots.has(file)) await rm(file, { force: true });
			} finally {
				await end();
			}
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-discard-failed", { file, ...failureDebugFields(error) });
		await end();
	}
}

export interface EvictIdleWorktreesOptions {
	/** Idle slots to keep: `snapshots.pool.maxIdlePerRepository`. */
	readonly maxIdle: number;
	/** The snapshot settings a slot's last state was recorded under, to tell an unchanged slot from a changed one. */
	readonly settings: WorktreeSnapshotSettings;
	readonly signal?: AbortSignal;
}

/**
 * Removes the oldest idle slots of `repository` beyond `maxIdle`, each under its record lock and only while no process
 * leases it: a slot whose directory
 * is gone loses its record, and a slot still exactly in its last state loses its worktree and record. A slot that
 * changed since, which may hold work no snapshot recorded, is kept. Resolves to the paths it removed; a failure keeps
 * that slot and never throws.
 */
export async function evictIdleWorktrees(
	storeDir: string,
	repository: RepositoryId,
	options: EvictIdleWorktreesOptions,
): Promise<string[]> {
	const directory = join(resolve(storeDir), "pool", repository);
	const idle: PoolSlotRecord[] = [];
	try {
		for (const name of await readdir(directory)) {
			const match = RECORD_NAME.exec(name);
			if (!match) continue;
			const slot = Number(match[1]) as SlotNumber;
			const file = recordFile(storeDir, repository, slot);
			const record = await readRecord(file, storeDir, repository, slot).catch(() => undefined);
			if (record !== undefined && !(await isHeld(file))) idle.push(record);
		}
	} catch (error) {
		reportDebug("storage", "worktree-pool-evict-failed", { directory, ...failureDebugFields(error) });
		return [];
	}
	// Newest released first; a slot whose holder stopped without releasing it counts as the oldest.
	idle.sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || a.slot - b.slot);
	let excess = idle.length - options.maxIdle;
	const removed: string[] = [];
	for (const record of idle.reverse()) {
		if (excess <= 0) break;
		if (await evictSlot(storeDir, record, options)) {
			removed.push(record.path);
			excess--;
		}
	}
	return removed;
}

async function evictSlot(storeDir: string, record: PoolSlotRecord, options: EvictIdleWorktreesOptions) {
	const file = recordFile(storeDir, record.repository, record.slot);
	if (heldSlots.has(file)) return false;
	try {
		return await withSlotLock(file, false, async () => {
			if (heldSlots.has(file)) return false;
			const current = await readRecord(file, storeDir, record.repository, record.slot);
			if (current === undefined || (await otherLeases(file)) > 0) return false;
			if (await exists(current.path)) {
				const { head, tree } = current.lastState;
				await verifyWorktree({ remotes: [], head, tree, envHash: current.envHash }, current.path, {
					settings: options.settings,
					signal: options.signal,
				});
				if (await holdsUnrecordedFiles(current.path, tree, options.signal)) return false;
				await removeRestoredWorktree(current.path, { storeDir, signal: options.signal, onWarning: () => {} });
			}
			await rm(file, { force: true });
			return true;
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-evict-kept", { path: record.path, ...failureDebugFields(error) });
		return false;
	}
}

/**
 * Whether the worktree at `path` holds files its recorded `tree` does not, that verification leaves out: staged content
 * that is neither HEAD's nor the tree's, an untracked file outside the tree, as when untracked files are not captured or are on the deny list, or an ignored file on the
 * deny list, such as `.env`. Other ignored files, build output and dependencies, are rebuilt and may go.
 */
async function holdsUnrecordedFiles(path: string, tree: string, signal: AbortSignal | undefined): Promise<boolean> {
	const git = { cwd: path, signal };
	// Staged content lives only in the index: it is recorded only when it is HEAD's or the recorded tree's.
	const stagedDiffers = async (base: string) =>
		(await runGit(["diff", "--cached", "--quiet", base, "--"], { ...git, allowExitCodes: [1] })).exitCode !== 0;
	if ((await stagedDiffers("HEAD")) && (await stagedDiffers(tree))) return true;
	const recorded = new Set(nulFields((await runGit(["ls-tree", "-r", "-z", "--name-only", tree], git)).stdout));
	const untracked = nulFields((await runGit(["ls-files", "-z", "--others", "--exclude-standard"], git)).stdout);
	if (untracked.some((file) => !recorded.has(file))) return true;
	const ignored = nulFields(
		(await runGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], git)).stdout,
	);
	return ignored.some((file) => !file.endsWith("/") && isDeniedSnapshotPath(file));
}
