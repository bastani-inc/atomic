import {
	close,
	existsSync,
	type FSWatcher,
	open,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
	watch,
	write,
} from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	statfs,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isSharedArrayBuffer, isUint8Array } from "node:util/types";
import type * as native from "@bastani/atomic-natives";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
} from "./database.js";
import { sqliteDialect } from "./dialect.js";
import {
	payloadTooLargeKind,
	SQLITE_PAYLOAD_LIMITS,
	StorageAdapterLoadError,
	StorageConfigError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StoragePayloadTooLargeError,
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
import { fileIdentity, fileIdentityAsync } from "./file-identity.js";
import {
	currentHoldScope,
	type FileHold,
	type FileLock,
	forgetPlans,
	type HoldScope,
	heldElsewhere,
	holdFile,
	readsOnly,
	releaseHold,
	runInHold,
	runWhenFree,
	sqliteBusyError,
	useFileLock,
} from "./node-sqlite-file-gate.js";
import {
	type ConnectionAnswer,
	type ConnectionRequest,
	type SequenceAnswer,
	type SequenceRequest,
	ThreadConnection,
} from "./node-sqlite-thread.js";
import { offerSequences, type SqliteSequence } from "./statement-sequence.js";
import { isSqliteBusy, switchToWriteAheadLog, switchToWriteAheadLogSync } from "./write-ahead-log.js";

/** Loaded at the first degradation only, so opening a database does not load debug output. */
let debugOutput: Promise<typeof import("../debug.ts")> | undefined;

function reportDegradationInDebugMode(degradation: StorageWriterQueueDegradedError): void {
	const errno = (degradation.cause as { readonly code?: unknown } | undefined)?.code;
	debugOutput ??= import("../debug.ts");
	void debugOutput.then(
		({ reportDebugAsync: reportDebug }) =>
			reportDebug("storage", "writer-queue-degraded", {
				code: degradation.code,
				reason: degradation.reason,
				adapter: degradation.adapter,
				location: degradation.location,
				errno: typeof errno === "string" ? errno : undefined,
			}),
		(error: unknown) => process.emitWarning(error instanceof Error ? error : String(error)),
	);
}

/**
 * A ticket its owner has not refreshed for this long belongs to a process that died or stopped waiting. A ticket
 * refreshed this far in the future is stale too: the system clock stepped back since, or its owner stamped it from a
 * clock of its own.
 */
const TICKET_STALE_MS = 2_000;
/** Stale tickets older than this are removed by whichever writer notices them. */
const TICKET_REMOVE_AFTER_MS = 10 * TICKET_STALE_MS;
/** How often a waiting writer refreshes its ticket: well within `TICKET_STALE_MS`, even for a writer short of CPU. */
const TICKET_REFRESH_MS = TICKET_STALE_MS / 4;
const TICKET_TIME = /^(\d{15})-/;
/** Now on the database's clock, in milliseconds: the clock tickets are stamped and aged on (see `SqliteWriteQueue`). */
const DATABASE_NOW = `SELECT ${sqliteDialect.nowMs} AS now`;

/** An in-memory connection of the process's own, which the database clock is read through. */
let clockConnection: DatabaseSync | undefined;
/** node:sqlite's connection class, once an open loaded it. */
let loadedDatabaseSync: typeof DatabaseSync | undefined;

/**
 * Now on the clock SQLite reads for `unixepoch()`: the system clock, which every process shares, whatever this
 * process's own says. SQLite reads it from the operating system, not from a database file, so a connection of the
 * process's own reads the same time as every handle's, and a handle can read it after it is closed. A connection on a
 * thread of its own reads it there; this reads it on the calling thread, for a connection there and for the
 * synchronous `getWriterQueueStats`.
 */
function databaseNow(): number {
	clockConnection ??= new loadedDatabaseSync!(":memory:");
	return Number(clockConnection.prepare(DATABASE_NOW).get()!.now);
}

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
	return isMissingFile(error) || ((error as NodeJS.ErrnoException).code === "EPERM" && platform() === "win32");
}

/**
 * Writes an empty queue entry, making its directory only when it is missing, as it is the first time the database
 * is contended: a writer joining the queue makes no more round trips off the event loop than it must.
 */
async function writeEntry(path: string, flag: "wx" | "w"): Promise<void> {
	try {
		await writeFile(path, "", { flag });
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "", { flag });
	}
}

/** A queue entry and when its owner last marked it live, on the database clock. */
interface QueueEntry {
	readonly name: string;
	readonly mtimeMs: number;
}

/** A queue entry judged live: `fresh` when its owner marked it live within `TICKET_STALE_MS` on the database clock. */
interface LiveEntry {
	readonly name: string;
	readonly fresh: boolean;
}

/** When this writer first saw a ticket at its current modification time, on its own running clock. */
interface Sighting {
	readonly mtimeMs: number;
	readonly sinceRunningMs: number;
}

const TICKET_PID = /^\d{15}-(\d+)-/;

/** The queue entries of this process's writers that are waiting for the lock, by path: they are live, whatever their age. */
const waitingHere = new Set<string>();

/**
 * First come, first served for SQLite's write lock across processes. SQLite has no queue for `BEGIN IMMEDIATE`: a
 * writer that polls after `SQLITE_BUSY` loses to one that begins the moment the lock is free, and a busy process
 * can take the lock again and again while another waits for its whole deadline (#3978). A writer that has been
 * refused takes a ticket, a file named after every live ticket, in a directory next to the database; it then
 * attempts the lock only once no live older ticket is ahead of it, and a writer that arrives while tickets wait
 * queues behind them instead of overtaking. Uncontended writers only list an absent or empty directory.
 *
 * Handing the lock on does not wait for anyone to poll (#4316): each queued writer watches a release notice of its
 * own, a file named like its ticket in a directory beside the queue's (`<file>-wakes`), and the writer that lets go
 * of the lock touches the oldest live ticket's notice, so its writer attempts the lock at once. The two never
 * share a file: only a ticket's owner moves the ticket's modification time, which is what keeps it live, so a
 * notice neither keeps a dead or stopped waiter's ticket alive nor, sent late, rolls a live one back to an older
 * time. A writer also rechecks on a timer, for the releases nobody announces: a holder killed with the lock, a
 * ticket ahead whose owner died, a raw SQLite client, an older Atomic.
 *
 * Tickets are stamped and aged on the database's clock, the system clock SQLite reads for `unixepoch()`, which also
 * stamps the files: every process shares it. A process's own clock can differ from it by seconds. On Windows, V8
 * extrapolates `Date.now()` from a reading of the system clock it renews once a minute, so after the system clock is
 * set (a virtual machine's time synchronization, say) a running process stays off by the step until then, and
 * processes aging tickets on their own clocks took live tickets for stale and overtook their writers (#4387).
 */
class SqliteWriteQueue {
	private readonly directory: string;
	private readonly noticeDirectory: string;
	private readonly degraded: (reason: StorageWriterQueueDegradedReason, cause: unknown) => void;
	/** Now on the database's clock, in milliseconds, read where the connection runs. */
	readonly now: () => number | Promise<number>;
	private observedAt: number | undefined;
	/** Time this writer was seen to run while it looked at the queue; see `advance`. */
	private runningMs = 0;
	/** Each listed ticket's modification time when this writer first saw it, and its running clock then. */
	private readonly sightings = new Map<string, Sighting>();

	/** `degraded` records what the queue had to give up on without failing the transaction that met it. */
	constructor(
		databasePath: string,
		degraded: (reason: StorageWriterQueueDegradedReason, cause: unknown) => void,
		now: () => number | Promise<number>,
	) {
		this.directory = `${databasePath}-writers`;
		this.noticeDirectory = `${databasePath}-wakes`;
		this.degraded = degraded;
		this.now = now;
	}

	/** Marks this process as running now: time from here until its next look at the queue is time it was seen to run. */
	observe(): void {
		this.observedAt = performance.now();
	}

	/**
	 * Advances this writer's running clock to this look and returns it. Time since its last look counts up to a waiting
	 * writer's refresh, `TICKET_REFRESH_MS`; time beyond that is time this process was not seen to run, which a stall of
	 * the whole host takes from every owner alike, so it is not held against their tickets.
	 */
	private advance(): number {
		const lookedAt = performance.now();
		if (this.observedAt !== undefined) this.runningMs += Math.min(lookedAt - this.observedAt, TICKET_REFRESH_MS);
		this.observedAt = lookedAt;
		return this.runningMs;
	}

