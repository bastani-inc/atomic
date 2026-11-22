import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, toNamespacedPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { failureDebugFields, reportDebugAsync as reportDebug } from "../debug.ts";
import { renameWithRetry } from "../rename-retry.ts";
import { isWorkspaceRestoreError } from "./errors.ts";
import { nulFields, runGit } from "./git.ts";
import { processesWorkIn } from "./in-use.ts";
import { canonicalizeWorktreePathAsync } from "./paths.ts";
import { isDeniedSnapshotPath } from "./policy.ts";
import { HOST, holderRuns as processHolderRuns, thisProcess } from "./process-holder.js";
import { type RepositoryId, sharedRepositoryIdOf, sharedRepositoryIdsOf } from "./repository-identity.ts";
import { pooledWorktreeStore, resetPooledWorktree, verifyWorktree } from "./restore.ts";
import { lockShared, sharedClockNow, windowsTemporaryFiles } from "./shared-clock.ts";
import type { SnapshotBlobStore, WorktreeRestoreWarning, WorktreeSnapshot, WorktreeSnapshotSettings } from "./types.ts";

export { processStartToken } from "../process-start-token.js";

/**
 * The per-machine pool of restored worktrees (#4748). A session resume restores into a slot at a stable path,
 * `<storeDir>/worktrees/<repositoryId>-<n>`, described by one record, `<storeDir>/pool/<repositoryId>/<n>.json`, and
 * leased while a session works in it: each process that holds a slot has a lease lock of its own next to the record,
 * and a lock on the record itself serializes changes to the slot. Only session resumes admit slots: worktrees restored
 * by the SDK into a chosen directory, or by earlier versions (including for their workflow runs) have no record and
 * are never pooled.
 *
 * A slot's owner is the holder that last took it, whether it still holds the lease or released it when it closed;
 * only the owner continues in it. {@link claimIdleWorktree} is the one way an existing worktree is rewritten: it takes
 * an idle slot that holds nothing but its recorded state for another snapshot, and the slot's owner with it.
 *
 * Only checkouts of one repository share slots (#4989): those whose remotes name it, local paths resolved against the
 * checkout's root. A checkout without remotes is never pooled: nothing on record tells its repository apart from
 * another remote-less one, so its slots and their ignored files, such as secrets and dependencies, would go to them.
 */

export type { RepositoryId } from "./repository-identity.ts";
export { repositoryIdOf } from "./repository-identity.ts";

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
	/**
	 * Names the take of the slot by its holder (#4830): a new one each time a holder admits or claims the slot, kept when
	 * the same holder holds it again. A process whose copy of the record no longer matches it lost the slot. Records
	 * written before #4830 have none.
	 */
	readonly tenancy?: string;
}

/** What a session resume restores into a new slot. */
export interface PoolAdmission {
	readonly storeDir: string;
	readonly remotes: readonly string[];
	/** The checkout's root, which relative-path remotes such as `../upstream` are relative to (#4989). */
	readonly root?: string;
	/** The state the restore is about to publish. */
	readonly lastState: PoolLastState;
	readonly envHash: string;
	readonly signal?: AbortSignal;
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
const POOL_LOCK_POLL_MS = 50;
const POOL_LOCK_WAIT_MS = 60_000;
export const POOL_LOCK_REFUSED_MS = 10_000;
/**
 * How long after a lease went stale it still keeps its slot from being claimed or evicted, and its lock from being
 * removed (#4830): a holder stalled for a short while, by an overloaded host or a debugger, keeps its slot and its lease.
 * Only a lease last refreshed more than `LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS` ago lets another process take the slot.
 */
export const LEASE_CLAIM_GRACE_MS = 60_000;
/**
 * How long a lease of this host that names no start of its process keeps its slot without being refreshed while a
 * process of its id runs (#4990): such a lease, written where the start cannot be read or before #4990, cannot tell its
 * holder from a later process given the same id after a container restart or a reboot, so past this it is judged by
 * its age alone. A lease that names its holder's start is kept for as long as that process runs, however long it was
 * suspended.
 */
export const UNSTARTED_LEASE_LIMIT_MS = 24 * 60 * 60_000;
const SLOT_NAME = /^([0-9a-f]{24})-(\d{1,6})$/;
const RECORD_NAME = /^(\d{1,6})\.json$/;

export function pooledWorktreePath(storeDir: string, repository: RepositoryId, slot: SlotNumber): string {
	return join(resolve(storeDir), "worktrees", `${repository}-${slot}`);
}

function recordFile(storeDir: string, repository: RepositoryId, slot: SlotNumber): string {
	return join(resolve(storeDir), "pool", repository, `${slot}.json`);
}

interface HeldSlot {
	readonly owner: PoolOwner;
	references: number;
	/** The record as this process last wrote it: its holder and tenancy say whose the slot is. */
	record: PoolSlotRecord;
	/** Releases this process's lease of the slot. */
	unlease: () => Promise<void>;
	/** Another process removed this process's lease once it went stale: the slot may have been taken (#4830). */
	compromised: boolean;
	/** The slot was taken from this hold, or its record removed: nothing of the hold writes to it again (#4830). */
	lost: boolean;
}

/** The slots this process holds, by record file. A second hold of a slot by its owner shares the lease. */
const heldSlots = new Map<string, HeldSlot>();
/** The hold each lease of this process shares. */
const leaseHolds = new WeakMap<WorktreeLease, HeldSlot>();
const released = new WeakSet<WorktreeLease>();
let processLease: Promise<string> | undefined;
/**
 * Names this process's leases: its host and pid, a random part, as the pid alone could be reused by a later process,
 * and when this process started, where that can be read (#4990, #5141). Read once, on first use.
 */
function ownLease(): Promise<string> {
	processLease ??= thisProcess().then(
		({ start: started }) =>
			`${HOST}-${process.pid}-${randomUUID().slice(0, 8)}${started === undefined ? "" : `-${started}`}`,
	);
	return processLease;
}
/**
 * A lease name after the record's: the holder's host and pid, and when the holder started. Leases written before
 * #4830 name no host, and those written before #4990 no start.
 */
const LEASE_NAME = /^([0-9a-f]{12})-(\d+)-[0-9a-f]{8}(?:-([0-9a-f]{12}))?\.lease\.lock$/;

/**
 * Whether the lease named `name` belongs to a process of this host that still runs (#4830): a holder stalled for
 * minutes may still write to its slot. A process this one may not signal runs too. A lease that names when its holder
 * started belongs to a process of that id that started then, never to a later one given the id (#4990), on Windows too
 * (#5141). A lease of another host, or one naming no host, is judged by its age alone.
 */
async function holderRuns(name: string, age: number): Promise<boolean> {
	const lease = LEASE_NAME.exec(name);
	if (lease === null) return false;
	return processHolderRuns({ host: lease[1]!, pid: Number(lease[2]), start: lease[3] }, age, UNSTARTED_LEASE_LIMIT_MS);
}

function sameOwner(a: PoolOwner, b: PoolOwner): boolean {
	return a.kind === b.kind && a.id === b.id;
}

export interface SetAsideNote {
	readonly startedAt: string;
	readonly logs: string;
}

/** A set-aside worktree directory's exact 64-bit device, inode, and birth time as decimal strings. */
interface SetAsideDirectoryIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly birthtimeNs: string;
}

