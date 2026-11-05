import {
	closeSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
} from "./database.js";
import {
	StorageAdapterLoadError,
	StorageConfigError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StorageUnsupportedOperationError,
	StorageWriteLockTimeoutError,
	StorageWriterQueueDegradedError,
	type StorageWriterQueueDegradedReason,
	StorageWriterQueueUnusableError,
	StoreClosedError,
} from "./errors.js";
import { isSqliteBusy, switchToWriteAheadLog, switchToWriteAheadLogSync } from "./write-ahead-log.js";

/**
 * A ticket its owner has not refreshed for this long belongs to a process that died or stopped waiting. A ticket
 * refreshed this far in the future is stale too: its owner's clock, or the system clock since, jumped.
 */
const TICKET_STALE_MS = 2_000;
/** Stale tickets older than this are removed by whichever writer notices them. */
const TICKET_REMOVE_AFTER_MS = 10 * TICKET_STALE_MS;
/** How often a waiting writer refreshes its ticket: well within `TICKET_STALE_MS`, even for a writer short of CPU. */
const TICKET_REFRESH_MS = TICKET_STALE_MS / 4;
const TICKET_TIME = /^(\d{15})-/;

let ticketSequence = 0;

/**
 * A ticket named after every live one: its time is the later of now and just after the latest live ticket's, so
 * order follows arrival even when processes' clocks disagree or the clock steps back.
 */