	/**
	 * Judges a queue's entries, sorted by name, on the database clock: the live ones, oldest first, and the ones
	 * abandoned long enough to remove. A ticket refreshed within `TICKET_STALE_MS` is live. A ticket of a writer in
	 * this process is live while that writer waits, and only then. A stale ticket of a process that is gone is passed
	 * over. A stale ticket of a process that still exists is passed over only once this writer has itself run for
	 * `TICKET_STALE_MS` since the ticket's last refresh, counting from when it first saw the ticket if it was stale then:
	 * a stall of the whole host is never held against a ticket until its owner had the time to refresh it after the
	 * stall, however soon this writer looks again, and a writer that starts after a stall, which saw none of it, waits
	 * as long for the tickets it finds before passing over them.
	 */
	private judge(entries: readonly QueueEntry[], now: number): { live: LiveEntry[]; abandoned: string[] } {
		const running = this.advance();
		const listed = new Set<string>();
		const live: LiveEntry[] = [];
		const abandoned: string[] = [];
		for (const entry of entries) {
			listed.add(entry.name);
			const age = Math.abs(now - entry.mtimeMs);
			const fresh = age < TICKET_STALE_MS;
			const pid = Number(TICKET_PID.exec(entry.name)?.[1]);
			if (pid === process.pid) {
				if (waitingHere.has(join(this.directory, entry.name))) live.push({ name: entry.name, fresh: true });
				else if (fresh) live.push({ name: entry.name, fresh });
				else if (age > TICKET_REMOVE_AFTER_MS) abandoned.push(entry.name);
				continue;
			}
			let sighting = this.sightings.get(entry.name);
			if (sighting?.mtimeMs !== entry.mtimeMs) {
				sighting = { mtimeMs: entry.mtimeMs, sinceRunningMs: running - (fresh ? age : 0) };
				this.sightings.set(entry.name, sighting);
			}
			if (fresh) live.push({ name: entry.name, fresh });
			else if (running - sighting.sinceRunningMs < TICKET_STALE_MS && Number.isSafeInteger(pid) && processAlive(pid))
				live.push({ name: entry.name, fresh });
			else if (age > TICKET_REMOVE_AFTER_MS) abandoned.push(entry.name);
		}
		for (const name of this.sightings.keys()) if (!listed.has(name)) this.sightings.delete(name);
		return { live, abandoned };
	}

	/** Whether the queue directory exists: an uncontended writer finds none and reads nothing more. */
	contended(): boolean {
		return existsSync(this.directory);
	}

	contendedOffLoop(): Promise<boolean> {
		return pathExists(this.directory);
	}

	/** Takes a ticket behind `live`, writing it and its notice off the event loop. */
	async join(live: readonly string[]): Promise<SqliteWriteTicket> {
		this.observe();
		const name = ticketName(live);
		const ticket = new SqliteWriteTicket(this, name, join(this.directory, name), join(this.noticeDirectory, name));
		await this.create(ticket, "wx");
		return ticket;
	}

	/**
	 * Writes the ticket's release notice, then the ticket, so a writer that finds the ticket can always touch its
	 * notice. A ticket that cannot be written takes its notice with it; `wx` never takes over another writer's files.
	 */
	async create(ticket: SqliteWriteTicket, flag: "wx" | "w"): Promise<void> {
		await writeEntry(ticket.noticePath, flag);
		try {
			await writeEntry(ticket.path, flag);
			waitingHere.add(ticket.path);
		} catch (error) {
			try {
				await unlink(ticket.noticePath);
			} catch (cleanup) {
				this.removalFailed(cleanup);
			}
			throw error;
		}
	}

	/** A ticket's notice, then the ticket: removed in that order, so no notice outlives its ticket. */
	private entryPaths(name: string): string[] {
		return [join(this.noticeDirectory, name), join(this.directory, name)];
	}

	/** Whether removing an entry has to stop at `error`; one that is not a vanished entry is recorded as degraded. */
	private removalFailed(error: unknown): boolean {
		if (isVanishedTicket(error)) return false;
		this.degraded("stale-ticket-kept", error);
		return true;
	}

	/** Removes an abandoned entry found while reading the queue. */
	removeEntry(name: string): void {
		for (const path of this.entryPaths(name)) {
			try {
				unlinkSync(path);
			} catch (error) {
				if (this.removalFailed(error)) return;
			}
		}
	}

	/** Removes an entry off the event loop: a leaving writer's own, or an abandoned one a waiting writer found. */
	async removeEntryOffLoop(name: string): Promise<void> {
		for (const path of this.entryPaths(name)) {
			try {
				await unlink(path);
			} catch (error) {
				if (this.removalFailed(error)) return;
			}
		}
	}