const LEGACY_DIRECTORY_STRING = /^\d+:\d+:-?\d+$/;

function isSetAsideDirectoryIdentity(value: unknown): value is SetAsideDirectoryIdentity {
	if (typeof value !== "object" || value === null) return false;
	const identity = value as Partial<SetAsideDirectoryIdentity>;
	return (
		typeof identity.dev === "string" &&
		/^\d+$/.test(identity.dev) &&
		typeof identity.ino === "string" &&
		/^\d+$/.test(identity.ino) &&
		typeof identity.birthtimeNs === "string" &&
		/^-?\d+$/.test(identity.birthtimeNs)
	);
}

function sameSetAsideDirectoryIdentity(a: SetAsideDirectoryIdentity, b: SetAsideDirectoryIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

/** Legacy `dev:ino:trunc(birthtimeMs)` projection for interoperability with older readers and set-aside notes. */
function legacyDirectoryString(identity: SetAsideDirectoryIdentity): string {
	const birthtimeNs = BigInt(identity.birthtimeNs);
	const birthtimeMs = Number(birthtimeNs / 1_000_000_000n) * 1000 + Number(birthtimeNs % 1_000_000_000n) / 1_000_000;
	return `${Number(BigInt(identity.dev))}:${Number(BigInt(identity.ino))}:${Math.trunc(birthtimeMs)}`;
}

const setAsideHere = new Map<string, SetAsideDirectoryIdentity | undefined>();

function setAsideFile(storeDir: string, path: string): string {
	const key = createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
	return join(resolve(storeDir), "pool", "set-aside", `${key}.json`);
}

async function directoryIdentity(path: string): Promise<SetAsideDirectoryIdentity | undefined> {
	try {
		const found = await stat(path, { bigint: true });
		return {
			dev: String(found.dev),
			ino: String(found.ino),
			birthtimeNs: String(found.birthtimeNs),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

export async function setAsideWorktree(storeDir: string, path: string, note: SetAsideNote): Promise<void> {
	const identity = await directoryIdentity(path).catch(() => undefined);
	const directory = identity === undefined ? undefined : legacyDirectoryString(identity);
	setAsideHere.set(resolve(path), identity);
	const file = setAsideFile(storeDir, path);
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	await writeFile(
		temporary,
		JSON.stringify({ path: resolve(path), directory, directoryIdentity: identity, ...note }),
		{ mode: 0o600 },
	);
	await renameWithRetry(temporary, file);
}

async function readSetAsideNote(
	storeDir: string,
	path: string,
): Promise<(Partial<SetAsideNote> & { directory?: unknown; directoryIdentity?: unknown }) | "absent" | "unreadable"> {
	let text: string;
	try {
		text = await readFile(setAsideFile(storeDir, path), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
	}
	try {
		const note = JSON.parse(text) as unknown;
		return typeof note === "object" && note !== null ? note : {};
	} catch {
		return {};
	}
}

async function sameDirectoryIdentity(path: string, expected: SetAsideDirectoryIdentity | undefined): Promise<boolean> {
	if (expected === undefined) return true;
	try {
		const current = await directoryIdentity(path);
		return current !== undefined && sameSetAsideDirectoryIdentity(current, expected);
	} catch {
		return true;
	}
}

async function sameSetAsideNote(
	path: string,
	note: { readonly directory?: unknown; readonly directoryIdentity?: unknown },
): Promise<boolean> {
	if ("directoryIdentity" in note && note.directoryIdentity !== undefined) {
		if (!isSetAsideDirectoryIdentity(note.directoryIdentity)) return true;
		return sameDirectoryIdentity(path, note.directoryIdentity);
	}
	if (typeof note.directory !== "string" || !LEGACY_DIRECTORY_STRING.test(note.directory)) return true;
	try {
		const current = await directoryIdentity(path);
		return current !== undefined && legacyDirectoryString(current) === note.directory;
	} catch {
		return true;
	}
}

export async function worktreeSetAside(storeDir: string, path: string): Promise<boolean> {
	if (setAsideHere.has(resolve(path)) && (await sameDirectoryIdentity(path, setAsideHere.get(resolve(path)))))
		return true;
	const note = await readSetAsideNote(storeDir, path);
	if (note === "absent") return false;
	if (note === "unreadable") return true;
	return sameSetAsideNote(path, note);
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

function refusedForAMoment(error: unknown, since: number): boolean {
	return (
		(error as NodeJS.ErrnoException).code === "EPERM" &&
		process.platform === "win32" &&
		Date.now() - since < POOL_LOCK_REFUSED_MS
	);
}

function lockHeldAndWaiting(error: unknown, wait: boolean, startedAt: number): boolean {
	return wait && (error as NodeJS.ErrnoException).code === "ELOCKED" && Date.now() - startedAt < POOL_LOCK_WAIT_MS;
}

/**
 * Locks `path` with the restore-record constants: a stopped process loses the lock after 30 seconds. `wait` retries a
 * lock another process holds for up to 60 seconds with 50 ms polls, as when a slot's record is briefly being written.
 */
async function lockPath(
	path: string,
	wait: boolean,
	onLost?: (error: Error) => void,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const startedAt = Date.now();
	let refusedSince: number | undefined;
	for (;;) {
		signal?.throwIfAborted();
		try {
			return await lockShared(path, {
				realpath: false,
				stale: LEASE_STALE_MS,
				update: LEASE_UPDATE_MS,
				retries: 0,
				onCompromised: (error) => {
					reportDebug("storage", "worktree-pool-lock-lost", { path, ...failureDebugFields(error) });
					onLost?.(error);
				},
			});
		} catch (error) {
			const since = refusedSince ?? Date.now();
			if (refusedForAMoment(error, since)) refusedSince = since;
			else if (lockHeldAndWaiting(error, wait, startedAt)) refusedSince = undefined;
			else throw error;
		}
		await sleep(POOL_LOCK_POLL_MS, undefined, { signal });
	}
}

/** A slot's record lock as {@link withSlotLock} holds it. */
interface SlotLock {
	/**
	 * Whether this process still holds the lock (#4991): false once it was compromised, or once another process broke it
	 * as stale and took it, as while this one was suspended past the stale time. Checked right before each change to
	 * the slot, its record or its files, which is never made without the lock.
	 */
	held(): Promise<boolean>;
}

/**
 * Where the holder of the slot's record lock `file` names its take of the lock: a random token each take writes once it
 * holds the lock, so a process that lost the lock to another, even to a new lock directory at the same place, reads
 * another token or none (#4991). It sits beside the lock directory, which must stay empty for a stale lock to be
 * removable.
 */
function lockTokenFile(file: string): string {
	return `${file}.lock-holder`;
}

async function readLockToken(file: string): Promise<string | undefined> {
	try {
		return await readFile(lockTokenFile(file), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Runs `action` holding the slot's record lock, which serializes changes to one slot across processes: leases are
 * taken and released, and slots evicted, only under it. Without `wait`, a busy slot rejects with `ELOCKED`. The lock is
 * only removed while this process still holds it, so a lock another process took over is never removed under it.
 */
async function withSlotLock<T>(
	file: string,
	wait: boolean,
	action: (lock: SlotLock) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	let lost = false;
	const unlock = await lockPath(
		file,
		wait,
		() => {
			lost = true;
		},
		signal,
	);
	const token = randomUUID();
	let named = false;
	try {
		const temporary = `${lockTokenFile(file)}.${await ownLease()}.tmp`;
		await writeFile(temporary, token, { mode: 0o600 });
		await renameWithRetry(temporary, lockTokenFile(file));
		named = true;
	} catch (error) {
		reportDebug("storage", "worktree-pool-lock-token-failed", { file, ...failureDebugFields(error) });
	}
	const lock: SlotLock = { held: async () => named && !lost && (await readLockToken(file)) === token };
	try {
		return await action(lock);
	} finally {
		if (!named) await unlock().catch(() => {});
		else if (await lock.held()) {
			await rm(lockTokenFile(file), { force: true }).catch(() => {});
			await unlock().catch(() => {});
		}
	}
}

/**
 * Moves the record at `file` aside when it still is `expected`, in one rename no other writer interleaves with, and
 * resolves to where it went; a record that changed, or is gone, is put back as it is and resolves to undefined (#4991).
 * Until {@link giveBackRecord} or {@link putRecord}, the slot has no record: no hold, claim or eviction takes it.
 */
async function takeRecord(file: string, expected: PoolSlotRecord): Promise<string | undefined> {
	const taken = `${file}.${await ownLease()}.taken`;
	try {
		await renameWithRetry(file, taken);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const text = await readFile(taken, "utf8").catch(() => undefined);
	let same = false;
	try {
		same = text !== undefined && JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
	} catch {
		same = false;
	}
	if (same) return taken;
	await giveBackRecord(file, taken);
	return undefined;
}

/** Puts a taken record back, unless a writer wrote the slot's record meanwhile: then that record stands. */
async function giveBackRecord(file: string, taken: string): Promise<void> {
	try {
		await link(taken, file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await rm(taken, { force: true });
}

/**
 * Writes `record` as the slot's record in place of the one {@link takeRecord} moved to `taken`, only when no writer
 * wrote one meanwhile; resolves to false, writing nothing, when one did, whose record stands (#4991).
 */
async function putRecord(file: string, taken: string, record: PoolSlotRecord): Promise<boolean> {
	try {
		const published = await createRecord(file, record);
		await rm(taken, { force: true }).catch((error) => {
			reportDebug("storage", "worktree-pool-taken-cleanup-failed", { file, ...failureDebugFields(error) });
		});
		return published;
	} catch (error) {
		await giveBackRecord(file, taken).catch(() => {});
		throw error;
	}
}

/** The error an action that lost its slot's record lock stops with, which callers treat as a busy slot (#4991). */
function lockLostError(file: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`lost the record lock of ${file}`), { code: "ELOCKED" });
}

/**
 * Takes this process's lease of the slot whose record is `file` for `held`: a lock of its own, so other processes can
 * share it. Losing the lock marks `held` compromised. Ending the lease removes its lock even once it was compromised.
 */
async function leaseSlot(
	file: string,
	held: Pick<HeldSlot, "compromised">,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	const lease = `${file}.${await ownLease()}.lease`;
	const unlock = await lockPath(
		lease,
		false,
		() => {
			held.compromised = true;
		},
		signal,
	);
	return () => unlock().catch(() => rm(`${lease}.lock`, { recursive: true, force: true }));
}

/** A hold of the slot whose record is `file` for `owner`, with this process's lease of it taken. */
async function takeSlot(
	file: string,
	owner: PoolOwner,
	record: PoolSlotRecord,
	signal?: AbortSignal,
): Promise<HeldSlot> {
	const held: HeldSlot = { owner, references: 1, record, unlease: async () => {}, compromised: false, lost: false };
	held.unlease = await leaseSlot(file, held, signal);
	return held;
}

/**
 * The leases other processes hold on the slot whose record is `file`, removing those last refreshed more than
 * {@link LEASE_CLAIM_GRACE_MS} after they went stale. A lease that cannot be read counts as held, and so does one whose
 * holder still runs on this host, as {@link holderRuns} tells (#4990). With `grace`, as before a
 * claim or an eviction, a lease that went stale within the grace period counts as held too (#4830).
 */
async function otherLeases(file: string, grace: boolean): Promise<number> {
	const prefix = `${basename(file)}.`;
	const own = `${basename(file)}.${await ownLease()}.lease.lock`;
	let live = 0;
	// Ages are measured by the clock of the filesystem holding the leases, which their holders stamp refreshes in, so a
	// holder on a host whose clock is off is judged by when it last refreshed its lease (#5050).
	const now = await sharedClockNow(dirname(file));
	for (const name of await readdir(dirname(file))) {
		if (!name.startsWith(prefix) || !name.endsWith(".lease.lock") || name === own) continue;
		const lock = join(dirname(file), name);
		let age: number;
		try {
			age = now - (await stat(lock)).mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") live++;
			continue;
		}
		const expired = age > LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS;
		if (age <= LEASE_STALE_MS || (grace && !expired) || (await holderRuns(name.slice(prefix.length), age))) live++;
		else if (expired) await rm(lock, { recursive: true, force: true }).catch(() => {});
	}
	return live;
}

/**
 * Whether a live process holds the slot whose record is `file`: this one, or another whose lease is not stale or, with
 * `grace`, went stale within the grace period.
 */
async function isHeld(file: string, grace: boolean): Promise<boolean> {
	if (heldSlots.has(file)) return true;
	return (await otherLeases(file, grace).catch(() => 1)) > 0;
}

/**
 * Under the slot's record lock: whether `held` still holds the slot, its record naming the same holder and tenancy as
 * this process's copy (#4830). When it does not, as when another process claimed the slot while this one was stalled,
 * the hold is lost: this process's lease ends, and nothing of the hold writes to the slot again. A record that is there
 * but cannot be read rejects, keeping the hold.
 */
async function stillHolds(file: string, storeDir: string, held: HeldSlot): Promise<boolean> {
	if (held.lost) return false;
	const { repository, slot } = held.record;
	let current: PoolSlotRecord | undefined;
	try {
		current = await readRecord(file, storeDir, repository, slot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (current !== undefined && sameOwner(current.holder, held.owner) && current.tenancy === held.record.tenancy) {
		return true;
	}
	held.lost = true;
	if (heldSlots.get(file) === held) heldSlots.delete(file);
	await held.unlease().catch(() => {});
	reportDebug("storage", "worktree-pool-slot-lost", { file, holder: current?.holder.id ?? null });
	return false;
}

async function writeRecord(file: string, record: PoolSlotRecord): Promise<void> {
	const temporary = `${file}.${await ownLease()}.tmp`;
	await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
	await renameWithRetry(temporary, file);
}

async function createRecord(file: string, record: PoolSlotRecord, retry = true): Promise<boolean> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	const data = JSON.stringify(record);
	let created = false;
	let published = false;
	let original: import("@bastani/atomic-natives").WindowsFileIdentity | null | undefined;
	try {
		// Let the runtime apply its actual umask at creation and write through the handle granted there.
		try {
			await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
			created = true;
		} catch (error) {
			const { code, syscall } = error as NodeJS.ErrnoException;
			created = code !== "EEXIST" && syscall !== "open";
			// Another holder's file has the drawn name: neither write to nor remove it, and draw a fresh name once.
			if (code === "EEXIST" && retry) return await createRecord(file, record, false);
			throw error;
		}
		const binding = windowsTemporaryFiles();
		if (binding) original = await binding.pinWindowsFile(toNamespacedPath(temporary)).catch(() => null);
		try {
			await link(temporary, file);
			published = true;
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		try {
			if (created) await rm(temporary, { force: true });
		} catch (error) {
			const { code } = error as NodeJS.ErrnoException;
			const refused = code === "EPERM" || code === "EACCES" || code === "EBUSY";
			if (
				!published ||
				!refused ||
				!original ||
				!(await original.removeHardLink(toNamespacedPath(temporary), toNamespacedPath(file)).catch(() => false))
			) {
				reportDebug("storage", "worktree-pool-temporary-cleanup-failed", { file, ...failureDebugFields(error) });
			}
		} finally {
			original?.close();
		}
	}
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
		(record.resetting === undefined || isState(record.resetting)) &&
		(record.tenancy === undefined || typeof record.tenancy === "string");
	return valid ? (record as PoolSlotRecord) : undefined;
}

function newLease(record: PoolSlotRecord, storeDir: string, held: HeldSlot): WorktreeLease {
	const lease: WorktreeLease = Object.freeze({
		storeDir: resolve(storeDir),
		repository: record.repository,
		slot: record.slot,
		path: record.path,
		owner: held.owner,
	});
	leaseHolds.set(lease, held);
	return lease;
}

/**
 * Takes the lowest free slot of the repository `admission.remotes` name and holds it for `owner`, before the restore
 * publishes into its path. A slot is free when it has neither a record nor a directory, and no other process is
 * changing it. Choosing and taking a slot run under a per-repository lock, so concurrent restores, in this process or
 * others, get different slots. Rejects when the remotes name no one repository, as for a checkout without remotes,
 * which is never pooled (#4989).
 */
export async function admitPooledWorktree(admission: PoolAdmission, owner: PoolOwner): Promise<WorktreeLease> {
	const storeDir = resolve(admission.storeDir);
	const repository = sharedRepositoryIdOf(admission.remotes, admission.root);
	if (repository === undefined) {
		throw new Error("the checkout's remotes name no one repository; its worktrees are not pooled");
	}
	const directory = join(storeDir, "pool", repository);
	await mkdir(directory, { recursive: true });
	let repositoryLost: Error | undefined;
	const unlockRepository = await lockPath(
		directory,
		true,
		(error) => {
			repositoryLost ??= error;
		},
		admission.signal,
	);
	try {
		for (let n = 0; ; n++) {
			if (repositoryLost !== undefined) throw repositoryLost;
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
				tenancy: randomUUID(),
			};
			let held: HeldSlot | undefined;
			try {
				held = await withSlotLock(
					file,
					false,
					async (lock) => {
						if (repositoryLost !== undefined) throw repositoryLost;
						if (!(await lock.held())) throw lockLostError(file);
						if ((await exists(file)) || (await exists(path))) return undefined;
						const taken = await takeSlot(file, owner, record, admission.signal);
						let published = false;
						try {
							if (repositoryLost !== undefined) throw repositoryLost;
							if (!(await lock.held())) throw lockLostError(file);
							if ((await exists(file)) || (await exists(path))) {
								await taken.unlease().catch(() => {});
								return undefined;
							}
							published = await createRecord(file, record);
							if (!(await lock.held())) throw lockLostError(file);
							if (repositoryLost !== undefined) throw repositoryLost;
							if (!published) {
								await taken.unlease().catch(() => {});
								return undefined;
							}
						} catch (error) {
							if (published) {
								const abandoned = await takeRecord(file, record).catch(() => undefined);
								if (abandoned !== undefined) await rm(abandoned, { force: true }).catch(() => {});
							}
							await taken.unlease().catch(() => {});
							throw error;
						}
						heldSlots.set(file, taken);
						return taken;
					},
					admission.signal,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOCKED") continue;
				throw error;
			}
			if (held === undefined) continue;
			return newLease(record, storeDir, held);
		}
	} finally {
		await unlockRepository().catch(() => {});
	}
}

/** The repository and slot of a pooled worktree path under `storeDir`, or undefined for any other path. */
async function slotOf(
	storeDir: string,
	root: string,
): Promise<{ repository: RepositoryId; slot: SlotNumber } | undefined> {
	const worktrees = join(resolve(storeDir), "worktrees");
	const match = SLOT_NAME.exec(basename(root));
	if (!match) return undefined;
	try {
		const [parent, pooled] = await Promise.all([
			canonicalizeWorktreePathAsync(dirname(root)),
			canonicalizeWorktreePathAsync(worktrees),
		]);
		if (parent !== pooled) return undefined;
	} catch {
		return undefined;
	}
	return { repository: match[1] as RepositoryId, slot: Number(match[2]) as SlotNumber };
}

/** Who owns the worktree at `root`, and whether a live process holds it. Reads, never writes, and never throws. */
export async function pooledWorktreeHolder(storeDir: string, root: string): Promise<PooledWorktreeHolder> {
	const slot = await slotOf(storeDir, root);
	if (slot === undefined) return "unpooled";
	const file = recordFile(storeDir, slot.repository, slot.slot);
	let record: PoolSlotRecord | undefined;
	try {
		record = await readRecord(file, storeDir, slot.repository, slot.slot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unpooled";
		record = undefined;
	}
	return { owner: record?.holder ?? null, held: await isHeld(file, false) };
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
	signal?: AbortSignal,
): Promise<WorktreeLease | undefined> {
	const slot = await slotOf(storeDir, root);
	if (slot === undefined) return undefined;
	const file = recordFile(storeDir, slot.repository, slot.slot);
	// Every change to the slot, this process's share of it included, happens under its record lock, so concurrent
	// holds, releases and evictions in this process or others see each other.
	return withSlotLock(
		file,
		true,
		async (lock) => {
			const shared = heldSlots.get(file);
			// A hold whose slot another holder took meanwhile is lost, never shared: the record says who holds it (#4830).
			if (shared !== undefined && (await stillHolds(file, storeDir, shared))) {
				if (!sameOwner(shared.owner, owner)) return undefined;
				shared.references++;
				return newLease(shared.record, storeDir, shared);
			}
			const record = await readRecord(file, storeDir, slot.repository, slot.slot).catch(() => undefined);
			if (record === undefined || !sameOwner(record.holder, owner)) return undefined;
			// The lease comes first, so a claim or an eviction from here on sees the slot held; the record is then written
			// only in place of the one read, so a hold that lost the record lock while suspended, and a claimer took the slot
			// meanwhile, takes nothing back: it gives up its lease and its session restores elsewhere (#4991).
			if (!(await lock.held())) return undefined;
			const taken = await takeSlot(file, owner, { ...record, releasedAt: null }, signal);
			let put = false;
			try {
				const read = await takeRecord(file, record);
				if (read !== undefined) {
					if (await lock.held()) put = await putRecord(file, read, taken.record);
					else await giveBackRecord(file, read);
				}
			} catch (error) {
				await taken.unlease().catch(() => {});
				throw error;
			}
			if (!put) {
				await taken.unlease().catch(() => {});
				return undefined;
			}
			heldSlots.set(file, taken);
			return newLease(taken.record, storeDir, taken);
		},
		signal,
	);
}

/**
 * Records the state a degraded restore published into a held slot, which differs from the admitted one. Writes only
 * while `lease` still holds the slot (#4830): resolves to false, writing nothing, once the lease was released or the
 * slot was lost to another holder.
 */
export async function recordPooledWorktreeState(lease: WorktreeLease, state: PoolLastState): Promise<boolean> {
	const held = leaseHolds.get(lease);
	if (held === undefined) return false;
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	return withSlotLock(file, true, async (lock) => {
		if (released.has(lease) || !(await stillHolds(file, lease.storeDir, held))) return false;
		if (!(await lock.held())) return false;
		held.record = { ...held.record, lastState: state };
		await writeRecord(file, held.record);
		return true;
	});
}

/**
 * Whether `lease` still holds its slot, checked against the slot's record under its lock (#4830): false once it was
 * released, or once another holder took the slot, as a claim does when a stalled holder's lease went stale. Then the
 * slot is another session's, and its former holder must not use it: it restores fresh instead. A lease another process
 * removed while the slot is still this holder's is taken again. When the record cannot be checked, the lease counts as
 * held unless it was removed. Never throws.
 */
export async function confirmPooledWorktreeLease(lease: WorktreeLease): Promise<boolean> {
	const held = leaseHolds.get(lease);
	if (held === undefined || released.has(lease) || held.lost) return false;
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	try {
		return await withSlotLock(file, true, async () => {
			if (!(await stillHolds(file, lease.storeDir, held))) return false;
			if (held.compromised) {
				held.unlease = await leaseSlot(file, held);
				held.compromised = false;
			}
			return true;
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-confirm-failed", { file, ...failureDebugFields(error) });
		return !held.compromised;
	}
}

/**
 * Releases `lease`. When it was this process's last hold of the slot, this process's lease ends, and the record takes
 * `last` as the slot's known state, kept from the record when `last` is the snapshot the slot was restored or recorded
 * with. The slot becomes idle once no other process holds it either. A write failure keeps the record's earlier state,
 * which only makes the slot look changed, and the lease ends all the same. The record is written only while the lease
 * still holds the slot (#4830): a slot another holder took keeps its record. Resolves to false when the slot was lost,
 * and to true otherwise once the lease was this process's last hold, or another hold remains.
 */
export async function releaseRestoredWorktree(lease: WorktreeLease, last?: PoolLastState): Promise<boolean> {
	if (released.has(lease)) return false;
	released.add(lease);
	const held = leaseHolds.get(lease);
	if (held === undefined || held.lost) return false;
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	if (last !== undefined && last.snapshotId !== held.record.lastState.snapshotId) {
		held.record = { ...held.record, lastState: last };
	}
	let counted = false;
	let kept = false;
	try {
		await withSlotLock(file, true, async (lock) => {
			counted = true;
			if (--held.references > 0) {
				kept = !held.lost;
				return;
			}
			try {
				// A slot another holder took while this one was stalled is its: this hold never writes it back (#4830).
				if (!(await stillHolds(file, lease.storeDir, held))) return;
				kept = true;
				const idle = (await otherLeases(file, false)) === 0;
				if (!(await lock.held())) return;
				await writeRecord(file, { ...held.record, releasedAt: idle ? new Date().toISOString() : null });
			} finally {
				// Inside the record lock, so a new hold in this process never meets this lease still taken.
				if (heldSlots.get(file) === held) heldSlots.delete(file);
				await held.unlease().catch(() => {});
			}
		});
	} catch (error) {
		reportDebug("storage", "worktree-pool-release-failed", { file, ...failureDebugFields(error) });
		// The record lock was never taken: end this process's share all the same; the slot then only looks changed.
		if (!counted && --held.references <= 0) {
			if (heldSlots.get(file) === held) heldSlots.delete(file);
			await held.unlease().catch(() => {});
		}
	}
	return kept;
}

/**
 * Gives up the slot of `lease` whose worktree was never published or has been removed: deletes its record and ends this
 * process's lease, so the slot is free again, whatever other holds of it this process has. Never throws: a record left
 * behind belongs to a slot without a directory, which eviction removes.
 */
export async function discardPooledWorktree(lease: WorktreeLease): Promise<void> {
	released.add(lease);
	const held = leaseHolds.get(lease);
	if (held === undefined || held.lost) return;
	const file = recordFile(lease.storeDir, lease.repository, lease.slot);
	const end = async () => {
		held.lost = true;
		if (heldSlots.get(file) !== held) return;
		heldSlots.delete(file);
		await held.unlease().catch(() => {});
	};
	try {
		await withSlotLock(file, true, async (lock) => {
			try {
				// A slot another holder took meanwhile keeps its record (#4830).
				if (heldSlots.get(file) === held && (await stillHolds(file, lease.storeDir, held)) && (await lock.held())) {
					await rm(file, { force: true });
				}
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

/** The readable records of the slots of `repository`. Rejects when the pool cannot be listed. */
async function slotRecords(storeDir: string, repository: RepositoryId): Promise<PoolSlotRecord[]> {
	const records: PoolSlotRecord[] = [];
	for (const name of await readdir(join(resolve(storeDir), "pool", repository))) {
		const match = RECORD_NAME.exec(name);
		if (!match) continue;
		const slot = Number(match[1]) as SlotNumber;
		const record = await readRecord(recordFile(storeDir, repository, slot), storeDir, repository, slot).catch(
			() => undefined,
		);
		if (record !== undefined) records.push(record);
	}
	return records;
}

/** The records of the slots of `repository` no live process holds. Rejects when the pool cannot be listed. */
async function idleRecords(storeDir: string, repository: RepositoryId): Promise<PoolSlotRecord[]> {
	const idle: PoolSlotRecord[] = [];
	for (const record of await slotRecords(storeDir, repository)) {
		if (!(await isHeld(recordFile(storeDir, repository, record.slot), true))) idle.push(record);
	}
	return idle;
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
	const setAside: PoolSlotRecord[] = [];
	const usable: PoolSlotRecord[] = [];
	for (const record of idle) ((await worktreeSetAside(storeDir, record.path)) ? setAside : usable).push(record);
	for (const record of setAside) {
		if (await processesWorkIn(record.path)) continue;
		if (await evictSlot(storeDir, record, options)) {
			removed.push(record.path);
			setAsideHere.delete(resolve(record.path));
			await rm(setAsideFile(storeDir, record.path), { force: true }).catch(() => {});
		}
	}
	for (const record of usable.filter((slot) => slot.resetting !== undefined)) {
		if (await evictSlot(storeDir, record, options)) removed.push(record.path);
	}
	const kept = usable.filter((slot) => slot.resetting === undefined).sort(byNewestRelease);
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
		return await withSlotLock(
			file,
			false,
			async (lock) => {
				if (heldSlots.has(file)) return false;
				const current = await readRecord(file, storeDir, record.repository, record.slot);
				if (current === undefined || (await otherLeases(file, true)) > 0) return false;
				let store: string | undefined;
				if (await exists(current.path)) {
					const stopped = current.resetting !== undefined;
					if (!stopped && !(await holdsRecordedStateOnly(current, options.settings, options.signal))) return false;
					store = await pooledWorktreeStore(storeDir, current.path, options.signal);
				}
				return removeSlot(file, current, store, lock);
			},
			options.signal,
		);
	} catch (error) {
		reportDebug("storage", "worktree-pool-evict-kept", { path: record.path, ...failureDebugFields(error) });
		return false;
	}
}

/**
 * Removes the slot of `current`, whose worktree, when it has one, belongs to `store` (#4991). Its record is taken aside
 * first, only while it is still `current`, the lock still this process's and no other process leases the slot, and the
 * worktree is moved aside in one rename; a holder that took the slot from a record read before then wrote it back, and
 * keeps it, worktree and all. Only then are the moved worktree and record deleted, which no hold, claim or admission
 * can reach: a process suspended while deleting them deletes nothing anyone holds.
 */
async function removeSlot(
	file: string,
	current: PoolSlotRecord,
	store: string | undefined,
	lock: SlotLock,
): Promise<boolean> {
	if (!(await lock.held())) return false;
	const taken = await takeRecord(file, current);
	if (taken === undefined) return false;
	if ((await otherLeases(file, true)) > 0 || !(await lock.held())) {
		await giveBackRecord(file, taken);
		return false;
	}
	const removed = store === undefined ? undefined : `${current.path}.removed-${randomUUID().slice(0, 8)}`;
	try {
		if (removed !== undefined) await renameWithRetry(current.path, removed);
	} catch (error) {
		await giveBackRecord(file, taken);
		throw error;
	}
	if ((await exists(file)) || !(await lock.held())) {
		if (removed !== undefined) await renameWithRetry(removed, current.path);
		await giveBackRecord(file, taken);
		return false;
	}
	await rm(taken, { force: true });
	if (removed !== undefined && store !== undefined) {
		await rm(removed, { recursive: true, force: true });
		await runGit(["worktree", "prune"], { cwd: dirname(store), env: { GIT_DIR: store } }).catch(() => {});
	}
	return true;
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

/**
 * Why {@link claimIdleWorktree} took no slot. `foreign`: the slot's worktree belongs to another repository's object
 * store, as a slot an earlier version pooled under an identity several repositories shared may (#4989).
 */
export type NoIdleWorktreeReason =
	| "none"
	| "busy"
	| "dirty"
	| "foreign"
	| "fetch-failed"
	| "reset-failed"
	| "verify-failed";

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
 * Candidates are the slots of the repository, those last restored for the snapshot's environment first, then the most
 * recently released; a slot a live process holds is busy. Only a slot that holds exactly its recorded last state, and
 * nothing no snapshot recorded, is taken, so its previous owner restores its snapshot elsewhere and loses nothing. The slot is marked before its files
 * change and unmarked once they verify, so a claim stopped half way leaves a slot no claim takes and eviction removes.
 * Only a slot of the snapshot's repository is a candidate, and only one whose worktree belongs to an object store of
 * that repository is taken (#4989): a snapshot of a checkout without remotes claims nothing. Resolves to the held slot
 * with HEAD and tree equal to the snapshot's, or to why none was taken: then the caller restores fresh. Rejects only
 * when `signal` aborted.
 */
export async function claimIdleWorktree(
	snapshot: WorktreeSnapshot,
	options: ClaimIdleWorktreeOptions,
): Promise<ClaimedWorktree | NoIdleWorktree> {
	const storeDir = resolve(options.storeDir);
	// Slots an earlier version admitted under the remotes as spelled are the repository's too (#4748), when that spelling
	// named this repository alone (#4989).
	const repositories = sharedRepositoryIdsOf(snapshot.remotes, snapshot.root);
	const stores = new Set(await Promise.all(repositories.map((repository) => repositoryStore(storeDir, repository))));
	const candidates: PoolSlotRecord[] = [];
	for (const repository of repositories) {
		candidates.push(...(await slotRecords(storeDir, repository).catch(() => [])));
	}
	const sameEnvironment = (record: PoolSlotRecord) => (record.envHash === snapshot.envHash ? 0 : 1);
	candidates.sort((a, b) => sameEnvironment(a) - sameEnvironment(b) || byNewestRelease(a, b));
	// A slot a live process holds is busy: each candidate's lease is checked under its record lock.
	let reason: NoIdleWorktreeReason = "none";
	for (const candidate of candidates) {
		options.signal?.throwIfAborted();
		const outcome = await claimSlot(storeDir, candidate, snapshot, stores, options);
		if (outcome.claimed) return outcome;
		reason = outcome.reason;
	}
	options.signal?.throwIfAborted();
	return { claimed: false, reason };
}

/** The object store, as a canonical path, that pooled worktrees of `repository` belong to. */
function repositoryStore(storeDir: string, repository: RepositoryId): Promise<string> {
	return canonicalizeWorktreePathAsync(join(storeDir, "repositories", `${repository}.git`));
}

/** Whether the worktree at `path` belongs to one of `stores`; false when that cannot be told. */
async function belongsTo(storeDir: string, path: string, stores: ReadonlySet<string>, signal?: AbortSignal) {
	try {
		return stores.has(await canonicalizeWorktreePathAsync(await pooledWorktreeStore(storeDir, path, signal)));
	} catch {
		return false;
	}
}

async function claimSlot(
	storeDir: string,
	candidate: PoolSlotRecord,
	snapshot: WorktreeSnapshot,
	stores: ReadonlySet<string>,
	options: ClaimIdleWorktreeOptions,
): Promise<ClaimedWorktree | NoIdleWorktree> {
	const file = recordFile(storeDir, candidate.repository, candidate.slot);
	const target: PoolLastState = { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree };
	let taken: { before: PoolSlotRecord; held: HeldSlot } | NoIdleWorktreeReason;
	try {
		// The owner and the mark change with the lease, under the record lock, so the previous owner never holds the slot
		// again once the claim took it.
		taken = await withSlotLock(
			file,
			false,
			async (lock) => {
				// A lease that went stale only a short while ago still keeps the slot: its holder may be writing to it (#4830).
				if (heldSlots.has(file) || (await otherLeases(file, true)) > 0) return "busy";
				const before = await readRecord(file, storeDir, candidate.repository, candidate.slot);
				if (before === undefined || before.resetting !== undefined) return "dirty";
				if (await worktreeSetAside(storeDir, before.path)) return "busy";
				// Another repository's slot is never reset, nor marked: its record and files stay as they are (#4989).
				if (!(await belongsTo(storeDir, before.path, stores, options.signal))) return "foreign";
				if (!(await holdsRecordedStateOnly(before, options.settings, options.signal).catch(() => false))) {
					return "dirty";
				}
				// Its owner may have held the slot again while this process was suspended past the lock's stale time: the mark
				// replaces only the record checked, taken aside and compared, and never one a holder wrote meanwhile (#4991).
				if (!(await lock.held())) return "busy";
				const taken = await takeRecord(file, before);
				if (taken === undefined) return "busy";
				if ((await otherLeases(file, true)) > 0 || !(await lock.held())) {
					await giveBackRecord(file, taken);
					return "busy";
				}
				const marked: PoolSlotRecord = {
					...before,
					holder: options.owner,
					releasedAt: null,
					resetting: target,
					tenancy: randomUUID(),
				};
				let held: HeldSlot;
				try {
					held = await takeSlot(file, options.owner, marked, options.signal);
				} catch (error) {
					await giveBackRecord(file, taken);
					throw error;
				}
				let put: boolean;
				try {
					put = await putRecord(file, taken, marked);
				} catch (error) {
					await held.unlease().catch(() => {});
					throw error;
				}
				if (!put) {
					await held.unlease().catch(() => {});
					return "busy";
				}
				heldSlots.set(file, held);
				return { before, held };
			},
			options.signal,
		);
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
			tenancy: held.record.tenancy,
		};
		// A claim stalled past its lease may have lost the slot meanwhile: then the slot is not its to record (#4830).
		const kept = await withSlotLock(file, true, async (lock) => {
			if (!(await stillHolds(file, storeDir, held))) return false;
			if (!(await lock.held())) return false;
			await writeRecord(file, claimed);
			return true;
		});
		if (!kept) {
			// The slot stays marked: no claim takes it, and eviction removes it once this lease ends.
			if (heldSlots.get(file) === held) heldSlots.delete(file);
			await held.unlease().catch(() => {});
			return { claimed: false, reason: "busy" };
		}
		held.record = claimed;
		return { claimed: true, lease: newLease(claimed, storeDir, held), warnings };
	} catch (error) {
		reportDebug("storage", "worktree-pool-claim-failed", { file, ...failureDebugFields(error) });
		// A slot whose files never changed goes back to its owner as it was; one changed half way stays marked.
		const end = async () => {
			if (heldSlots.get(file) === held) heldSlots.delete(file);
			await held.unlease().catch(() => {});
		};
		try {
			await withSlotLock(file, true, async (lock) => {
				try {
					// A slot another holder took meanwhile is never handed back to its previous owner (#4830).
					if (!resetting && (await stillHolds(file, storeDir, held)) && (await lock.held())) {
						await writeRecord(file, before);
					}
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
 * that is neither HEAD's nor the tree's, a tracked file whose content is neither HEAD's nor the tree's, as an edit to a
 * file snapshots omit, such as a tracked `.env.example`, one under `.atomic/snapshot-ignore` or one over the size cap
 * (#4897), an untracked file outside the tree, as when untracked files are not captured or are on the deny list, or an ignored file on the
 * deny list, such as `.env`. Other ignored files, build output and dependencies, are rebuilt and may go.
 */
async function holdsUnrecordedFiles(path: string, tree: string, signal: AbortSignal | undefined): Promise<boolean> {
	const git = { cwd: path, signal };
	// Staged content lives only in the index: it is recorded only when it is HEAD's or the recorded tree's.
	const stagedDiffers = async (base: string) =>
		(await runGit(["diff", "--cached", "--quiet", base, "--"], { ...git, allowExitCodes: [1] })).exitCode !== 0;
	if ((await stagedDiffers("HEAD")) && (await stagedDiffers(tree))) return true;
	// Verification compares omitted files as HEAD's, so a tracked file is checked against the tree itself: one that
	// changed since HEAD is recorded only when the tree holds its content (#4897).
	const changedFrom = async (base: string) =>
		nulFields((await runGit(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", base, "--"], git)).stdout);
	const changed = await changedFrom("HEAD");
	if (changed.length > 0) {
		const unrecorded = new Set(await changedFrom(tree));
		if (changed.some((file) => unrecorded.has(file))) return true;
	}
	const recorded = new Set(nulFields((await runGit(["ls-tree", "-r", "-z", "--name-only", tree], git)).stdout));
	const untracked = nulFields((await runGit(["ls-files", "-z", "--others", "--exclude-standard"], git)).stdout);
	if (untracked.some((file) => !recorded.has(file))) return true;
	const ignored = nulFields(
		(await runGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], git)).stdout,
	);
	return ignored.some((file) => !file.endsWith("/") && isDeniedSnapshotPath(file));
}