function ticketName(live: readonly string[]): string {
	ticketSequence += 1;
	let time = Date.now();
	for (const name of live) time = Math.max(time, Number(TICKET_TIME.exec(name)?.[1] ?? 0) + 1);
	return `${String(time).padStart(15, "0")}-${process.pid}-${ticketSequence}`;
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * A ticket that is gone or going: Windows reports a deleted file that another process still has open (to stat or
 * touch it) as EPERM until that handle closes.
 */
function isVanishedTicket(error: unknown): boolean {
	return isMissingFile(error) || ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32");
}

/**
 * First come, first served for SQLite's write lock across processes. SQLite has no queue for `BEGIN IMMEDIATE`: a
 * writer that polls after `SQLITE_BUSY` loses to one that begins the moment the lock is free, and a busy process
 * can take the lock again and again while another waits for its whole deadline (#3978). A writer that has been
 * refused takes a ticket, a file named after every live ticket, in a directory next to the database; it then
 * attempts the lock only once no live older ticket is ahead of it, and a writer that arrives while tickets wait
 * queues behind them instead of overtaking. Uncontended writers only list an absent or empty directory.
 *
 * Handing the lock on does not wait for anyone to poll (#4316): each queued writer watches its own ticket, and the
 * writer that lets go of the lock touches the oldest live ticket's access time, so its writer attempts the lock at
 * once. Only a ticket's owner moves its modification time, which is what keeps it live, so the wake never keeps a
 * dead or stopped waiter's ticket alive. A writer also rechecks on a timer, for the releases nobody announces: a
 * holder killed with the lock, a ticket ahead whose owner died, a raw SQLite client, an older Atomic.
 */
class SqliteWriteQueue {
	private readonly directory: string;
	private readonly degraded: (reason: StorageWriterQueueDegradedReason, cause: unknown) => void;

	/** `degraded` records what the queue had to give up on without failing the transaction that met it. */
	constructor(databasePath: string, degraded: (reason: StorageWriterQueueDegradedReason, cause: unknown) => void) {
		this.directory = `${databasePath}-writers`;
		this.degraded = degraded;
	}

	join(live = this.liveTickets()): SqliteWriteTicket {
		mkdirSync(this.directory, { recursive: true });
		const name = ticketName(live);
		const path = join(this.directory, name);
		writeFileSync(path, "", { flag: "wx" });
		return new SqliteWriteTicket(this, name, path);
	}

	/**
	 * Hands the turn on once this connection has let go of the write lock: sets the oldest live ticket's access time,
	 * which its writer watches, so that writer attempts the lock at once. The ticket's modification time is written
	 * back unchanged: it marks the ticket live and only its owner moves it. A ticket that left meanwhile passes the
	 * turn to the next one.
	 */
	wakeNext(): void {
		for (const ticket of this.liveTicketEntries()) {
			try {
				utimesSync(join(this.directory, ticket.name), new Date(), ticket.mtimeMs / 1000);
				return;
			} catch (error) {
				if (!isVanishedTicket(error)) throw error;
			}
		}
	}

	/** Live tickets, oldest first; see `liveTicketEntries`. */
	liveTickets(except?: string): string[] {
		return this.liveTicketEntries(except).map((ticket) => ticket.name);
	}

	/**
	 * Live tickets, oldest first; stale ones long abandoned are removed on the way. A queue directory or a ticket that
	 * vanishes while it is read counts as absent; any other failure to read the queue is thrown, so no caller takes a
	 * queue it cannot read for an empty one. Removing an abandoned ticket is housekeeping: it is ignored whether or not
	 * it goes, so a failure other than the ticket having vanished (another user's ticket in a shared directory, say)
	 * is recorded as degraded, once, and never fails a transaction.
	 */
	private liveTicketEntries(except?: string): { readonly name: string; readonly mtimeMs: number }[] {
		let names: string[];
		// Uncontended writers find no directory; checking costs a third of a failed listing, twice per transaction.
		if (!existsSync(this.directory)) return [];
		try {
			names = readdirSync(this.directory);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			return [];
		}
		const now = Date.now();
		const live: { readonly name: string; readonly mtimeMs: number }[] = [];
		for (const name of names.sort()) {
			if (name === except) continue;
			let mtimeMs: number;
			try {
				mtimeMs = statSync(join(this.directory, name)).mtimeMs;
			} catch (error) {
				if (!isVanishedTicket(error)) throw error;
				continue;
			}
			const age = now - mtimeMs;
			if (Math.abs(age) < TICKET_STALE_MS) live.push({ name, mtimeMs });
			else if (Math.abs(age) > TICKET_REMOVE_AFTER_MS) {
				try {
					unlinkSync(join(this.directory, name));
				} catch (error) {
					if (!isVanishedTicket(error)) this.degraded("stale-ticket-kept", error);
				}
			}
		}
		return live;
	}
}

class SqliteWriteTicket {
	private left = false;
	private readonly queue: SqliteWriteQueue;
	private readonly name: string;
	private readonly path: string;
	/** When this writer last marked the ticket live, on the monotonic clock. */
	private refreshed = performance.now();

	constructor(queue: SqliteWriteQueue, name: string, path: string) {
		this.queue = queue;
		this.name = name;
		this.path = path;
	}

	/**
	 * Keeps this ticket live: refreshes it once `TICKET_REFRESH_MS` have passed since it was created or last
	 * refreshed, recreating it in the place it had if it was removed as stale while this writer stalled. Refreshing
	 * only that often keeps the writer's own refresh from waking it more than once per period. Returns whether the
	 * file was recreated, which ends a watch on the removed one.
	 */
	keepLive(): boolean {
		if (performance.now() - this.refreshed < TICKET_REFRESH_MS) return false;
		this.refreshed = performance.now();
		const now = new Date();
		try {
			utimesSync(this.path, now, now);
			return false;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			writeFileSync(this.path, "");
			return true;
		}
	}

	/** Whether an older live ticket is still ahead of this one. */
	behindOthers(): boolean {
		return this.queue.liveTickets(this.name).some((other) => other < this.name);
	}

	/** Watches this ticket for release notices: anything that touches the file, as a releasing writer does. */
	watch(onUnavailable: (cause: Error) => void): ReleaseNotices {
		return new ReleaseNotices(this.path, onUnavailable);
	}

	leave(): void {
		if (this.left) return;
		this.left = true;
		try {
			unlinkSync(this.path);
		} catch {
			// Already removed.
		}
	}
}

/**
 * The release notices a queued writer receives while it waits: a change to its ticket, which is how the writer that
 * lets go of the lock hands it the turn. The watch starts before the writer first checks the lock, and a notice can
 * only be delivered while the writer awaits `wait`, so one sent while it checks still ends its next wait at once.
 */
class ReleaseNotices {
	private watcher?: FSWatcher;
	private wake = () => {};

	constructor(path: string, onUnavailable: (cause: Error) => void) {
		try {
			const watcher = watch(path, () => this.wake());
			watcher.on("error", (cause: Error) => {
				this.close();
				onUnavailable(cause);
			});
			this.watcher = watcher;
		} catch (cause) {
			onUnavailable(cause as Error);
		}
	}

	get watching(): boolean {
		return this.watcher !== undefined;
	}

	/** Resolves once a notice arrives, or after `ms`. */
	wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	close(): void {
		this.watcher?.close();
		this.watcher = undefined;
	}
}

let holderSequence = 0;
const HOLDER_RECORD = /^held (\d{15})\n/;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Which process holds the write lock, for the error of a writer that gives up waiting for it. Each connection that
 * takes the lock records when it took it in a file of its own next to the database, named by its process, and marks
 * the record free once it lets go; only the holder writes its record, so records never race. Nothing reads them
 * until a writer gives up: the live record taken most recently names the holder. A connection removes the records
 * of exited processes when it creates its own, so the killed ones do not pile up. Recording is a diagnostic: a
 * record that cannot be written is dropped, never a failed transaction.
 */
class SqliteHolderRecord {
	private descriptor?: number;
	private broken = false;
	private readonly directory: string;
	private readonly path: string;

	constructor(databasePath: string) {
		this.directory = holderDirectory(databasePath);
		holderSequence += 1;
		this.path = join(this.directory, `${process.pid}-${holderSequence}`);
	}

	held(): void {
		this.write(`held ${String(Date.now()).padStart(15, "0")}\n`);
	}

	free(): void {
		if (this.descriptor !== undefined) this.write(`free ${"0".repeat(15)}\n`);
	}

	/** The process, this one or another, whose record says it took the write lock most recently. */
	latestHolder(): { readonly pid: number; readonly heldMs: number } | undefined {
		return writeLockHolder(this.directory);
	}

	close(): void {
		if (this.descriptor === undefined) return;
		try {
			closeSync(this.descriptor);
			unlinkSync(this.path);
		} catch {
			// Already gone; a leftover record of an exited process is ignored and removed by whoever reads it.
		}
		this.descriptor = undefined;
	}

	/** Every record has the same length and is written in place, so a reader never sees a shorter, stale tail. */
	private write(record: string): void {
		if (this.broken) return;
		try {
			if (this.descriptor === undefined) {
				mkdirSync(this.directory, { recursive: true });
				liveHolderRecords(this.directory);
				this.descriptor = openSync(this.path, "w");
			}
			writeSync(this.descriptor, record, 0);
		} catch {
			this.broken = true;
			this.close();
		}
	}
}

function holderDirectory(databasePath: string): string {
	return `${databasePath}-holders`;
}

/** The records of live processes, as pid and the time each took the lock (undefined when free); others are removed. */
function liveHolderRecords(directory: string): { readonly pid: number; readonly since?: number }[] {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const live: { pid: number; since?: number }[] = [];
	for (const name of names) {
		const pid = Number(/^(\d+)-/.exec(name)?.[1] ?? Number.NaN);
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;
		if (!processAlive(pid)) {
			try {
				unlinkSync(join(directory, name));
			} catch {
				// Another connection removed it first.
			}
			continue;
		}
		let record: string;
		try {
			record = readFileSync(join(directory, name), "utf8");
		} catch {
			continue;
		}
		const since = HOLDER_RECORD.exec(record)?.[1];
		live.push({ pid, ...(since === undefined ? {} : { since: Number(since) }) });
	}
	return live;
}

/** The live process whose record says it took the write lock most recently, and for how long it has held it. */
function writeLockHolder(directory: string): { readonly pid: number; readonly heldMs: number } | undefined {
	let holder: { pid: number; since: number } | undefined;
	for (const { pid, since } of liveHolderRecords(directory))
		if (since !== undefined && (holder === undefined || since > holder.since)) holder = { pid, since };
	return holder === undefined ? undefined : { pid: holder.pid, heldMs: Math.max(0, Date.now() - holder.since) };
}

interface TransactionGates {
	readonly files: Map<string, Promise<void>>;
	readonly connections: WeakMap<DatabaseSync, Promise<void>>;
}

// Share gates across module reloads as well as adapter instances. Only live queues retain file identities.
const TRANSACTION_GATES = Symbol.for("atomic-storage/node-sqlite-transaction-gates@1");
const gateBag = globalThis as typeof globalThis & Record<symbol, TransactionGates | undefined>;
const gates: TransactionGates = gateBag[TRANSACTION_GATES] ?? { files: new Map(), connections: new WeakMap() };
gateBag[TRANSACTION_GATES] = gates;

function gateTransaction<T>(identity: string | DatabaseSync, operation: () => Promise<T>): Promise<T> {
	const prior = typeof identity === "string" ? gates.files.get(identity) : gates.connections.get(identity);
	const result = (prior ?? Promise.resolve()).then(operation);
	const settled = result.then(
		() => {},
		() => {},
	);
	if (typeof identity === "string") gates.files.set(identity, settled);
	else gates.connections.set(identity, settled);
	void settled.then(() => {
		if (typeof identity === "string") {
			if (gates.files.get(identity) === settled) gates.files.delete(identity);
		} else if (gates.connections.get(identity) === settled) gates.connections.delete(identity);
	});
	return result;
}

/** Copies binary parameters so queued work binds the bytes the caller passed, not later buffer contents. */
function snapshotParams(params: readonly SqliteValue[]): SqliteValue[] {
	return params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
}

/**
 * Bun's `DatabaseSync.close()` defers closing the file until garbage collection finalizes every statement the
 * connection prepared, so the database, WAL and shared-memory files stay open (and locked on Windows). The adapter
 * keeps no statement references, so a synchronous collection finalizes them and releases the files. Node finalizes
 * statements inside `close()` and has no `Bun` global.
 */
function finalizeReleasedStatements(): void {
	(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
}

/**
 * Default for how long a transaction keeps retrying `BEGIN IMMEDIATE` while the write lock is held and nobody makes
 * progress through it: every commit by another connection restarts the wait, so only a lock held without commits
 * for this long fails the transaction.
 */
const DEFAULT_NODE_SQLITE_LOCK_WAIT_MS = 30_000;
/**
 * How often a queued writer that watches its ticket rechecks without being told to: it refreshes its ticket (well
 * within `TICKET_STALE_MS`, even for a writer starved of CPU) and notices releases nobody announces. Handing the lock
 * on between Atomic writers does not wait for it.
 */
const LOCK_WAIT_RECHECK_MS = 250;
/**
 * How often a writer that cannot watch its ticket (or has no queue: an in-memory or wrapped connection) retries the
 * lock within the connection's lock wait. Past it, for a transaction that waits longer, it retries every
 * `LOCK_WAIT_RECHECK_MS`, so writers polling a stalled lock leave the stalled holder the CPU it needs.
 */
const UNWATCHED_LOCK_RETRY_MS = 20;
/** Most transactions one group commit carries, so a batch cannot keep the write lock from other processes for long. */
const MAX_GROUP_COMMIT_TRANSACTIONS = 128;
/**
 * Default for how long a group commit runs its members before it commits them and takes the lock again for the
 * rest: a batch of cheap transactions in a process starved of CPU still lets other processes' writers in between.
 * The bound is checked between members, so one member's own work, however long, is never split.
 */
export const DEFAULT_GROUP_COMMIT_HOLD_MS = 100;
/** The span `getWriterQueueStats` reports on. */
const WRITER_QUEUE_STATS_WINDOW_MS = 10_000;

interface QueuedTransaction {
	readonly callback: (transaction: SqliteExecutor) => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly lockWaitMs?: number;
}

/**
 * Transactions committed together. `position` is the connection operation that commits them; a batch directly behind
 * it (`position + 1`, so no statement between) is absorbed when this one first takes the lock. A waiting batch takes
 * new transactions until a statement is queued after it.
 */
interface PendingBatch {
	readonly members: QueuedTransaction[];
	position: number;
	open: boolean;
}

type TransactionOutcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown };

/** One connection's use of the write lock over the last `WRITER_QUEUE_STATS_WINDOW_MS`, on the monotonic clock. */
export interface WriterQueueStats {
	/** Share of the window, 0 to 1, this connection held the write lock: from `BEGIN IMMEDIATE` to commit or rollback. */
	readonly lockHeldRatio: number;
	/** Writers waiting in the cross-process queue right now, in any process; 0 without a queue (in-memory, wrapped). */
	readonly waiters: number;
	/** Median time this connection's acquisitions in the window waited for the lock, in ms; 0 with none. */
	readonly p50WaitMs: number;
	/** 95th-percentile (nearest-rank) wait for the lock in the window, in ms; 0 with none. */
	readonly p95WaitMs: number;
	/** Commits by this connection per second over the window. */
	readonly commitsPerSecond: number;
}

/** Samples in time order; those older than the window are dropped as new ones arrive. */
class WindowSamples<T extends { readonly at: number }> {
	private items: T[] = [];
	private first = 0;

	push(item: T): void {
		this.items.push(item);
		this.drop(item.at - WRITER_QUEUE_STATS_WINDOW_MS);
	}

	since(from: number): T[] {
		this.drop(from);
		return this.items.slice(this.first);
	}

	private drop(before: number): void {
		while (this.first < this.items.length && this.items[this.first]!.at < before) this.first += 1;
		if (this.first * 2 > this.items.length) {
			this.items = this.items.slice(this.first);
			this.first = 0;
		}
	}
}

function nearestRank(sorted: readonly number[], percentile: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.ceil((percentile / 100) * sorted.length) - 1]!;
}