	/**
	 * Hands the turn on once this connection has let go of the write lock: touches the release notice of the oldest
	 * live ticket, which its writer watches, so that writer attempts the lock at once. A ticket that is live only
	 * because its owner has not yet had the time to refresh it (see `judge`) may belong to a writer that stopped, so the
	 * notices of the tickets behind it are touched too, up to the first one refreshed on time. The ticket itself is not
	 * touched: its modification time marks it live and only its owner moves it, so a release can neither keep a dead
	 * writer's ticket alive nor undo the owner's refresh that came after the queue was read. A ticket that left
	 * meanwhile passes the turn to the next one. `except` is the releasing writer's own ticket, still on its way out.
	 */
	async wakeNext(except?: string): Promise<void> {
		if (!(await this.contendedOffLoop())) return;
		for (const ticket of await this.liveEntriesOffLoop(except)) {
			try {
				const now = new Date();
				await utimes(join(this.noticeDirectory, ticket.name), now, now);
				if (ticket.fresh) return;
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
	 * Live tickets, oldest first; stale ones long abandoned are removed on the way. A ticket is judged on the time this
	 * writer was seen to run since it first saw it (see `judge`), so a stall of the whole host neither passes over nor
	 * removes the tickets of writers it stopped too. A queue directory or a ticket that
	 * vanishes while it is read counts as absent; any other failure to read the queue is thrown, so no caller takes a
	 * queue it cannot read for an empty one. Removing an abandoned ticket is housekeeping: it is ignored whether or not
	 * it goes, so a failure other than the ticket having vanished (another user's ticket in a shared directory, say)
	 * is recorded as degraded, once, and never fails a transaction.
	 */
	private liveTicketEntries(except?: string): LiveEntry[] {
		let names: string[];
		// Uncontended writers find no directory; checking costs a third of a failed listing, twice per transaction.
		if (!this.contended()) return [];
		try {
			names = readdirSync(this.directory);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			return [];
		}
		// An empty queue, as contention leaves it, is read without the clock.
		if (names.length === 0) return [];
		const now = databaseNow();
		const entries: QueueEntry[] = [];
		for (const name of names.sort()) {
			if (name === except) continue;
			try {
				entries.push({ name, mtimeMs: statSync(join(this.directory, name)).mtimeMs });
			} catch (error) {
				if (!isVanishedTicket(error)) throw error;
			}
		}
		const { live, abandoned } = this.judge(entries, now);
		for (const name of abandoned) this.removeEntry(name);
		return live;
	}

	/** Live tickets other than `except`, oldest first, read off the event loop; see `liveEntriesOffLoop`. */
	async liveTicketsOffLoop(except?: string): Promise<string[]> {
		return (await this.liveEntriesOffLoop(except)).map((entry) => entry.name);
	}

	/**
	 * Live tickets other than `except`, oldest first: read off the event loop and judged like `liveTicketEntries`.
	 * Entries are read together; the first failure in listing order that is not a vanished entry is thrown.
	 */
	private async liveEntriesOffLoop(except?: string): Promise<LiveEntry[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			return [];
		}
		if (names.length === 0) return [];
		const listed = names.sort().filter((name) => name !== except);
		const read = await Promise.all(
			listed.map((name) =>
				stat(join(this.directory, name)).then(
					(found): QueueEntry => ({ name, mtimeMs: found.mtimeMs }),
					(error: unknown) => ({ name, error }),
				),
			),
		);
		const entries: QueueEntry[] = [];
		for (const entry of read) {
			if (!("error" in entry)) entries.push(entry);
			else if (!isVanishedTicket(entry.error)) throw entry.error;
		}
		const { live, abandoned } = this.judge(entries, await this.now());
		for (const name of abandoned) await this.removeEntryOffLoop(name);
		return live;
	}
}

class SqliteWriteTicket {
	private left = false;
	private readonly queue: SqliteWriteQueue;
	readonly name: string;
	readonly path: string;
	readonly noticePath: string;
	/** When this writer last marked the ticket live, on the monotonic clock. */
	private refreshed = performance.now();

	constructor(queue: SqliteWriteQueue, name: string, path: string, noticePath: string) {
		this.queue = queue;
		this.name = name;
		this.path = path;
		this.noticePath = noticePath;
	}

	/**
	 * Keeps this ticket live: refreshes it once `TICKET_REFRESH_MS` have passed since it was created or last
	 * refreshed, recreating it and its release notice in the place it had if it was removed as stale while this
	 * writer stalled. Returns whether the notice was recreated, which ends a watch on the removed one. The file work
	 * runs off the event loop.
	 */
	async keepLive(): Promise<boolean> {
		if (performance.now() - this.refreshed < TICKET_REFRESH_MS) return false;
		this.refreshed = performance.now();
		const now = new Date(await this.queue.now());
		try {
			await utimes(this.path, now, now);
			return false;
		} catch (error) {
			if (!isVanishedTicket(error)) throw error;
			await this.queue.create(this, "w");
			return true;
		}
	}

	/** Whether an older live ticket is still ahead of this one, read off the event loop. */
	async behindOthers(): Promise<boolean> {
		return (await this.queue.liveTicketsOffLoop(this.name)).some((other) => other < this.name);
	}

	/** Watches this writer's release notice: anything that touches the file, as a releasing writer does. */
	watch(onUnavailable: (cause: Error) => void): ReleaseNotices {
		return new ReleaseNotices(this.noticePath, onUnavailable);
	}

	async leave(): Promise<void> {
		if (this.left) return;
		this.left = true;
		try {
			await this.queue.removeEntryOffLoop(this.name);
		} finally {
			waitingHere.delete(this.path);
		}
	}
}

/**
 * The release notices a queued writer receives while it waits: a change to its notice file, which is how the writer
 * that lets go of the lock hands it the turn. The watch starts before the writer first checks the lock. A notice that
 * arrives while the writer reads the queue or attempts the lock is kept until its next wait, which then ends at once,
 * so one sent while it checks is never lost; `clear` forgets the notices a fresh look at the queue and the lock covers.
 */
class ReleaseNotices {
	private watcher?: FSWatcher;
	private arrived = false;
	private wake?: () => void;

	constructor(path: string, onUnavailable: (cause: Error) => void) {
		try {
			const watcher = watch(path, () => {
				this.arrived = true;
				this.wake?.();
			});
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

	/** Forgets the notices received so far: the writer is about to look at the queue and the lock afresh. */
	clear(): void {
		this.arrived = false;
	}

	/** Resolves once a notice arrives, at once if one arrived since `clear`, or after `ms`. */
	wait(ms: number): Promise<void> {
		if (this.arrived) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.wake = undefined;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.wake = done;
		});
	}

	close(): void {
		this.watcher?.close();
		this.watcher = undefined;
	}
}

let holderSequence = 0;
const HOLDER_RECORD = /^(held|want) (\d{15})\n/;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Which process holds the write lock, for the error of a writer that gives up waiting for it. Each connection
 * records in a file of its own next to the database, named by its process, when it starts trying for the lock (before
 * its first attempt, which waits for the record to be written), when it took the lock, and that it is free once it
 * lets go or gives up; only its connection writes a record, so records never race. Nothing reads them until a writer
 * gives up: the live record taken most recently names the holder. A holder whose record does not yet say it took the
 * lock, stopped or starved right after taking it, still says it was trying for it; it is then one of the candidates the
 * writer that gives up lists, not named. A connection removes the records
 * of exited processes when it creates its own, so the killed ones do not pile up. Recording is a diagnostic: a
 * record that cannot be created, written or cleaned up never fails a transaction. The failure is recorded as a
 * degradation instead, and a writer that gives up waiting may then name no holder.
 */
class SqliteHolderRecord {
	private descriptor?: number;
	private writes: Promise<void> = Promise.resolve();
	private readonly directory: string;
	private readonly path: string;
	private readonly unavailable: (cause: unknown) => void;

	/** `unavailable` records a failure to keep the record, or to remove an exited process's. */
	constructor(databasePath: string, unavailable: (cause: unknown) => void) {
		this.directory = holderDirectory(databasePath);
		holderSequence += 1;
		this.path = join(this.directory, `${process.pid}-${holderSequence}`);
		this.unavailable = unavailable;
	}

	/**
	 * Creates the record off the event loop as a writable connection opens, removing exited processes' records on the
	 * way, so that taking the lock only writes to it in place.
	 */
	async open(): Promise<void> {
		try {
			await mkdir(this.directory, { recursive: true });
			await removeExitedHolderRecords(this.directory, this.unavailable);
			this.descriptor = await openFile(this.path, "w");
		} catch (cause) {
			this.unavailable(cause);
		}
	}

	/** Records that this connection is about to try for the lock; written before its first attempt. */
	trying(): Promise<void> {
		return this.write(`want ${String(Date.now()).padStart(15, "0")}\n`);
	}

	held(): Promise<void> {
		return this.write(`held ${String(Date.now()).padStart(15, "0")}\n`);
	}

	free(): Promise<void> {
		return this.write(`free ${"0".repeat(15)}\n`);
	}

	/** The process, this one or another, whose record says it took the write lock most recently; see `writeLockHolder`. */
	latestHolder(): Promise<WriteLockHolder | undefined> {
		return writeLockHolder(this.directory, basename(this.path));
	}

	async close(): Promise<void> {
		await this.writes;
		await this.remove();
	}

	private async remove(): Promise<void> {
		const descriptor = this.descriptor;
		if (descriptor === undefined) return;
		this.descriptor = undefined;
		try {
			await closeFile(descriptor);
			await unlink(this.path);
		} catch {
			// Already gone; a leftover record of an exited process is ignored and removed by whoever reads it.
		}
	}

	/**
	 * Every record has the same length and is written in place, so a reader never sees a shorter, stale tail. A
	 * connection without a record, read-only or unable to create one, writes nothing.
	 */
	private write(record: string): Promise<void> {
		this.writes = this.writes.then(async () => {
			const descriptor = this.descriptor;
			if (descriptor === undefined) return;
			try {
				await writeFileAt(descriptor, record, 0);
			} catch (cause) {
				await this.remove();
				this.unavailable(cause);
			}
		});
		return this.writes;
	}
}

function holderDirectory(databasePath: string): string {
	return `${databasePath}-holders`;
}

export function sqliteOpenLockPath(databasePath: string): string {
	return `${databasePath}-open.lock`;
}

type NativeOpenLocks = Pick<typeof native, "tryAdvisoryLock" | "trySharedAdvisoryLock"> &
	Partial<Pick<typeof native, "tryAdvisoryLockAsync" | "trySharedAdvisoryLockAsync">>;

interface HeldOpenLock {
	readonly lock: { release(): void };
	readonly path: string;
	readonly target: string;
}

let nativeOpenLocks: NativeOpenLocks | null | undefined;

function openLocks(): NativeOpenLocks | null {
	if (nativeOpenLocks === undefined) {
		try {
			let binding: Partial<NativeOpenLocks>;
			try {
				binding = createRequire(import.meta.url)("@bastani/atomic-natives") as Partial<NativeOpenLocks>;
			} catch {
				binding = createRequire(pathToFileURL(process.execPath).href)(
					"@bastani/atomic-natives",
				) as Partial<NativeOpenLocks>;
			}
			nativeOpenLocks =
				typeof binding.tryAdvisoryLock === "function" && typeof binding.trySharedAdvisoryLock === "function"
					? (binding as NativeOpenLocks)
					: null;
		} catch {
			nativeOpenLocks = null;
		}
	}
	return nativeOpenLocks;
}

function sqliteTargetFilePath(spec: string): string | undefined {
	if (spec === "" || spec === ":memory:") return undefined;
	if (!spec.startsWith("file:")) return spec;
	const hashIndex = spec.indexOf("#");
	const withoutHash = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
	const queryIndex = withoutHash.indexOf("?");
	const uriPart = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
	const queryPart = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
	if (new URLSearchParams(queryPart).get("mode") === "memory") return undefined;
	const body = uriPart.slice("file:".length);
	if (body === "" || body === ":memory:") return undefined;
	if (uriPart.startsWith("file://")) {
		try {
			return fileURLToPath(uriPart);
		} catch {
			return undefined;
		}
	}
	try {
		const decoded = decodeURIComponent(body);
		if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1);
		return resolve(decoded);
	} catch {
		return undefined;
	}
}

/**
 * Whether SQLite opens `spec` as an in-memory database: `:memory:`, `file::memory:`, or a `file:` URI whose last `mode`
 * parameter, the one SQLite applies, is `memory`. Anything else, a URI this cannot read included, may be a file.
 */
function isInMemoryDatabase(spec: string): boolean {
	if (spec === ":memory:") return true;
	if (!spec.startsWith("file:")) return false;
	const hashIndex = spec.indexOf("#");
	const withoutHash = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
	const queryIndex = withoutHash.indexOf("?");
	const uriPart = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
	if (uriPart === "file::memory:") return true;
	const query = new URLSearchParams(queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1));
	return query.getAll("mode").at(-1) === "memory";
}

function isMissingOpenLockDir(error: unknown): boolean {
	if (isMissingFile(error)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /No such file or directory|cannot find the path|os error [23]\b/i.test(message);
}

function pathExists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function resolveOpenLockTarget(filePath: string, readOnly: boolean): Promise<string | undefined> {
	try {
		return await realpath(filePath);
	} catch {
		if (readOnly) return undefined;
		await mkdir(dirname(filePath), { recursive: true });
		return join(await realpath(dirname(filePath)), basename(filePath));
	}
}

async function acquireOpenLock(
	filePath: string | undefined,
	readOnly: boolean,
	busyTimeoutMs: number,
): Promise<HeldOpenLock | undefined> {
	const locks = openLocks();
	if (locks === null || filePath === undefined) return undefined;
	const started = performance.now();
	let delay = 5;
	for (;;) {
		const target = await resolveOpenLockTarget(filePath, readOnly);
		if (target === undefined) return undefined;
		const lockPath = sqliteOpenLockPath(target);
		if (
			readOnly &&
			!(await pathExists(holderDirectory(target))) &&
			!(await pathExists(lockPath)) &&
			!(await pathExists(`${target}.lock`))
		)
			return undefined;
		let lock: { release(): void } | null = null;
		let refusal: unknown;
		try {
			lock =
				locks.trySharedAdvisoryLockAsync === undefined
					? legacySharedOpenLock(locks, sqliteFilePath(lockPath))
					: await locks.trySharedAdvisoryLockAsync(sqliteFilePath(lockPath), 0);
		} catch (error) {
			if (readOnly) return undefined;
			if (await isPassingOpenLockRefusal(error, lockPath)) refusal = error;
			else if (!isMissingOpenLockDir(error)) throw error;
		}
		if (lock !== null) {
			const held: HeldOpenLock = { lock, path: sqliteFilePath(lockPath), target };
			if (readOnly && !(await pathExists(target))) {
				await releaseOpenLock(held);
				return undefined;
			}
			return held;
		}
		const remaining = started + busyTimeoutMs - performance.now();
		if (remaining <= 0 && refusal !== undefined) throw refusal;
		if (remaining <= 0)
			throw Object.assign(new Error("database is locked"), {
				code: "ERR_SQLITE_ERROR",
				errcode: 5,
				errstr: "database is locked",
			});
		await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
		delay = Math.min(delay * 2, 50);
	}
}

/**
 * The shared open lock, tried once on the calling thread, for a native binding older than the one this package ships,
 * which has no form of it that runs elsewhere: an open still respects another process's exclusive lock.
 */
function legacySharedOpenLock(locks: NativeOpenLocks, lockPath: string): { release(): void } | null {
	return locks.trySharedAdvisoryLock(lockPath, 0);
}

/**
 * Windows refuses to create a file for a few milliseconds after another process removes one of the same name, with
 * `Access is denied` while nothing is at the path; an open waits that out like a held lock, within its busy timeout.
 * A refusal while a file is at the path is a real permission error.
 */
async function isPassingOpenLockRefusal(error: unknown, lockPath: string): Promise<boolean> {
	if (process.platform !== "win32") return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!/\(os error 5\)/.test(message)) return false;
	return lstat(lockPath).then(
		() => false,
		(cause: unknown) => isMissingFile(cause),
	);
}

function isOpenLockPermissionError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") return true;
	const message = error instanceof Error ? error.message : String(error);
	return process.platform === "win32"
		? /\(os error (?:5|19|65)\)/.test(message)
		: /\(os error (?:1|13|30)\)/.test(message);
}

