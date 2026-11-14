import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { failureDebugFields, reportDebug } from "../debug.ts";
import { sha256Hex } from "./env-hash.ts";
import { isWorkspaceRestoreError } from "./errors.ts";
import { nulFields, runGit } from "./git.ts";
import { canonicalizeWorktreePath } from "./paths.ts";
import { isDeniedSnapshotPath } from "./policy.ts";
import { removeRestoredWorktree, resetPooledWorktree, verifyWorktree } from "./restore.ts";
import type { SnapshotBlobStore, WorktreeRestoreWarning, WorktreeSnapshot, WorktreeSnapshotSettings } from "./types.ts";

/**
 * The per-machine pool of restored worktrees (#4748). A session resume restores into a slot at a stable path,
 * `<storeDir>/worktrees/<repositoryId>-<n>`, described by one record, `<storeDir>/pool/<repositoryId>/<n>.json`, and
 * leased while a session works in it: each process that holds a slot has a lease lock of its own next to the record,
 * and a lock on the record itself serializes changes to the slot. Only session resumes admit slots: worktrees restored
 * for workflow runs, by the SDK into a chosen directory, or by earlier versions have no record and are never pooled.
 *
 * A slot's owner is the holder that last took it, whether it still holds the lease or released it when it closed;
 * only the owner continues in it. {@link claimIdleWorktree} is the one way an existing worktree is rewritten: it takes
 * an idle slot that holds nothing but its recorded state for another snapshot, and the slot's owner with it.
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
	/**
	 * The state a claim is resetting the slot to, set before its files change and cleared once they verify: a slot that
	 * still has it holds a mix of two recorded states, never anything else, and is never claimed.
	 */
	readonly resetting?: PoolLastState;
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