/** Records when a connection waits for, holds, and commits through the write lock. */
class WriteLockUse {
	private readonly opened = performance.now();
	private heldSince?: number;
	/** Completed holds, by when they ended. */
	private readonly holds = new WindowSamples<{ readonly at: number; readonly start: number }>();
	private readonly commits = new WindowSamples<{ readonly at: number }>();
	private readonly waits = new WindowSamples<{ readonly at: number; readonly waitMs: number }>();

	acquired(waitStarted: number): void {
		const now = performance.now();
		this.heldSince = now;
		this.waits.push({ at: now, waitMs: now - waitStarted });
	}

	released(committed: boolean): void {
		const now = performance.now();
		this.holds.push({ at: now, start: this.heldSince ?? now });
		this.heldSince = undefined;
		if (committed) this.commits.push({ at: now });
	}

	stats(waiters: number): WriterQueueStats {
		const now = performance.now();
		const windowMs = Math.min(WRITER_QUEUE_STATS_WINDOW_MS, now - this.opened);
		if (windowMs <= 0) return { lockHeldRatio: 0, waiters, p50WaitMs: 0, p95WaitMs: 0, commitsPerSecond: 0 };
		const from = now - windowMs;
		let heldMs = this.heldSince === undefined ? 0 : now - Math.max(this.heldSince, from);
		for (const hold of this.holds.since(from)) heldMs += hold.at - Math.max(hold.start, from);
		const waits = this.waits
			.since(from)
			.map((wait) => wait.waitMs)
			.sort((a, b) => a - b);
		return {
			lockHeldRatio: Math.min(1, heldMs / windowMs),
			waiters,
			p50WaitMs: nearestRank(waits, 50),
			p95WaitMs: nearestRank(waits, 95),
			commitsPerSecond: this.commits.since(from).length / (windowMs / 1000),
		};
	}
}