function acquireOpenLockSync(location: string): HeldOpenLock | undefined {
	const locks = openLocks();
	const filePath = sqliteTargetFilePath(location);
	if (locks === null || filePath === undefined) return undefined;
	const target = realpathSync(filePath);
	const lockPath = sqliteFilePath(sqliteOpenLockPath(target));
	let lock: { release(): void } | null;
	try {
		lock = locks.trySharedAdvisoryLock(lockPath, 50);
	} catch (error) {
		if (isOpenLockPermissionError(error)) return undefined;
		throw error;
	}
	if (lock === null)
		throw Object.assign(new Error("database is locked"), {
			code: "ERR_SQLITE_ERROR",
			errcode: 5,
			errstr: "database is locked",
		});
	return { lock, path: lockPath, target };
}

async function releaseOpenLock(openLock: HeldOpenLock | undefined): Promise<void> {
	if (openLock === undefined) return;
	openLock.lock.release();
	try {
		const exclusive = (await openLocks()?.tryAdvisoryLockAsync?.(openLock.path, 0)) ?? null;
		if (exclusive !== null) {
			try {
				await rm(openLock.path, { force: true });
			} finally {
				exclusive.release();
			}
		}
	} catch {}
}

const openFile = promisify(open);
const closeFile = promisify(close);
const writeFileAt = promisify(write) as (descriptor: number, data: string, position: number) => Promise<unknown>;