function sameOwner(a: PoolOwner, b: PoolOwner): boolean {
	return a.kind === b.kind && a.id === b.id;
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

function isState(value: unknown): value is PoolLastState {
	const state = value as Partial<PoolLastState> | null | undefined;
	return (
		typeof state?.head === "string" &&
		typeof state.tree === "string" &&
		(state.snapshotId === null || typeof state.snapshotId === "string")
	);
}

async function readRecord(file: string, storeDir: string, repository: RepositoryId, slot: SlotNumber) {
	const record = JSON.parse(await readFile(file, "utf8")) as Partial<PoolSlotRecord> | null;
	const valid =
		record?.version === 1 &&
		record.repository === repository &&
		record.slot === slot &&
		record.path === pooledWorktreePath(storeDir, repository, slot) &&
		isOwner(record.holder) &&
		isState(record.lastState) &&
		typeof record.envHash === "string" &&
		(record.blueprintDigest === null || typeof record.blueprintDigest === "string") &&
		(record.releasedAt === null || typeof record.releasedAt === "string") &&
		(record.resetting === undefined || isState(record.resetting));
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

/** The readable records of the slots of `repository`, and whether a live process holds each. Rejects when the pool cannot be listed. */
async function slotRecords(
	storeDir: string,
	repository: RepositoryId,
): Promise<{ readonly record: PoolSlotRecord; readonly held: boolean }[]> {
	const slots: { record: PoolSlotRecord; held: boolean }[] = [];
	for (const name of await readdir(join(resolve(storeDir), "pool", repository))) {
		const match = RECORD_NAME.exec(name);
		if (!match) continue;
		const slot = Number(match[1]) as SlotNumber;
		const file = recordFile(storeDir, repository, slot);
		const record = await readRecord(file, storeDir, repository, slot).catch(() => undefined);
		if (record !== undefined) slots.push({ record, held: await isHeld(file) });
	}
	return slots;
}

/** The records of the slots of `repository` no live process holds. Rejects when the pool cannot be listed. */
async function idleRecords(storeDir: string, repository: RepositoryId): Promise<PoolSlotRecord[]> {
	return (await slotRecords(storeDir, repository)).filter((slot) => !slot.held).map((slot) => slot.record);
}

/** Newest released first; a slot whose holder stopped without releasing it counts as the oldest. */
function byNewestRelease(a: PoolSlotRecord, b: PoolSlotRecord): number {
	return (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || a.slot - b.slot;
}

/**
 * Removes the oldest idle slots of `repository` beyond `maxIdle`, each under its record lock and only while no process
 * leases it: a slot whose directory
 * is gone loses its record, and a slot still exactly in its last state loses its worktree and record. A slot that
 * changed since, which may hold work no snapshot recorded, is kept. A slot a claim stopped resetting holds nothing but
 * recorded states and is never claimed, so it goes whatever `maxIdle` says. Resolves to the paths it removed; a failure
 * keeps that slot and never throws.
 */
export async function evictIdleWorktrees(
	storeDir: string,
	repository: RepositoryId,
	options: EvictIdleWorktreesOptions,
): Promise<string[]> {
	let idle: PoolSlotRecord[];
	try {
		idle = await idleRecords(storeDir, repository);
	} catch (error) {
		const directory = join(resolve(storeDir), "pool", repository);
		reportDebug("storage", "worktree-pool-evict-failed", { directory, ...failureDebugFields(error) });
		return [];
	}
	const removed: string[] = [];
	for (const record of idle.filter((slot) => slot.resetting !== undefined)) {
		if (await evictSlot(storeDir, record, options)) removed.push(record.path);
	}
	const kept = idle.filter((slot) => slot.resetting === undefined).sort(byNewestRelease);
	let excess = kept.length - options.maxIdle;
	for (const record of kept.reverse()) {
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
	try {
		return await withSlotLock(file, false, async () => {
			if (heldSlots.has(file)) return false;
			const current = await readRecord(file, storeDir, record.repository, record.slot);
			if (current === undefined || (await otherLeases(file)) > 0) return false;
			if (await exists(current.path)) {
				const stopped = current.resetting !== undefined;
				if (!stopped && !(await holdsRecordedStateOnly(current, options.settings, options.signal))) return false;
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
 * Whether the slot of `record` holds exactly its last state: its HEAD and policy tree, and nothing verification leaves
 * out that no snapshot recorded. Rejects when it cannot tell, as when the slot's HEAD or files changed.
 */
async function holdsRecordedStateOnly(
	record: PoolSlotRecord,
	settings: WorktreeSnapshotSettings,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const { head, tree } = record.lastState;
	await verifyWorktree({ remotes: [], head, tree, envHash: record.envHash }, record.path, { settings, signal });
	return !(await holdsUnrecordedFiles(record.path, tree, signal));
}

/** Why {@link claimIdleWorktree} took no slot. */
export type NoIdleWorktreeReason = "none" | "busy" | "dirty" | "fetch-failed" | "reset-failed" | "verify-failed";

export interface NoIdleWorktree {
	readonly claimed: false;
	/** Why the last candidate was not taken, or `none` when the repository has no idle slot. */
	readonly reason: NoIdleWorktreeReason;
}

/** A slot a claim reset to the snapshot, held for the claiming owner: release `lease` exactly once. */
export interface ClaimedWorktree {
	readonly claimed: true;
	readonly lease: WorktreeLease;
	readonly warnings: readonly WorktreeRestoreWarning[];
}

export interface ClaimIdleWorktreeOptions {
	readonly storeDir: string;
	readonly owner: PoolOwner;
	/** The snapshot settings each slot's last state was recorded under, to tell an unchanged slot from a changed one. */
	readonly settings: WorktreeSnapshotSettings;
	/** Blob storage holding the snapshot's patches and bundle. */
	readonly blobs?: SnapshotBlobStore;
	readonly signal?: AbortSignal;
}

/**
 * Takes an idle slot of `snapshot`'s repository for `options.owner` and resets it to the snapshot (#4748), keeping the
 * files Git ignores, such as dependencies and build output, so the blueprint's maintenance has little to rebuild.
 * Candidates are the slots no live process holds, those last restored for the snapshot's environment first, then the
 * most recently released. Only a slot that holds exactly its recorded last state, and nothing no snapshot recorded, is
 * taken, so its previous owner restores its snapshot elsewhere and loses nothing. The slot is marked before its files
 * change and unmarked once they verify, so a claim stopped half way leaves a slot no claim takes and eviction removes.
 * Resolves to the held slot with HEAD and tree equal to the snapshot's, or to why none was taken: then the caller
 * restores fresh. Rejects only when `signal` aborted.
 */
export async function claimIdleWorktree(
	snapshot: WorktreeSnapshot,
	options: ClaimIdleWorktreeOptions,
): Promise<ClaimedWorktree | NoIdleWorktree> {
	const storeDir = resolve(options.storeDir);
	let slots: { readonly record: PoolSlotRecord; readonly held: boolean }[];
	try {
		slots = await slotRecords(storeDir, repositoryIdOf(snapshot.remotes));
	} catch {
		return { claimed: false, reason: "none" };
	}
	const candidates = slots.filter((slot) => !slot.held).map((slot) => slot.record);
	const sameEnvironment = (record: PoolSlotRecord) => (record.envHash === snapshot.envHash ? 0 : 1);
	candidates.sort((a, b) => sameEnvironment(a) - sameEnvironment(b) || byNewestRelease(a, b));
	let reason: NoIdleWorktreeReason = candidates.length < slots.length ? "busy" : "none";
	for (const candidate of candidates) {
		options.signal?.throwIfAborted();
		const outcome = await claimSlot(storeDir, candidate, snapshot, options);
		if (outcome.claimed) return outcome;
		reason = outcome.reason;
	}
	options.signal?.throwIfAborted();
	return { claimed: false, reason };
}

async function claimSlot(
	storeDir: string,
	candidate: PoolSlotRecord,
	snapshot: WorktreeSnapshot,
	options: ClaimIdleWorktreeOptions,
): Promise<ClaimedWorktree | NoIdleWorktree> {
	const file = recordFile(storeDir, candidate.repository, candidate.slot);
	const target: PoolLastState = { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree };
	let taken: { before: PoolSlotRecord; held: HeldSlot } | NoIdleWorktreeReason;
	try {
		// The owner and the mark change with the lease, under the record lock, so the previous owner never holds the slot
		// again once the claim took it.
		taken = await withSlotLock(file, false, async () => {
			if (heldSlots.has(file) || (await otherLeases(file)) > 0) return "busy";
			const before = await readRecord(file, storeDir, candidate.repository, candidate.slot);
			if (before === undefined || before.resetting !== undefined) return "dirty";
			if (!(await holdsRecordedStateOnly(before, options.settings, options.signal).catch(() => false))) {
				return "dirty";
			}
			const marked: PoolSlotRecord = { ...before, holder: options.owner, releasedAt: null, resetting: target };
			const unlease = await leaseSlot(file);
			try {
				await writeRecord(file, marked);
			} catch (error) {
				await unlease().catch(() => {});
				throw error;
			}
			const held: HeldSlot = { owner: options.owner, references: 1, record: marked, unlease };
			heldSlots.set(file, held);
			return { before, held };
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-claim-skipped", { file, ...failureDebugFields(error) });
		return { claimed: false, reason: (error as NodeJS.ErrnoException).code === "ELOCKED" ? "busy" : "dirty" };
	}
	if (typeof taken === "string") return { claimed: false, reason: taken };
	const { before, held } = taken;
	let resetting = false;
	try {
		const warnings = await resetPooledWorktree(snapshot, before.path, before.lastState, {
			storeDir,
			blobs: options.blobs,
			signal: options.signal,
			beforeReset: async () => {
				resetting = true;
			},
		});
		const claimed: PoolSlotRecord = {
			...before,
			holder: options.owner,
			lastState: target,
			envHash: snapshot.envHash,
			releasedAt: null,
		};
		await withSlotLock(file, true, () => writeRecord(file, claimed));
		held.record = claimed;
		return { claimed: true, lease: newLease(claimed, storeDir, options.owner), warnings };
	} catch (error) {
		reportDebug("storage", "worktree-pool-claim-failed", { file, ...failureDebugFields(error) });
		// A slot whose files never changed goes back to its owner as it was; one changed half way stays marked.
		const end = async () => {
			heldSlots.delete(file);
			await held.unlease().catch(() => {});
		};
		try {
			await withSlotLock(file, true, async () => {
				try {
					if (!resetting) await writeRecord(file, before);
				} finally {
					await end();
				}
			});
		} catch (cause) {
			reportDebug("storage", "worktree-pool-claim-undo-failed", { file, ...failureDebugFields(cause) });
			await end();
		}
		const verifyFailed = isWorkspaceRestoreError(error) && error.code === "tree-mismatch";
		return { claimed: false, reason: !resetting ? "fetch-failed" : verifyFailed ? "verify-failed" : "reset-failed" };
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