/** The driver's own reason, kept in the error message so it survives relays that forward only `message`. */
function sqliteFailureDetail(cause: unknown): string | undefined {
	if (!(cause instanceof Error) || cause.message === "") return undefined;
	const code = (cause as { errcode?: unknown }).errcode;
	return typeof code === "number" ? `${cause.message} (SQLite code ${code})` : cause.message;
}

function unavailable(descriptor: StorageDescriptor, cause: unknown, detail = sqliteFailureDetail(cause)) {
	return new StorageUnavailableError(descriptor, cause as StorageFailureCause, detail);
}

function normalizeRow(row: Record<string, SqliteValue>): SqliteRow {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			typeof value === "bigint" &&
			value >= -BigInt(Number.MAX_SAFE_INTEGER) &&
			value <= BigInt(Number.MAX_SAFE_INTEGER)
				? Number(value)
				: value instanceof Uint8Array
					? new Uint8Array(value)
					: value,
		]),
	);
}

class NodeSqliteDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly connection: DatabaseSync;
	private tail: Promise<void> = Promise.resolve();
	/** Operations queued on this connection so far; a batch's `position` is the one that commits it. */
	private enqueued = 0;
	/** Batches whose commit has not started, in order; the last one takes new transactions while it is open. */
	private readonly waitingBatches: PendingBatch[] = [];
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly executor: SqliteExecutor;

	private readonly ownsConnection: boolean;
	private readonly transactionIdentity: string | DatabaseSync;
	private readonly lockWaitMs: number;
	private readonly groupCommitHoldMs: number;
	/** Cross-process first-come-first-served order for the write lock; absent for in-memory databases. */
	private readonly writeQueue?: SqliteWriteQueue;
	/** This connection's record of when it holds the write lock, named in the error of a writer that gives up. */
	private readonly holderRecord?: SqliteHolderRecord;
	private readonly lockUse = new WriteLockUse();
	/** What the writers' queue gave up on, once per reason, in the order it first happened. */
	private readonly degradations = new Map<StorageWriterQueueDegradedReason, StorageWriterQueueDegradedError>();

	constructor(
		connection: DatabaseSync,
		descriptor: StorageDescriptor,
		ownsConnection = true,
		transactionIdentity: string | DatabaseSync = connection,
		lockWaitMs = DEFAULT_NODE_SQLITE_LOCK_WAIT_MS,
		groupCommitHoldMs = DEFAULT_GROUP_COMMIT_HOLD_MS,
	) {
		this.lockWaitMs = lockWaitMs;
		this.groupCommitHoldMs = groupCommitHoldMs;
		this.transactionIdentity = transactionIdentity;
		this.ownsConnection = ownsConnection;
		this.connection = connection;
		this.descriptor = descriptor;
		this.executor = this.createExecutor(() => true);
		if (typeof transactionIdentity === "string") {
			this.writeQueue = new SqliteWriteQueue(transactionIdentity, (reason, cause) => this.degraded(reason, cause));
			this.holderRecord = new SqliteHolderRecord(transactionIdentity);
		}
	}

	writerQueueStats(): WriterQueueStats {
		return this.lockUse.stats(this.queueOp(() => this.writeQueue?.liveTickets().length ?? 0));
	}

	private driver<T>(operation: () => T): T {
		try {
			return operation();
		} catch (cause) {
			throw unavailable(this.descriptor, cause);
		}
	}

	/**
	 * One non-blocking `BEGIN IMMEDIATE`. node:sqlite runs `busy_timeout` synchronously, so a lock held by another
	 * process would freeze this process's event loop for the whole timeout. The attempt runs with `busy_timeout=0`
	 * and the connection's own value is restored before returning or throwing, so single statements outside a
	 * transaction keep it. Callers reach this only through `enqueue` and the transaction gate, so nothing else runs
	 * on the connection in between.
	 */
	private tryBegin(): void {
		this.driver(() => {
			const configured = Number(this.connection.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
			this.connection.exec("PRAGMA busy_timeout=0");
			let began = false;
			try {
				this.connection.exec("BEGIN IMMEDIATE");
				began = true;
			} finally {
				try {
					this.connection.exec(`PRAGMA busy_timeout=${configured}`);
				} catch (restoreFailure) {
					// Never hand back a transaction on a connection whose lock wait is no longer the configured one.
					if (began) this.connection.exec("ROLLBACK");
					// biome-ignore lint/correctness/noUnsafeFinally: a failed restore must replace the attempt's outcome.
					throw restoreFailure;
				}
			}
		});
	}

	/** Changes whenever another connection commits to the database: the lock is being used, not held idle. */
	private dataVersion(): number {
		return this.driver(() => Number(this.connection.prepare("PRAGMA data_version").get()?.data_version ?? 0));
	}

	/**
	 * Takes the write lock without blocking the event loop. Nothing has run yet when `BEGIN IMMEDIATE` reports
	 * SQLITE_BUSY, so the attempt is retried. A refused writer queues with writers in other processes and attempts the
	 * lock only when no earlier writer is still waiting, so none starves (#3978). It attempts again the moment the
	 * writer releasing the lock touches its ticket (#4316), and otherwise when its recheck timer fires. The wait ends
	 * only when no other connection has committed for `lockWaitMs`, whether this writer is still queued or already
	 * trying the lock: a queued writer counts only real commits as progress, not older tickets ahead of it. The
	 * `StorageWriteLockTimeoutError` of a writer that gives up names the process holding the lock. Every other failure,
	 * including a writers' queue that cannot be used, rejects at once with its cause.
	 */
	private async begin(lockWaitMs = this.lockWaitMs): Promise<void> {
		const waitStarted = performance.now();
		let ticket: SqliteWriteTicket | undefined;
		let notices: ReleaseNotices | undefined;
		try {
			// Writers already waiting in other processes go first.
			const queue = this.writeQueue;
			if (queue !== undefined) {
				const waiting = this.queueOp(() => queue.liveTickets());
				if (waiting.length > 0) ticket = this.queueOp(() => queue.join(waiting));
			}
			// Read only once this writer waits, so an uncontended transaction pays nothing for it.
			let version = ticket === undefined ? undefined : this.dataVersion();
			let stalledSince = performance.now();
			let lastCause: unknown;
			for (;;) {
				if (ticket !== undefined) notices = this.watchTicket(ticket, notices);
				const behind = ticket !== undefined && this.queueOp(() => ticket!.behindOthers());
				if (!behind) {
					try {
						this.tryBegin();
						this.acquired(waitStarted);
						return;
					} catch (error) {
						const cause = error instanceof StorageUnavailableError ? error.cause : undefined;
						if (!isSqliteBusy(cause)) throw error;
						lastCause = cause;
					}
					if (ticket === undefined && this.writeQueue !== undefined) {
						// A release before this ticket existed told nobody: watch it, then try once more before waiting.
						ticket = this.queueOp(() => this.writeQueue!.join());
						continue;
					}
				}
				// Only another connection's commit is progress; a queued writer measures its stall the same way.
				const current = this.dataVersion();
				if (version === undefined) version = current;
				else if (current !== version) {
					version = current;
					stalledSince = performance.now();
				}
				const stalledMs = performance.now() - stalledSince;
				if (stalledMs >= lockWaitMs) throw this.lockWaitTimeout(lockWaitMs, stalledMs, behind, lastCause);
				const recheckMs =
					notices?.watching === true || stalledMs >= this.lockWaitMs
						? LOCK_WAIT_RECHECK_MS
						: UNWATCHED_LOCK_RETRY_MS;
				const delay = Math.min(recheckMs, lockWaitMs - stalledMs);
				await (notices?.wait(delay) ?? new Promise<void>((resolve) => setTimeout(resolve, delay)));
			}
		} finally {
			notices?.close();
			ticket?.leave();
		}
	}

	/**
	 * Keeps the ticket live and watched: one watch for the whole wait, started again only when the ticket had to be
	 * recreated, since a watch ends with the file it watched.
	 */
	private watchTicket(ticket: SqliteWriteTicket, notices: ReleaseNotices | undefined): ReleaseNotices {
		const recreated = this.queueOp(() => ticket.keepLive());
		if (notices !== undefined && !recreated) return notices;
		notices?.close();
		return ticket.watch((cause) => this.degraded("watch-unavailable", cause));
	}

	private lockWaitTimeout(
		lockWaitMs: number,
		stalledMs: number,
		behind: boolean,
		lastCause: unknown,
	): StorageWriteLockTimeoutError {
		const holder = this.holderRecord?.latestHolder();
		return new StorageWriteLockTimeoutError(
			this.descriptor,
			{
				timeoutMs: lockWaitMs,
				elapsedMs: Math.round(stalledMs),
				phase: behind ? "queued" : "acquiring",
				holderPid: holder?.pid,
				holderHeldMs: holder?.heldMs,
			},
			lastCause as StorageFailureCause,
		);
	}

	private acquired(waitStarted: number): void {
		this.holderRecord?.held();
		this.lockUse.acquired(waitStarted);
	}

	/**
	 * Runs the moment COMMIT or ROLLBACK lets go of the write lock, before any caller settles, so no caller's work can
	 * delay the next writer: it hands the turn to the oldest writer waiting in another process. A turn that cannot be
	 * handed on is still noticed by that writer's recheck timer, so it never fails the transaction.
	 */
	private released(committed: boolean): void {
		this.lockUse.released(committed);
		this.holderRecord?.free();
		try {
			this.writeQueue?.wakeNext();
		} catch (cause) {
			this.degraded("wake-failed", cause);
		}
	}

	/**
	 * Records a degradation of the writers' queue once per reason, then emits it as a process warning for hosts that
	 * listen for one. The record is what stays readable where warnings are suppressed, as in Atomic's own processes;
	 * nothing fails.
	 */
	private degraded(reason: StorageWriterQueueDegradedReason, cause: unknown): void {
		if (this.degradations.has(reason)) return;
		const degradation = new StorageWriterQueueDegradedError(this.descriptor, reason, cause as StorageFailureCause);
		this.degradations.set(reason, degradation);
		process.emitWarning(degradation);
	}

	writerQueueDegradation(): readonly StorageWriterQueueDegradedError[] {
		return [...this.degradations.values()];
	}

	/** Runs a writers'-queue file operation; a failure (an unwritable queue directory, say) is a typed storage failure. */
	private queueOp<T>(operation: () => T): T {
		try {
			return operation();
		} catch (cause) {
			throw new StorageWriterQueueUnusableError(this.descriptor, cause as StorageFailureCause);
		}
	}

	private createExecutor(active: () => boolean): SqliteExecutor {
		const execute = async <T>(operation: () => T, params: readonly SqliteValue[] = []): Promise<T> => {
			if (!active()) throw new StorageTransactionClosedError();
			const invalidIndex = params.findIndex((value) => typeof value === "string" && value.includes("\0"));
			if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
			return this.driver(operation);
		};
		const statement = (sql: string) => {
			const prepared = this.connection.prepare(sql);
			prepared.setReadBigInts(true);
			return prepared;
		};
		return {
			exec: (sql) => execute(() => this.connection.exec(sql)),
			run: (sql, ...params) => execute(() => ({ changes: Number(statement(sql).run(...params).changes) }), params),
			get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(() => {
					const row = statement(sql).get(...params);
					return row === undefined ? undefined : (normalizeRow(row) as T);
				}, params),
			all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(
					() =>
						statement(sql)
							.all(...params)
							.map((row) => normalizeRow(row) as T),
					params,
				),
		};
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		this.enqueued += 1;
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	/** A statement queued after open transactions runs after them, so later transactions start a new batch. */
	private enqueueStatement<T>(operation: () => Promise<T>): Promise<T> {
		const last = this.waitingBatches.at(-1);
		if (last !== undefined) last.open = false;
		return this.enqueue(operation);
	}

	exec(sql: string): Promise<void> {
		return this.enqueueStatement(() => this.executor.exec(sql));
	}

	run(sql: string, ...params: readonly SqliteValue[]) {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.run(sql, ...bound));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.get<T>(sql, ...bound));
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		const bound = snapshotParams(params);
		return this.enqueueStatement(() => this.executor.all<T>(sql, ...bound));
	}

	/**
	 * Group commit: transactions queued while earlier work holds the connection join one `BEGIN IMMEDIATE … COMMIT`,
	 * each inside its own savepoint and in the order they were requested. A transaction that throws rolls back only
	 * its savepoint and rejects only its caller; every caller settles after the shared commit, so durability is the
	 * same as a transaction of its own. Under load one lock acquisition and one sync serve the whole batch, including
	 * the transactions requested while it waited for the lock. A batch waits for the lock as long as the most patient
	 * of its transactions.
	 */
	transaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		options?: SqliteTransactionOptions,
	): Promise<T> {
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		return new Promise<T>((resolve, reject) => {
			const queued: QueuedTransaction = {
				callback,
				resolve: resolve as (value: unknown) => void,
				reject,
				lockWaitMs: options?.lockWaitMs,
			};
			const last = this.waitingBatches.at(-1);
			if (last?.open === true && last.members.length < MAX_GROUP_COMMIT_TRANSACTIONS) {
				last.members.push(queued);
				return;
			}
			this.startBatch([queued]);
		});
	}

	private startBatch(members: QueuedTransaction[]): void {
		const batch: PendingBatch = { members, position: 0, open: true };
		this.waitingBatches.push(batch);
		void this.enqueue(() => this.commitBatch(batch));
		batch.position = this.enqueued;
	}

	private commitBatch(batch: PendingBatch): Promise<void> {
		// The batch ahead of it took its transactions along when it got the lock.
		if (this.waitingBatches[0] !== batch) return Promise.resolve();
		this.waitingBatches.shift();
		return gateTransaction(this.transactionIdentity, () => this.runBatch(batch, true));
	}

	/**
	 * Takes the write lock for the batch, then commits it on its own or as a group. On its first acquisition the
	 * transactions requested directly behind it while it waited join it: otherwise they would queue for the lock all
	 * over again once it lets go. Members left after the hold budget take the lock again with nothing new, so other
	 * connections to the file wait for at most one batch of this one's.
	 */
	private async runBatch(batch: PendingBatch, firstAcquisition: boolean): Promise<void> {
		try {
			await this.begin(this.lockWait(batch.members));
		} catch (cause) {
			for (const queued of batch.members.splice(0)) queued.reject(cause);
			return;
		}
		if (firstAcquisition) this.absorbNext(batch);
		await (batch.members.length === 1 ? this.commitAlone(batch.members.pop()!) : this.commitMembers(batch));
	}

	/**
	 * Moves the transactions of the batches queued directly behind this one (no statement between them) into this one,
	 * up to the batch size limit. They run after this batch's own, in the order they were requested.
	 */
	private absorbNext(batch: PendingBatch): void {
		for (let next = this.waitingBatches[0]; next?.position === batch.position + 1; next = this.waitingBatches[0]) {
			batch.members.push(...next.members.splice(0, MAX_GROUP_COMMIT_TRANSACTIONS - batch.members.length));
			if (next.members.length > 0) return;
			this.waitingBatches.shift();
			batch.position = next.position;
		}
	}

	private lockWait(batch: readonly QueuedTransaction[]): number {
		return Math.max(...batch.map((queued) => queued.lockWaitMs ?? this.lockWaitMs));
	}

	/** A transaction with nobody queued with it commits on its own, without savepoints. */
	private async commitAlone(queued: QueuedTransaction): Promise<void> {
		let active = true;
		try {
			const value = await queued.callback(this.createExecutor(() => active));
			active = false;
			await this.executor.exec("COMMIT");
			this.released(true);
			queued.resolve(value);
		} catch (cause) {
			active = false;
			try {
				await this.executor.exec("ROLLBACK");
			} catch (rollbackCause) {
				this.released(false);
				queued.reject(new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause));
				return;
			}
			this.released(false);
			queued.reject(cause);
		}
	}

	/**
	 * Runs the batch's members in one transaction, for at most `groupCommitHoldMs`: members left when it runs out
	 * wait for the lock again, still ahead of anything queued after them.
	 */
	private async commitMembers(batch: PendingBatch): Promise<void> {
		const began = performance.now();
		const outcomes: TransactionOutcome[] = [];
		for (const queued of batch.members) {
			if (outcomes.length > 0 && performance.now() - began >= this.groupCommitHoldMs) break;
			const savepoint = `atomic_group_${outcomes.length}`;
			let active = true;
			try {
				await this.executor.exec(`SAVEPOINT ${savepoint}`);
				const value = await queued.callback(this.createExecutor(() => active));
				active = false;
				await this.executor.exec(`RELEASE ${savepoint}`);
				outcomes.push({ ok: true, value });
			} catch (cause) {
				active = false;
				try {
					await this.executor.exec(`ROLLBACK TO ${savepoint}`);
					await this.executor.exec(`RELEASE ${savepoint}`);
				} catch (rollbackCause) {
					await this.abandonMembers(batch, outcomes, cause, rollbackCause);
					return;
				}
				outcomes.push({ ok: false, error: cause });
			}
		}
		const ran = batch.members.splice(0, outcomes.length);
		let commitCause: unknown;
		let committed = true;
		try {
			await this.executor.exec("COMMIT");
		} catch (cause) {
			committed = false;
			commitCause = cause;
			await this.rollbackQuietly();
		}
		this.released(committed);
		ran.forEach((queued, index) => {
			const outcome = outcomes[index]!;
			if (!committed) queued.reject(outcome.ok ? commitCause : outcome.error);
			else if (outcome.ok) queued.resolve(outcome.value);
			else queued.reject(outcome.error);
		});
		if (batch.members.length > 0) await this.runBatch(batch, false);
	}

	/**
	 * A savepoint that cannot be rolled back leaves the whole transaction unusable: earlier members lose their
	 * uncommitted writes and fail, the failing member reports both causes, and members that have not run yet get a
	 * fresh transaction right away, still ahead of anything queued after them, because nothing of theirs has happened.
	 */
	private async abandonMembers(
		batch: PendingBatch,
		outcomes: TransactionOutcome[],
		cause: unknown,
		rollbackCause: unknown,
	): Promise<void> {
		await this.rollbackQuietly();
		this.released(false);
		const failed = outcomes.length;
		const ran = batch.members.splice(0, failed + 1);
		ran.slice(0, failed).forEach((queued, index) => {
			const outcome = outcomes[index]!;
			queued.reject(outcome.ok ? unavailable(this.descriptor, rollbackCause) : outcome.error);
		});
		ran[failed]!.reject(new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause));
		if (batch.members.length > 0) await this.runBatch(batch, false);
	}

	private async rollbackQuietly(): Promise<void> {
		try {
			await this.executor.exec("ROLLBACK");
		} catch {
			// SQLite already rolled the transaction back; there is nothing left to undo.
		}
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.tail.then(() =>
				this.driver(() => {
					this.holderRecord?.close();
					if (this.ownsConnection) this.connection.close();
					finalizeReleasedStatements();
				}),
			);
		}
		return this.closePromise;
	}
}