/** The process a holder record belongs to, from its name: `<pid>-<sequence>`. */
function holderPid(name: string): number | undefined {
	const pid = Number(/^(\d+)-/.exec(name)?.[1] ?? Number.NaN);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Removes the records of exited processes, off the event loop. One another connection removed first is gone; any
 * other failure to remove one goes to `failed`, and the rest are still removed.
 */
async function removeExitedHolderRecords(directory: string, failed: (cause: unknown) => void): Promise<void> {
	for (const name of await readdir(directory)) {
		const pid = holderPid(name);
		if (pid === undefined || processAlive(pid)) continue;
		try {
			await unlink(join(directory, name));
		} catch (error) {
			if (!isVanishedTicket(error)) failed(error);
		}
	}
}

/** A live process's record: when it took the lock, or started trying for it; neither when it is free. */
interface LiveHolderRecord {
	readonly name: string;
	readonly pid: number;
	readonly heldSince?: number;
	readonly tryingSince?: number;
}

/** The records of live processes; the records of exited ones are removed. */
async function liveHolderRecords(directory: string): Promise<LiveHolderRecord[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const live: LiveHolderRecord[] = [];
	for (const name of names) {
		const pid = holderPid(name);
		if (pid === undefined) continue;
		if (!processAlive(pid)) {
			try {
				await unlink(join(directory, name));
			} catch {
				// Another connection removed it first.
			}
			continue;
		}
		let record: string;
		try {
			record = await readFile(join(directory, name), "utf8");
		} catch {
			continue;
		}
		const [, state, since] = HOLDER_RECORD.exec(record) ?? [];
		live.push({
			name,
			pid,
			...(state === "held" ? { heldSince: Number(since) } : {}),
			...(state === "want" ? { tryingSince: Number(since) } : {}),
		});
	}
	return live;
}

/** Who holds the write lock, as far as the records prove it. */
type WriteLockHolder = { readonly pid: number; readonly heldMs: number } | { readonly candidates: readonly number[] };

/**
 * The live process whose record says it took the write lock most recently, and for how long it has held it. A record
 * that says a connection is only trying for the lock proves nothing: a waiter stopped in the queue keeps saying so while
 * a later writer takes the lock past it. So when no record says it took the lock, as for a holder stopped before its
 * record could say so, no process is named; the processes of the other connections trying for the lock, not `own`, are
 * the candidates, one of which may hold it.
 */
async function writeLockHolder(directory: string, own: string): Promise<WriteLockHolder | undefined> {
	let held: { pid: number; since: number } | undefined;
	const candidates = new Set<number>();
	for (const record of await liveHolderRecords(directory)) {
		const { pid, heldSince, tryingSince } = record;
		if (heldSince !== undefined && (held === undefined || heldSince > held.since)) held = { pid, since: heldSince };
		if (record.name !== own && tryingSince !== undefined) candidates.add(pid);
	}
	if (held !== undefined) return { pid: held.pid, heldMs: Math.max(0, Date.now() - held.since) };
	return candidates.size === 0 ? undefined : { candidates: [...candidates].sort((a, b) => a - b) };
}

interface TransactionGates {
	readonly files: Map<string, Promise<void>>;
	readonly connections: WeakMap<object, Promise<void>>;
}

// Share gates across module reloads as well as adapter instances. Only live queues retain file identities.
const TRANSACTION_GATES = Symbol.for("atomic-storage/node-sqlite-transaction-gates@1");
const gateBag = globalThis as typeof globalThis & Record<symbol, TransactionGates | undefined>;
const gates: TransactionGates = gateBag[TRANSACTION_GATES] ?? { files: new Map(), connections: new WeakMap() };
gateBag[TRANSACTION_GATES] = gates;

function gateTransaction<T>(identity: string | object, operation: () => Promise<T>): Promise<T> {
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
/**
 * How long a refused writer keeps trying the lock on every event-loop turn once another connection has committed
 * since its last look (see `attemptThroughRelease`): one Windows timer tick (15.6 ms), so the attempts cover the time
 * between two ticks, when a writer that does not queue and runs on its own timers lets go of the lock.
 */
const LOCK_RELEASE_RETRY_MS = 16;
/** Most attempts in one `LOCK_RELEASE_RETRY_MS` span, so it ends even on a clock that does not move. */
const LOCK_RELEASE_RETRY_ATTEMPTS = 1_000;
/** Most transactions one group commit carries, so a batch cannot keep the write lock from other processes for long. */
const MAX_GROUP_COMMIT_TRANSACTIONS = 128;
/** Most statements one sequence request carries, so a message to the connection's thread stays small. */
const MAX_SEQUENCE_REQUEST_STATEMENTS = 256;
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
	/** The transaction callbacks it was requested in; its own callback runs inside them (see `runInHold`). */
	readonly scope: HoldScope | undefined;
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
	// A value over SQLite's length limit fails the same way every time: permanent, never an outage (#4954).
	if (payloadTooLargeKind(cause as StorageFailureCause) !== undefined) {
		return new StoragePayloadTooLargeError(SQLITE_PAYLOAD_LIMITS.value ?? 0, 0, {
			descriptor,
			cause: cause as StorageFailureCause,
		});
	}
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

/**
 * A connection whose statements run on the calling thread: an in-memory database, which never waits for the disk or
 * for a lock another connection holds, and a connection its caller opened and passed to `wrapNodeSqliteDatabase` (a
 * `DatabaseSync` cannot move to another thread). It answers each request as a connection's own thread does.
 */
class CallerThreadConnection {
	readonly connection: DatabaseSync;
	private readonly ownsConnection: boolean;

	constructor(connection: DatabaseSync, ownsConnection: boolean) {
		this.connection = connection;
		this.ownsConnection = ownsConnection;
	}

	request(request: SingleRequest): ConnectionAnswer {
		switch (request.kind) {
			case "open":
				return this.connection.location();
			case "exec":
				this.connection.exec(request.sql);
				return undefined;
			case "run":
				return { changes: Number(this.statement(request.sql).run(...request.params).changes) };
			case "get": {
				const row = this.statement(request.sql).get(...request.params);
				return row === undefined ? undefined : normalizeRow(row);
			}
			case "all":
				return this.statement(request.sql)
					.all(...request.params)
					.map((row) => normalizeRow(row));
			case "begin":
				this.begin();
				return undefined;
			case "dataVersion":
				return Number(this.connection.prepare("PRAGMA data_version").get()?.data_version ?? 0);
			case "now":
				return databaseNow();
			case "jsonbExtract":
				try {
					this.statement("SELECT jsonb_extract('[]', '$')");
					return true;
				} catch (error) {
					if (error instanceof Error && error.message === "no such function: jsonb_extract") return false;
					throw error;
				}
			case "close":
				if (this.ownsConnection) this.connection.close();
				finalizeReleasedStatements();
				return undefined;
		}
	}

	private statement(sql: string) {
		const prepared = this.connection.prepare(sql);
		prepared.setReadBigInts(true);
		return prepared;
	}

	/** One `BEGIN IMMEDIATE` that does not wait for a busy lock; see `NodeSqliteDatabase.tryBegin`. */
	private begin(): void {
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
	}
}

/**
 * Gives back the file's word and closes `current`'s hold when the connection's thread exits: a thread that is gone
 * holds no lock, whatever the transaction's callback still does. Outside the database's methods, so the listener keeps
 * only the cell and the word, not the database.
 */
function releaseOnExit(connection: ThreadConnection, current: { hold?: FileHold }, lock: FileLock): void {
	connection.onExit(() => {
		lock.clear();
		const hold = current.hold;
		current.hold = undefined;
		releaseHold(hold);
		// A thread that is gone no longer uses the word, whether or not its database is ever closed.
		lock.release();
	});
}

/** Where a connection's statements run: a thread of its own, or the calling thread. */
type SqliteConnection = ThreadConnection | CallerThreadConnection;

/** A request either connection answers. Only a connection on a thread of its own runs sequences. */
type SingleRequest = Exclude<ConnectionRequest, SequenceRequest>;

/**
 * Sends one request to `connection`: a promise of its answer from a connection on a thread of its own, and the answer
 * itself from one on the calling thread, which runs it before returning, as node:sqlite does.
 */
function send(connection: SqliteConnection, request: SingleRequest): ConnectionAnswer | Promise<ConnectionAnswer> {
	if (!(connection instanceof ThreadConnection) || !("params" in request)) return connection.request(request);
	return connection.request({ ...request, params: request.params.map(sendable) });
}

/**
 * A binary value as a connection's thread is sent it: the bytes it holds now, as a statement on the calling thread
 * binds them when it runs. A message shares a `SharedArrayBuffer` with the thread, so a change the caller makes before
 * the thread runs the statement would reach it, and it copies the whole buffer behind a view, so a view of part of a
 * buffer, or of a shared one, is sent as a copy of its own bytes. Any other value is sent as it is.
 */
function sendable(value: SqliteValue): SqliteValue {
	if (!isUint8Array(value)) return value;
	if (!isSharedArrayBuffer(value.buffer) && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength)
		return value;
	return new Uint8Array(value);
}

function sendableStatement({ sql, params }: SqliteStatement): SqliteStatement {
	return { sql, params: params.map(sendable) };
}

/** The index of the first text parameter holding NUL, which no statement may bind, or -1. */
function invalidTextParam(params: readonly SqliteValue[]): number {
	return params.findIndex((value) => typeof value === "string" && value.includes("\0"));
}

class NodeSqliteDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly connection: SqliteConnection;
	private jsonbExtract?: Promise<boolean>;
	private tail: Promise<void> = Promise.resolve();
	/** Operations queued on this connection so far; a batch's `position` is the one that commits it. */
	private enqueued = 0;
	/** Batches whose commit has not started, in order; the last one takes new transactions while it is open. */
	private readonly waitingBatches: PendingBatch[] = [];
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly executor: ReturnType<NodeSqliteDatabase["createExecutor"]>;

	private readonly transactionIdentity: string | object;
	private readonly lockWaitMs: number;
	private readonly groupCommitHoldMs: number;
	/** Cross-process first-come-first-served order for the write lock; absent for in-memory databases. */
	private readonly writeQueue?: SqliteWriteQueue;
	/** This connection's record of when it holds the write lock, named in the error of a writer that gives up. */
	private readonly holderRecord?: SqliteHolderRecord;
	private readonly openLock?: HeldOpenLock;
	private readonly lockUse = new WriteLockUse();
	/**
	 * This connection's file, as `fileIdentity` names it, and its part in sharing the file with the process's other
	 * connections to it: one on a thread of its own `holds` the file while it takes or holds its write lock, and one on
	 * the calling thread `waits` for those holds before a statement that could wait for the lock on this thread.
	 */
	private readonly fileGate?: { readonly file: string; readonly role: "holds" | "waits" };
	/**
	 * The hold of the transaction this connection takes or holds the write lock for (see `FileHold`), in a cell of its
	 * own that the thread's exit listener keeps, so the listener does not keep this database.
	 */
	private readonly current: { hold?: FileHold } = {};
	/** This connection's share of its file's lock word, which its thread moves as it takes and lets go of the lock. */
	private readonly fileLock?: FileLock;
	/** The ticket of the writer holding the lock, on its way out of the queue while the transaction runs. */
	private leaving?: { readonly ticket: string; readonly left: Promise<void> };
	/** What the writers' queue gave up on, once per reason, in the order it first happened. */
	private readonly degradations = new Map<StorageWriterQueueDegradedReason, StorageWriterQueueDegradedError>();

	constructor(
		connection: SqliteConnection,
		descriptor: StorageDescriptor,
		transactionIdentity: string | object = connection,
		lockWaitMs = DEFAULT_NODE_SQLITE_LOCK_WAIT_MS,
		groupCommitHoldMs = DEFAULT_GROUP_COMMIT_HOLD_MS,
		openLock?: HeldOpenLock,
		fileGate?: { readonly file: string; readonly role: "holds" | "waits" },
	) {
		this.fileGate = fileGate;
		if (fileGate?.role === "holds" && connection instanceof ThreadConnection) {
			this.fileLock = useFileLock(fileGate.file);
			releaseOnExit(connection, this.current, this.fileLock);
		}
		this.lockWaitMs = lockWaitMs;
		this.groupCommitHoldMs = groupCommitHoldMs;
		this.transactionIdentity = transactionIdentity;
		this.connection = connection;
		this.descriptor = descriptor;
		this.openLock = openLock;
		this.executor = this.createExecutor(() => true);
		if (typeof transactionIdentity === "string") {
			this.writeQueue = new SqliteWriteQueue(
				transactionIdentity,
				(reason, cause) => this.degraded(reason, cause),
				() => send(connection, { kind: "now" }) as number | Promise<number>,
			);
			this.holderRecord = new SqliteHolderRecord(transactionIdentity, (cause) =>
				this.degraded("holder-record-unavailable", cause),
			);
		}
	}

	supportsJsonbExtract(): Promise<boolean> {
		// Bun on macOS loads the system SQLite. Its functions need not match the build-time version.
		this.jsonbExtract ??= this.enqueueStatement(() => this.executor.checkJsonbExtract()).catch(() => {
			// A schema lock can also prevent preparation. Don't remember it as a missing function.
			this.jsonbExtract = undefined;
			return false;
		});
		return this.jsonbExtract;
	}

	/**
	 * The bytes this process may still write on the file system that holds the database file (where a link to it points,
	 * and where its write-ahead log goes), or undefined for a database in memory or when the file system does not say.
	 */
	async freeBytes(): Promise<number | undefined> {
		const path = this.descriptor.location;
		if (path === "" || path === ":memory:") return undefined;
		try {
			// The file itself, not its directory: a link to a database on another file system measures that file system.
			const { bavail, bsize } = await statfs(path);
			return Number(bavail) * Number(bsize);
		} catch {
			return undefined;
		}
	}

	/** Creates this connection's write-lock record; see `SqliteHolderRecord`. */
	async openHolderRecord(): Promise<void> {
		await this.holderRecord?.open();
	}

	writerQueueStats(): WriterQueueStats {
		return this.lockUse.stats(this.queueOp(() => this.writeQueue?.liveTickets().length ?? 0));
	}

	/**
	 * Sends one request to the connection. A driver failure is a `StorageUnavailableError`, thrown at once by a
	 * connection on the calling thread and rejected by one on a thread of its own.
	 */
	private call(request: SingleRequest): ConnectionAnswer | Promise<ConnectionAnswer> {
		let answer: ConnectionAnswer | Promise<ConnectionAnswer>;
		try {
			answer = send(this.connection, request);
		} catch (cause) {
			throw unavailable(this.descriptor, cause);
		}
		if (!(answer instanceof Promise)) return answer;
		return answer.catch((cause: unknown) => {
			throw unavailable(this.descriptor, cause);
		});
	}

	/**
	 * One non-blocking `BEGIN IMMEDIATE`. node:sqlite runs `busy_timeout` synchronously, so a lock held by another
	 * process would hold the connection's thread for the whole timeout. The attempt runs with `busy_timeout=0` and the
	 * connection's own value is restored before answering, so single statements outside a transaction keep it.
	 * Callers reach this only through `enqueue` and the transaction gate, so nothing else runs on the connection in
	 * between.
	 */
	private tryBegin(): undefined | Promise<undefined> {
		const lock = this.fileLock;
		return this.call(
			lock === undefined ? { kind: "begin" } : { kind: "begin", lockState: lock.buffer, lockTag: lock.tag },
		) as undefined | Promise<undefined>;
	}

	/** Changes whenever another connection commits to the database: the lock is being used, not held idle. */
	private async dataVersion(): Promise<number> {
		return (await this.call({ kind: "dataVersion" })) as number;
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
		let holding = false;
		try {
			// Before its first attempt, so a holder stopped or starved the moment it takes the lock is still named.
			await this.holderRecord?.trying();
			// Writers already waiting in other processes go first.
			const queue = this.writeQueue;
			queue?.observe();
			if (queue !== undefined && (await queue.contendedOffLoop())) {
				const waiting = await this.queueFileOp(() => queue.liveTicketsOffLoop());
				if (waiting.length > 0) ticket = await this.queueFileOp(() => queue.join(waiting));
			}
			// Read only once this writer waits, so an uncontended transaction pays nothing for it.
			let version = ticket === undefined ? undefined : await this.dataVersion();
			let stalledSince = performance.now();
			let lastCause: unknown;
			for (;;) {
				notices?.clear();
				if (ticket !== undefined) notices = await this.watchTicket(ticket, notices);
				const behind = ticket !== undefined && (await this.queueFileOp(() => ticket!.behindOthers()));
				if (!behind) {
					const attempt = this.attemptBegin();
					const refused = attempt instanceof Promise ? await attempt : attempt;
					if (refused === undefined) {
						holding = true;
						this.acquired(waitStarted);
						return;
					}
					lastCause = refused;
					if (ticket === undefined && queue !== undefined) {
						// A release before this ticket existed told nobody: watch it, then try once more before waiting.
						ticket = await this.queueFileOp(async () => queue.join(await queue.liveTicketsOffLoop()));
						continue;
					}
				}
				// Only another connection's commit is progress; a queued writer measures its stall the same way.
				const current = await this.dataVersion();
				const committed = version !== undefined && current !== version;
				if (version === undefined) version = current;
				else if (committed) {
					version = current;
					stalledSince = performance.now();
				}
				const stalledMs = performance.now() - stalledSince;
				if (stalledMs >= lockWaitMs) throw await this.lockWaitTimeout(lockWaitMs, stalledMs, behind, lastCause);
				if (!behind && committed && (await this.attemptThroughRelease())) {
					holding = true;
					this.acquired(waitStarted);
					return;
				}
				const recheckMs =
					notices?.watching === true || stalledMs >= this.lockWaitMs
						? LOCK_WAIT_RECHECK_MS
						: UNWATCHED_LOCK_RETRY_MS;
				const delay = Math.min(recheckMs, lockWaitMs - stalledMs);
				await (notices?.wait(delay) ?? new Promise<void>((resolve) => setTimeout(resolve, delay)));
			}
		} finally {
			notices?.close();
			// A writer holding the lock never waits for the queue's files: another connection of this process that writes
			// meanwhile waits for the lock in SQLite's busy handler, which blocks this thread until the lock is free, so
			// the holder could not go on. Its ticket leaves while the transaction runs; the release waits for it to be gone.
			if (holding && ticket !== undefined) this.leaving = { ticket: ticket.name, left: ticket.leave() };
			else await ticket?.leave();
			if (!holding) await this.holderRecord?.free();
		}
	}

	/**
	 * One attempt at the lock: `undefined` once it is taken, or the SQLITE_BUSY that refused it. Anything else fails.
	 * Answered at once on the calling thread, and as a promise by a connection on a thread of its own.
	 */
	private attemptBegin(): unknown {
		const refusal = (error: unknown): unknown => {
			const cause = error instanceof StorageUnavailableError ? error.cause : undefined;
			if (!isSqliteBusy(cause)) throw error;
			return cause;
		};
		// Open from the moment BEGIN is sent: the connection's thread may take the lock while this thread runs on.
		const hold = this.fileGate?.role === "holds" ? holdFile(this.fileGate.file) : undefined;
		let attempt: undefined | Promise<undefined>;
		try {
			attempt = this.tryBegin();
		} catch (error) {
			releaseHold(hold);
			return refusal(error);
		}
		if (!(attempt instanceof Promise)) {
			this.current.hold = hold;
			return undefined;
		}
		return attempt.then(
			() => {
				this.current.hold = hold;
				return undefined;
			},
			(error: unknown) => {
				releaseHold(hold);
				return refusal(error);
			},
		);
	}

	/**
	 * After a refused attempt, while other connections are committing through the lock, keeps attempting it on every
	 * event-loop turn for `LOCK_RELEASE_RETRY_MS`; returns whether it took the lock. A timer only ever wakes this writer
	 * on the system's timer tick, and on Windows that tick is 15.6 ms, shared by every process: a writer that does
	 * not queue (a raw SQLite client, an older Atomic) and takes the lock again from its own timer does so on the same
	 * tick, so the lock is free only between ticks and a writer that tried only when its timer fired never found it
	 * free while that writer kept committing. Trying on every turn for a tick finds the lock the moment such a
	 * writer's commit lets go of it.
	 */
	private async attemptThroughRelease(): Promise<boolean> {
		const until = performance.now() + LOCK_RELEASE_RETRY_MS;
		for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_ATTEMPTS && performance.now() < until; attempt++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if ((await this.attemptBegin()) === undefined) return true;
		}
		return false;
	}

	/**
	 * Keeps the ticket live and watched: one watch for the whole wait, started again only when the ticket had to be
	 * recreated, since a watch ends with the file it watched.
	 */
	private async watchTicket(ticket: SqliteWriteTicket, notices: ReleaseNotices | undefined): Promise<ReleaseNotices> {
		const recreated = await this.queueFileOp(() => ticket.keepLive());
		if (notices !== undefined && !recreated) return notices;
		notices?.close();
		return ticket.watch((cause) => this.degraded("watch-unavailable", cause));
	}

	private async lockWaitTimeout(
		lockWaitMs: number,
		stalledMs: number,
		behind: boolean,
		lastCause: unknown,
	): Promise<StorageWriteLockTimeoutError> {
		const holder = await this.holderRecord?.latestHolder();
		return new StorageWriteLockTimeoutError(
			this.descriptor,
			{
				timeoutMs: lockWaitMs,
				elapsedMs: Math.round(stalledMs),
				phase: behind ? "queued" : "acquiring",
				...(holder !== undefined && "pid" in holder ? { holderPid: holder.pid, holderHeldMs: holder.heldMs } : {}),
				...(holder !== undefined && "candidates" in holder
					? { holderCandidates: holder.candidates.join(", ") }
					: {}),
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
	private async released(committed: boolean): Promise<void> {
		const hold = this.current.hold;
		this.current.hold = undefined;
		releaseHold(hold);
		this.lockUse.released(committed);
		const recorded = this.holderRecord?.free();
		const leaving = this.leaving;
		this.leaving = undefined;
		// Gone before the turn is handed on, so the writer it wakes finds no ticket of this one ahead of it.
		await leaving?.left;
		try {
			await this.writeQueue?.wakeNext(leaving?.ticket);
		} catch (cause) {
			this.degraded("wake-failed", cause);
		}
		await recorded;
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
		reportDegradationInDebugMode(degradation);
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

	/** `queueOp` for the file work a waiting writer does off the event loop. */
	private async queueFileOp<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			throw new StorageWriterQueueUnusableError(this.descriptor, cause as StorageFailureCause);
		}
	}

	/**
	 * Statements on the connection, each sent the moment it is called, so calls a transaction makes without awaiting
	 * the ones before run in the order it made them, as on a connection that runs each one as it is called.
	 */
	private createExecutor(active: () => boolean): SqliteExecutor & { checkJsonbExtract(): Promise<boolean> } {
		const execute = async <T>(request: SingleRequest, params: readonly SqliteValue[] = []): Promise<T> => {
			if (!active()) throw new StorageTransactionClosedError();
			const invalidIndex = invalidTextParam(params);
			if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
			return this.call(request) as T | Promise<T>;
		};
		const executor = {
			checkJsonbExtract: () => execute<boolean>({ kind: "jsonbExtract" }),
			exec: (sql: string) => execute<void>({ kind: "exec", sql }),
			run: (sql: string, ...params: readonly SqliteValue[]) =>
				execute<{ changes: number }>({ kind: "run", sql, params }, params),
			get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute<T | undefined>({ kind: "get", sql, params }, params),
			all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute<T[]>({ kind: "all", sql, params }, params),
		};
		// On the calling thread a sequence would hold the event loop for all of its statements.
		const connection = this.connection;
		if (connection instanceof ThreadConnection)
			offerSequences(executor, (sequence) => this.sendSequence(connection, sequence, active));
		return executor;
	}

	/**
	 * Sends `sequence` to the connection's thread: `repeat` with the first statements as one request, and the rest in
	 * requests of at most `MAX_SEQUENCE_REQUEST_STATEMENTS`, each taken from `statements` and sent once the one before it
	 * has run. The thread reads the signal, through a flag shared with it, where a caller running the statements one at a
	 * time would check it. A statement whose text holds NUL fails as `run` fails it, after the statements before it ran.
	 */
	private async sendSequence(
		connection: ThreadConnection,
		{ repeat, statements, signal }: SqliteSequence,
		active: () => boolean,
	): Promise<number> {
		const repeats = repeat !== undefined && repeat.times > 0 ? repeat : undefined;
		const repeatInvalid = repeats === undefined ? -1 : invalidTextParam(repeats.statement.params);
		if (repeatInvalid !== -1) {
			signal?.throwIfAborted();
			throw new StorageInvalidTextError(repeatInvalid);
		}
		const shared = signal === undefined ? undefined : new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		// Only an actual abort of `signal` reaches a signal made from it: no other listener can keep the event from this
		// one, and an abort event dispatched on `signal` without aborting it does not reach it.
		const watched = signal === undefined ? undefined : AbortSignal.any([signal]);
		const raise = () => Atomics.store(new Int32Array(shared!), 0, 1);
		watched?.addEventListener("abort", raise);
		try {
			const pending = statements[Symbol.iterator]();
			let invalid = -1;
			let taken = false;
			let repeated = 0;
			for (let first = true; !taken || first; first = false) {
				const batch: SqliteStatement[] = [];
				while (!taken && batch.length < MAX_SEQUENCE_REQUEST_STATEMENTS) {
					const next = pending.next();
					if (next.done === true) {
						taken = true;
						break;
					}
					invalid = invalidTextParam(next.value.params);
					if (invalid !== -1) {
						taken = true;
						break;
					}
					batch.push(sendableStatement(next.value));
				}
				if (batch.length === 0 && !(first && repeats !== undefined)) continue;
				if (!active()) throw new StorageTransactionClosedError();
				signal?.throwIfAborted();
				const request: SequenceRequest = {
					kind: "sequence",
					...(first && repeats !== undefined
						? { repeat: { ...repeats, statement: sendableStatement(repeats.statement) } }
						: {}),
					statements: batch,
					...(shared === undefined ? {} : { abort: shared }),
				};
				const answer = (await connection.request(request).catch((cause: unknown) => {
					throw unavailable(this.descriptor, cause);
				})) as SequenceAnswer;
				if ("aborted" in answer) throw signal?.reason;
				if (first) repeated = answer.repeated;
			}
			if (invalid !== -1) {
				signal?.throwIfAborted();
				throw new StorageInvalidTextError(invalid);
			}
			return repeated;
		} finally {
			watched?.removeEventListener("abort", raise);
		}
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
		const scope = this.holdScope();
		return this.enqueueStatement(() => this.besideHolds(scope, undefined, () => this.executor.exec(sql)));
	}

	run(sql: string, ...params: readonly SqliteValue[]) {
		const bound = snapshotParams(params);
		const scope = this.holdScope();
		return this.enqueueStatement(() => this.besideHolds(scope, sql, () => this.executor.run(sql, ...bound), bound));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		const bound = snapshotParams(params);
		const scope = this.holdScope();
		return this.enqueueStatement(() =>
			this.besideHolds(scope, sql, () => this.executor.get<T>(sql, ...bound), bound),
		);
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		const bound = snapshotParams(params);
		const scope = this.holdScope();
		return this.enqueueStatement(() =>
			this.besideHolds(scope, sql, () => this.executor.all<T>(sql, ...bound), bound),
		);
	}

	/** The transaction callbacks a call to a connection on the calling thread is made in; see `besideHolds`. */
	private holdScope(): HoldScope | undefined {
		return this.fileGate?.role === "waits" ? currentHoldScope() : undefined;
	}

	/**
	 * Runs `call`, one call of a connection on the calling thread to a file, without holding this thread while another
	 * connection of this process, on a thread of its own, takes or holds the file's write lock: SQLite's busy handler
	 * would wait for that lock on this thread, which that connection's transaction needs to go on. While no such
	 * transaction is starting or open, and for every other connection, the call runs at once, as it always has; so does
	 * a call made inside that transaction's callback (`scope`), which the transaction waits for, and a single statement
	 * (`statement`) proven to only read, as a read in WAL mode never waits for the lock. Any other call, a script
	 * (`exec`) included, runs at once while the file's word says the lock is free, and holds the word while it runs, so
	 * the transaction cannot take the lock from under it; otherwise it waits off this thread, before anything of it
	 * runs, until the word is free. Still waiting at the connection's busy timeout, it fails with SQLITE_BUSY as the busy
	 * handler would, having run nothing. A call on a connection whose busy timeout cannot be read (an authorizer refuses
	 * it) runs as it always has: how long it may wait is SQLite's alone to know. Parameters `call` refuses (text with a
	 * NUL) are refused before anything else, as `call` would at once.
	 */
	private besideHolds<T>(
		scope: HoldScope | undefined,
		statement: string | undefined,
		call: () => Promise<T>,
		params: readonly SqliteValue[] = [],
	): Promise<T> {
		if (this.fileGate?.role !== "waits" || !(this.connection instanceof CallerThreadConnection)) return call();
		const { file } = this.fileGate;
		const gate = heldElsewhere(file, scope);
		if (gate === undefined) return call();
		if (params.some((value) => typeof value === "string" && value.includes("\0"))) return call();
		const owner = this.connection;
		const database = owner.connection;
		if (statement !== undefined && readsOnly(gate, owner, database, statement)) return call();
		return runWhenFree(file, gate, owner, database, call, () => unavailable(this.descriptor, sqliteBusyError()));
	}

	/** Idle-only housekeeping: do not join a batch, wait behind an operation on this handle or another handle's
	 * transaction, or get in front of writers already waiting on another process. */
	async tryMaintenance(callback: (tx: SqliteExecutor) => Promise<void>): Promise<boolean> {
		const scope = currentHoldScope();
		const position = this.enqueued;
		let idle = false;
		void this.tail.then(() => {
			idle = true;
		});
		await Promise.resolve();
		if (!idle || this.enqueued !== position || this.closing) return false;
		return this.enqueueStatement(async () => {
			const key = this.transactionIdentity;
			if (typeof key === "string" ? gates.files.has(key) : gates.connections.has(key)) return false;
			return gateTransaction(key, async () => {
				// The queue's directory outlives its writers: only a live ticket means a writer is waiting. One that cannot be
				// read counts as a writer waiting.
				const queue = this.writeQueue;
				if (queue !== undefined && (await queue.contendedOffLoop())) {
					const waiting = await queue.liveTicketsOffLoop().catch(() => undefined);
					if (waiting === undefined || waiting.length > 0) return false;
				}
				const start = performance.now();
				await this.holderRecord?.trying();
				try {
					const attempt = this.attemptBegin();
					if ((attempt instanceof Promise ? await attempt : attempt) !== undefined) {
						await this.holderRecord?.free();
						return false;
					}
				} catch (error) {
					await this.holderRecord?.free();
					throw error;
				}
				this.acquired(start);
				return new Promise<boolean>((resolve, reject) => {
					void this.commitAlone({ callback, resolve: () => resolve(true), reject, scope }).catch(reject);
				});
			});
		});
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
		if (options?.readOnly === true) {
			return this.enqueueStatement(async () => {
				await this.executor.exec("BEGIN");
				let active = true;
				try {
					const value = await callback(this.createExecutor(() => active));
					active = false;
					await this.executor.exec("COMMIT");
					return value;
				} catch (cause) {
					active = false;
					try {
						await this.executor.exec("ROLLBACK");
					} catch (rollbackCause) {
						throw new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause);
					}
					throw cause;
				}
			});
		}
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		return new Promise<T>((resolve, reject) => {
			const queued: QueuedTransaction = {
				callback,
				resolve: resolve as (value: unknown) => void,
				reject,
				lockWaitMs: options?.lockWaitMs,
				scope: currentHoldScope(),
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
			const value = await runInHold(this.current.hold, queued.scope, () =>
				queued.callback(this.createExecutor(() => active)),
			);
			active = false;
			await this.executor.exec("COMMIT");
			await this.released(true);
			queued.resolve(value);
		} catch (cause) {
			active = false;
			try {
				await this.executor.exec("ROLLBACK");
			} catch (rollbackCause) {
				await this.released(false);
				queued.reject(new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause));
				return;
			}
			await this.released(false);
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
				const value = await runInHold(this.current.hold, queued.scope, () =>
					queued.callback(this.createExecutor(() => active)),
				);
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
		await this.released(committed);
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
		await this.released(false);
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
			this.closePromise = this.tail.then(async () => {
				try {
					if (this.fileGate?.role === "waits") forgetPlans(this.fileGate.file, this.connection);
					await this.holderRecord?.close();
					await this.call({ kind: "close" });
				} finally {
					this.fileLock?.release();
					await releaseOpenLock(this.openLock);
				}
			});
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

/**
 * Longest Windows database path SQLite opens as written. SQLite's Windows file calls fail a path, or the `-journal`,
 * `-wal` or `-shm` file beside it, over 260 characters (`MAX_PATH`) with code 14 (#5139); this leaves room for those.
 */
const WINDOWS_SQLITE_PLAIN_PATH_LIMIT = 240;

/**
 * The path SQLite opens `path` by. On Windows a file path longer than SQLite can open as written takes the `\\?\`
 * long-path form, which SQLite accepts at any length (#5139). Every other path, `:memory:`, `file:` URIs and every
 * path on other platforms are passed unchanged, so the database's location reads as before wherever it fits.
 */
export function sqliteFilePath(path: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32" || path === ":memory:" || path.startsWith("file:")) return path;
	return win32.resolve(path).length > WINDOWS_SQLITE_PLAIN_PATH_LIMIT ? win32.toNamespacedPath(path) : path;
}

/** `location` without the `\\?\` or `\\?\UNC\` prefix of the Windows long-path form: the path it names. */
export function ordinarySqlitePath<T extends string | null>(location: T): T {
	if (location === null) return location;
	if (location.startsWith("\\\\?\\UNC\\")) return `\\\\${location.slice(8)}` as T;
	if (location.startsWith("\\\\?\\")) return location.slice(4) as T;
	return location;
}

/**
 * Opens an in-memory database (see `isInMemoryDatabase`) on the calling thread: it has no file, so neither opening it
 * nor its statements wait for the disk, and SQLite's busy handler never waits for it, since no connection of any
 * process holds a lock on it.
 */
function openOnCallerThread(
	Database: typeof DatabaseSync,
	path: string,
	readOnly: boolean,
): { readonly connection: CallerThreadConnection; readonly location: string | null } {
	const connection = new Database(path, { readOnly });
	return { connection: new CallerThreadConnection(connection, true), location: connection.location() };
}

/**
 * Opens `path` with SQLite on a thread of its own, through the long-path form when it needs it, and reports its
 * location as the ordinary path, so every reader of it (identity, error messages, callers comparing paths) sees the
 * path it was given whatever its length (#5139).
 */
async function openOnOwnThread(
	path: string,
	readOnly: boolean,
): Promise<{ readonly connection: ThreadConnection; readonly location: string | null }> {
	const { connection, location } = await ThreadConnection.open(path, { readOnly, openAs: sqliteFilePath(path) });
	return { connection, location: ordinarySqlitePath(location) };
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
	loadedDatabaseSync ??= Database;
	const targetFile = sqliteTargetFilePath(path);
	let heldOpenLock: HeldOpenLock | undefined;
	let connection: SqliteConnection | undefined;
	try {
		if (!readOnly && targetFile !== undefined) await mkdir(dirname(targetFile), { recursive: true });
		heldOpenLock = await acquireOpenLock(targetFile, readOnly, busyTimeoutMs);
		// A file-backed connection runs on a thread of its own, so opening it, waiting for its locks and its synced
		// commits never hold this thread (#5376).
		const opened = isInMemoryDatabase(path)
			? openOnCallerThread(Database, path, readOnly)
			: await openOnOwnThread(path, readOnly);
		const configured = opened.connection;
		connection = configured;
		const exec = (sql: string) => send(configured, { kind: "exec", sql });
		await exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
		if (!readOnly) {
			// SQLite does not wait for another process's lock while it changes the mode; the switch waits itself.
			await switchToWriteAheadLog(exec, busyTimeoutMs);
			await exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		}
		const location = opened.location;
		const identity =
			location === null
				? connection
				: heldOpenLock?.target !== undefined && location === targetFile
					? heldOpenLock.target
					: await realpath(location);
		if (typeof identity === "string" && heldOpenLock !== undefined && heldOpenLock.target !== identity) {
			await releaseOpenLock(heldOpenLock);
			heldOpenLock = await acquireOpenLock(identity, readOnly, busyTimeoutMs);
		}
		// A file this process may also reach through a connection on the calling thread; see `FileHold`.
		const gateFile =
			typeof identity === "string" && connection instanceof ThreadConnection
				? await fileIdentityAsync(identity)
				: undefined;
		const database = new NodeSqliteDatabase(
			connection,
			descriptor,
			identity,
			lockWaitMs,
			holdMs,
			heldOpenLock,
			gateFile === undefined ? undefined : { file: gateFile, role: "holds" },
		);
		Object.defineProperty(database, "readOnly", { value: readOnly });
		if (!readOnly) await database.openHolderRecord();
		return database;
	} catch (cause) {
		try {
			if (connection !== undefined) await send(connection, { kind: "close" });
		} catch {
			// Preserve the opening failure if cleanup also fails.
		} finally {
			await releaseOpenLock(heldOpenLock);
		}
		throw unavailable(descriptor, cause);
	}
}

/** The busy timeout `wrapNodeSqliteDatabase` sets on a caller's connection. */
const WRAPPED_BUSY_TIMEOUT_MS = 5000;

export function wrapNodeSqliteDatabase(connection: DatabaseSync): SqliteDatabase {
	const descriptor = { adapter: "node-sqlite", location: ":memory:" };
	let heldOpenLock: HeldOpenLock | undefined;
	try {
		descriptor.location = ordinarySqlitePath(connection.location()) || ":memory:";
		heldOpenLock = acquireOpenLockSync(descriptor.location);
		connection.exec(`PRAGMA busy_timeout=${WRAPPED_BUSY_TIMEOUT_MS}`);
		// SQLite does not wait for another process's lock while it changes the mode; the switch waits itself.
		switchToWriteAheadLogSync((sql) => connection.exec(sql), WRAPPED_BUSY_TIMEOUT_MS);
		connection.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		const gateFile = descriptor.location === ":memory:" ? undefined : fileIdentity(descriptor.location);
		return new NodeSqliteDatabase(
			new CallerThreadConnection(connection, false),
			descriptor,
			connection,
			undefined,
			undefined,
			heldOpenLock,
			gateFile === undefined ? undefined : { file: gateFile, role: "waits" },
		);
	} catch (cause) {
		void releaseOpenLock(heldOpenLock);
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