/** Rejects a group-commit budget that is not a finite number of milliseconds, 0 or more, before anything opens. */
function groupCommitHold(value: number | undefined): number {
	if (value === undefined) return DEFAULT_GROUP_COMMIT_HOLD_MS;
	if (!Number.isFinite(value) || value < 0)
		throw new StorageConfigError(
			"sdk",
			"groupCommitHoldMs",
			"non-negative-finite-number-required",
			`Pass a finite number of milliseconds, 0 or more, or omit it for the default of ${DEFAULT_GROUP_COMMIT_HOLD_MS} ms`,
		);
	return value;
}

export async function openNodeSqliteDatabase(
	path: string,
	{
		busyTimeoutMs = 5000,
		lockWaitMs = DEFAULT_NODE_SQLITE_LOCK_WAIT_MS,
		readOnly = false,
		groupCommitHoldMs,
	}: {
		busyTimeoutMs?: number;
		lockWaitMs?: number;
		readOnly?: boolean;
		/**
		 * How long one group commit runs queued transactions before it commits them and lets other processes' writers
		 * take the lock (`DEFAULT_GROUP_COMMIT_HOLD_MS` when omitted). Checked between transactions, so one
		 * transaction is never split. 0 commits each transaction on its own.
		 */
		groupCommitHoldMs?: number;
	} = {},
): Promise<SqliteDatabase> {
	const holdMs = groupCommitHold(groupCommitHoldMs);
	const descriptor = { adapter: "node-sqlite", location: path };
	// Load node:sqlite on first open: importing it prints Node's experimental warning, which every importer of the
	// package entry point would otherwise see.
	let Database: typeof DatabaseSync;
	try {
		({ DatabaseSync: Database } = await import("node:sqlite"));
	} catch (cause) {
		throw new StorageAdapterLoadError("node:sqlite", cause as StorageFailureCause);
	}
	let connection: DatabaseSync | undefined;
	try {
		if (!readOnly && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		connection = new Database(path, { readOnly });
		connection.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
		if (!readOnly) {
			const writable = connection;
			// SQLite does not wait for another process's lock while it changes the mode; the switch waits itself.
			await switchToWriteAheadLog((sql) => writable.exec(sql), busyTimeoutMs);
			writable.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		}
		const location = connection.location();
		const identity = location === null ? connection : await realpath(location);
		return new NodeSqliteDatabase(connection, descriptor, true, identity, lockWaitMs, holdMs);
	} catch (cause) {
		try {
			connection?.close();
		} catch {
			// Preserve the opening failure if cleanup also fails.
		}
		throw unavailable(descriptor, cause);
	}
}

/** The busy timeout `wrapNodeSqliteDatabase` sets on a caller's connection. */
const WRAPPED_BUSY_TIMEOUT_MS = 5000;

export function wrapNodeSqliteDatabase(connection: DatabaseSync): SqliteDatabase {
	const descriptor = { adapter: "node-sqlite", location: ":memory:" };
	try {
		descriptor.location = connection.location() || ":memory:";
		connection.exec(`PRAGMA busy_timeout=${WRAPPED_BUSY_TIMEOUT_MS}`);
		// SQLite does not wait for another process's lock while it changes the mode; the switch waits itself.
		switchToWriteAheadLogSync((sql) => connection.exec(sql), WRAPPED_BUSY_TIMEOUT_MS);
		connection.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		return new NodeSqliteDatabase(connection, descriptor, false);
	} catch (cause) {
		throw unavailable(descriptor, cause);
	}
}

/**
 * How one database handle has used the write lock over the last 10 seconds, and how many writers wait for it now in
 * any process. Throws `StorageUnsupportedOperationError` for a handle that `openNodeSqliteDatabase` or
 * `wrapNodeSqliteDatabase` did not return, and `StorageUnavailableError` when the writers' queue cannot be read.
 */
export function getWriterQueueStats(database: SqliteDatabase): WriterQueueStats {
	if (!(database instanceof NodeSqliteDatabase))
		throw new StorageUnsupportedOperationError(database.descriptor, "getWriterQueueStats");
	return database.writerQueueStats();
}

/**
 * What the writers' queue of a database handle has given up on, once per reason in the order it first happened, as
 * `StorageWriterQueueDegradedError`s: a waiting writer that cannot watch its ticket, a writer that could not notify
 * the next one, an abandoned ticket that could not be removed. Empty while the queue is healthy, and for a handle
 * without a cross-process queue (in-memory or wrapped). Transactions keep working through each of them; the same
 * errors are also emitted as process warnings, which Atomic's own processes suppress. Throws
 * `StorageUnsupportedOperationError` for a handle that `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase` did not
 * return.
 */
export function getWriterQueueDegradation(database: SqliteDatabase): readonly StorageWriterQueueDegradedError[] {
	if (!(database instanceof NodeSqliteDatabase))
		throw new StorageUnsupportedOperationError(database.descriptor, "getWriterQueueDegradation");
	return database.writerQueueDegradation();
}
