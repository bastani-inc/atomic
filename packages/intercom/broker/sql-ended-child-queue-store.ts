import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	dialectOf,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import {
	ENDED_CHILD_QUEUE_BYTES_MAX,
	ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX,
	EndedChildQueueFullError,
} from "./ended-child-wakes.js";
import type { IntercomBrokerStateOptions } from "./multinode-state-store.js";
import { ensureBrokerSchema } from "./sql-schema.js";

/**
 * #5999 durable wake queue: the messages queued for subagents that ended (to be resumed, or kept while paused), kept
 * in SQL so they outlive the broker. One store, two places: the local `ended-child-queue.sqlite` in the Intercom
 * directory by default, or the shared `storage` database (tables `<prefix>intercom_ended_child_*`) with multi-node
 * routing on. An older broker never reads these tables.
 *
 * Rows are partitioned by the broker's `home` (the same across its restarts on one host) and fenced by `holder`, the
 * broker instance that last took them: every write after a restart names the holder, so a hung earlier instance that
 * resumes writes nothing to rows a later one took. Rows come back in insertion order (`seq`), never by time.
 */

/** The child a queued message waits for, as its departure knew it. */
export interface EndedQueueChild {
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly childId?: string;
	readonly outcome: string;
	readonly messages: "wake" | "hold";
}

/** The wake the broker had asked the owner for when the row was last written. */
export interface EndedQueueWake {
	readonly id: string;
	readonly depth: number;
	/** Wall-clock milliseconds when the owner said it is resuming the child. */
	readonly acceptedAt?: number;
}

/** What one queued message needs to be delivered after a restart, as its sender was when the broker took it. */
export interface EndedQueueEntry {
	readonly messageId: string;
	readonly ownerSessionId: string;
	/** The owner's host session (its return address), by which its next session takes the subagent over. */
	readonly ownerHost?: string;
	/** The normalized child name the departure is keyed by. */
	readonly childKey: string;
	readonly child: EndedQueueChild;
	/** The sender's registration as the broker took the send (JSON). */
	readonly sender: Readonly<Record<string, unknown>>;
	/** The send frame, verbatim (JSON). */
	readonly request: Readonly<Record<string, unknown>>;
	/** `request` and `sender` serialized already, as written: the bytes the caps counted. */
	readonly requestJson?: string;
	readonly senderJson?: string;
	readonly bytes: number;
	/** Wall-clock milliseconds. */
	readonly queuedAt: number;
	readonly wake?: EndedQueueWake;
}

export interface EndedQueueRow extends EndedQueueEntry {
	readonly seq: number;
	/** Wall-clock milliseconds since when the owner has been away, if it was away when the row was last written. */
	readonly ownerAwaySince?: number;
	/** Set once the message failed while its sender was not connected: told when it registers again. */
	readonly failed?: { readonly reason: string; readonly at: number };
	/** It was handed to its subagent, which had not confirmed it when the row was last written. */
	readonly dispatched?: true;
}

/** One wake the bounds counted, or a child back from a wake (`awake`), in wall-clock milliseconds. */
export interface EndedWakeBudgetEvent {
	readonly childKey: string;
	readonly kind: "wake" | "awake";
	readonly at: number;
	readonly depth: number;
}

export interface EndedQueueSnapshot {
	readonly rows: readonly EndedQueueRow[];
	readonly budget: readonly EndedWakeBudgetEvent[];
}

/** Rows one departure owns: its owner (host session, else session id) and its child. */
export interface EndedQueueDepartureKey {
	readonly ownerSessionId: string;
	readonly ownerHost?: string;
	readonly childKey: string;
}

/**
 * The bytes the caps count of what a store keeps: for one subagent's rows (`child`), and for all of them. While the store
 * still counts the rows it found when it opened (`counting`), each is at least its cap: nothing fits until it is done.
 */
export interface EndedQueueCounted {
	readonly child: number;
	readonly total: number;
	readonly counting: boolean;
}

export interface EndedChildQueueStore {
	/** This store's identity: the same across broker restarts while the store keeps its rows. */
	readonly id: string;
	/**
	 * Take every row of this home (also those an earlier instance held) and return them in order, with the budget. The
	 * rows are read a few at a time, at most about {@link ENDED_QUEUE_LOAD_PAGE_BYTES} of messages each, and `page` sees
	 * each page as it is read; the event loop runs between pages, so a full queue never holds it for long.
	 */
	load(page?: (rows: readonly EndedQueueRow[]) => void): Promise<EndedQueueSnapshot>;
	/** The subagent names and ids the kept messages are for (normalized), read before the messages themselves. */
	targets(): Promise<string[]>;
	/**
	 * What the caps count of the rows kept for `departure`'s subagent, and of all of them: never less than the store
	 * holds. A message counts from when it is added (before its row is written) until its row is deleted (once that
	 * commits), also while a delete that failed waits to be tried again. The rows the store held when it opened are
	 * counted after it opened, in the background; until then every subagent, and the store, count as full.
	 */
	counted(departure: EndedQueueDepartureKey): EndedQueueCounted;
	/** Resolves once the rows the store held when it opened are counted. */
	whenCounted(): Promise<void>;
	/**
	 * Write one queued message, and a wake the bounds counted for it; `duplicate` when its id is already kept. Refused with
	 * {@link EndedChildQueueFullError} when the store has no room left for it.
	 */
	add(entry: EndedQueueEntry, budget?: EndedWakeBudgetEvent): Promise<"added" | "duplicate">;
	/**
	 * The messages reached their child, or their sender was told they failed. A delete that fails is tried again, in
	 * steps that run only while the database is idle; its message counts until it goes.
	 */
	remove(messageIds: readonly string[]): Promise<void>;
	/** The messages were handed to their child; they stay until it confirms them. */
	dispatched(messageIds: readonly string[]): Promise<void>;
	/**
	 * The message failed while its sender was not connected: keep the reason until it is told, and only what telling it
	 * needs (its sender and whom it was for), not the message.
	 */
	fail(messageId: string, reason: string, at: number): Promise<void>;
	/** Record the departure's wake (or none) on its rows. */
	setWake(departure: EndedQueueDepartureKey, wake: EndedQueueWake | undefined): Promise<void>;
	/** Record since when the owner has been away (or that it is back) on its rows. */
	setOwnerAway(departures: readonly EndedQueueDepartureKey[], since: number | undefined): Promise<void>;
	/** The owner came back under another session id: its rows follow it. */
	rekeyOwner(departure: EndedQueueDepartureKey, ownerSessionId: string): Promise<void>;
	recordBudget(event: EndedWakeBudgetEvent): Promise<void>;
	close(): Promise<void>;
}

/**
 * How many free pages (4 KiB each) one step of giving the local file's space back frees: about 1 MiB, a few
 * milliseconds; the event loop runs between steps.
 */
export const ENDED_QUEUE_VACUUM_STEP_PAGES = 256;
/** How often, and how long apart, giving space back tries again while the database is busy. */
const VACUUM_BUSY_RETRIES = 50;
const VACUUM_BUSY_RETRY_MS = 20;
/** The write-ahead log of the local file is cut back to this many bytes after a checkpoint. */
const LOCAL_WAL_SIZE_LIMIT = 64 * 1024;

/** About how many bytes of messages one page of a load reads and parses before the event loop runs again. */
export const ENDED_QUEUE_LOAD_PAGE_BYTES = 1024 * 1024;

/** Budget events older than this are never read again: the wake window is 10 minutes. */
const BUDGET_EVENT_RETENTION_MS = 60 * 60_000;

type QueueRow = SqliteRow & {
	seq: number | bigint;
	message_id: string;
	owner_session_id: string;
	owner_host: string;
	child_key: string;
	child_json: string;
	sender_json: string;
	request_json: string;
	bytes: number | bigint;
	queued_at: number | bigint;
	wake_json: string | null;
	owner_away_since: number | bigint | null;
	failed_reason: string | null;
	failed_at: number | bigint | null;
	dispatched: number | bigint;
};

type BudgetRow = SqliteRow & { child_key: string; kind: string; at: number | bigint; depth: number | bigint };

function rowOf(row: QueueRow): EndedQueueRow {
	const wake = row.wake_json === null ? undefined : (JSON.parse(row.wake_json) as EndedQueueWake);
	return {
		seq: Number(row.seq),
		messageId: row.message_id,
		ownerSessionId: row.owner_session_id,
		...(row.owner_host === "" ? {} : { ownerHost: row.owner_host }),
		childKey: row.child_key,
		child: JSON.parse(row.child_json) as EndedQueueChild,
		sender: JSON.parse(row.sender_json) as Record<string, unknown>,
		request: JSON.parse(row.request_json) as Record<string, unknown>,
		bytes: Number(row.bytes),
		queuedAt: Number(row.queued_at),
		...(wake === undefined ? {} : { wake }),
		...(row.owner_away_since === null ? {} : { ownerAwaySince: Number(row.owner_away_since) }),
		...(row.failed_reason === null ? {} : { failed: { reason: row.failed_reason, at: Number(row.failed_at ?? 0) } }),
		...(Number(row.dispatched) === 1 ? { dispatched: true as const } : {}),
	};
}

/** How long a write waits for another process's write lock (on a timer, never blocking the event loop) before it fails. */
export const ENDED_QUEUE_LOCK_WAIT_MS = 5_000;

/**
 * The most bytes the local file may take: a backstop, should the caps' count of what it keeps ever be wrong. Four times
 * the per-broker cap and 64 MiB: a row takes about 0.9 KiB besides the bytes the caps count (its subagent, ids,
 * indexes, page fill), so the smallest messages take up to about 2.8 times their count on disk; the caps keep it below.
 * A write past it is refused alone ({@link EndedChildQueueFullError}), never lost silently.
 */
export const ENDED_QUEUE_FILE_BYTES_MAX = 4 * ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX + 64 * 1024 * 1024;

/** How many rows one page of counting what the store keeps reads before the event loop runs again. */
const COUNT_PAGE_ROWS = 2_048;
/** How many rows one statement of the sums a store counts when it opens covers. */
const COUNT_SUM_ROWS = 8_192;

/** How long after a failed delete it is tried again, at first; each failure doubles it, up to the most. */
const RETRY_DELETE_FIRST_MS = 100;
const RETRY_DELETE_MAX_MS = 5_000;

/** Whether `error` says the database has no room left: SQLite's SQLITE_FULL (13), Postgres's disk_full, or the disk's. */
function isStoreFull(error: unknown): boolean {
	let at: unknown = error;
	for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth++) {
		if (at instanceof EndedChildQueueFullError) return true;
		const failure = at as { code?: unknown; errcode?: unknown; message?: unknown; cause?: unknown };
		if (
			failure.errcode === 13 ||
			failure.code === "SQLITE_FULL" ||
			failure.code === "53100" ||
			failure.code === "ENOSPC" ||
			(typeof failure.message === "string" && /database or disk is full/i.test(failure.message))
		)
			return true;
		at = failure.cause;
	}
	return false;
}

/** One write of a batch whose savepoint could not be rolled back: the database rolled the whole transaction back. */
class BatchAborted extends Error {
	constructor(
		readonly index: number,
		readonly failure: unknown,
	) {
		super("a write ended its batch's transaction");
	}
}

function batchAbortedIn(error: unknown): BatchAborted | undefined {
	let at: unknown = error;
	for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth++) {
		if (at instanceof BatchAborted) return at;
		at = (at as { cause?: unknown }).cause;
	}
	return undefined;
}

/** A write that failed for want of room is refused as such. */
function refusalOf(error: unknown): unknown {
	return isStoreFull(error) && !(error instanceof EndedChildQueueFullError) ? new EndedChildQueueFullError(error) : error;
}

/**
 * Writes in order, a batch per transaction: writes asked for while one commits go together in the next, so a burst of
 * queued messages costs one commit, and an insert is always committed before a later delete of the same row.
 *
 * A batch that could not get the write lock within {@link ENDED_QUEUE_LOCK_WAIT_MS} fails, and so do the batches behind
 * it, at once, for as long again: a queued message's sender then hears within one lock wait, never one per batch
 * ahead of it (its client stops waiting for an answer after 10 s).
 */
class OrderedWrites {
	private pending: Array<{
		readonly write: (tx: SqliteExecutor) => Promise<unknown>;
		readonly resolve: (value: unknown) => void;
		readonly reject: (error: unknown) => void;
	}> = [];
	private running: Promise<void> | undefined;
	private brokenUntil = Number.NEGATIVE_INFINITY;
	private brokenBy: unknown;

	constructor(
		private readonly database: SqliteDatabase,
		private readonly lockWaitMs = ENDED_QUEUE_LOCK_WAIT_MS,
	) {}

	run<T>(write: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.pending.push({ write, resolve: resolve as (value: unknown) => void, reject });
			this.running ??= this.drain();
		});
	}

	/** Resolves once every write asked for so far settled. Each drain is awaited once: this never spins. */
	async idle(): Promise<void> {
		for (let seen: Promise<void> | undefined; this.running !== undefined && this.running !== seen; ) {
			seen = this.running;
			await seen;
		}
	}

	private async drain(): Promise<void> {
		// Never finish within the call that starts it: `run` stores this promise in `running` only once the call returns,
		// so a drain that cleared `running` before its first await (every write refused at once, the lock wait not over)
		// would leave a settled promise there for good, and no later write would ever start a drain.
		await Promise.resolve();
		while (this.pending.length > 0) {
			const batch = this.pending.splice(0);
			if (performance.now() < this.brokenUntil) {
				for (const item of batch) item.reject(this.brokenBy);
				continue;
			}
			try {
				// Each write in a savepoint of its own: one that fails rolls back alone and fails only its caller.
				const results = await this.database.transaction(async (tx) => {
					const outcomes: Array<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }> = [];
					for (const [index, item] of batch.entries()) {
						await tx.exec("SAVEPOINT ended_child_queue_write");
						try {
							outcomes.push({ ok: true, value: await item.write(tx) });
							await tx.exec("RELEASE SAVEPOINT ended_child_queue_write");
						} catch (error) {
							try {
								await tx.exec("ROLLBACK TO SAVEPOINT ended_child_queue_write");
								await tx.exec("RELEASE SAVEPOINT ended_child_queue_write");
							} catch {
								// SQLite rolled the whole transaction back (SQLITE_FULL does for a one-row write): the writes before
								// this one are gone too.
								throw new BatchAborted(index, error);
							}
							outcomes.push({ ok: false, error: refusalOf(error) });
						}
					}
					return outcomes;
				}, { lockWaitMs: this.lockWaitMs });
				batch.forEach((item, index) => {
					const outcome = results[index]!;
					if (outcome.ok) item.resolve(outcome.value);
					else item.reject(outcome.error);
				});
			} catch (error) {
				const aborted = batchAbortedIn(error);
				if (aborted !== undefined) {
					// Only the write that ended the transaction fails; the others, none of which committed, go again at once,
					// ahead of anything asked for since. The lock was taken: nothing to break.
					const [failed] = batch.splice(aborted.index, 1);
					failed?.reject(refusalOf(aborted.failure));
					this.pending.unshift(...batch);
					continue;
				}
				this.brokenUntil = performance.now() + this.lockWaitMs;
				this.brokenBy = error;
				for (const item of batch) item.reject(error);
			}
		}
		this.running = undefined;
	}
}

/** The key a row counts under for its subagent's cap: its owner's host session (else its session id) and its child. */
function countedKey(ownerHost: string, ownerSessionId: string, childKey: string): string {
	return JSON.stringify(ownerHost === "" ? ["session", ownerSessionId, childKey] : ["host", ownerHost, childKey]);
}

function countedKeyOf(departure: EndedQueueDepartureKey): string {
	return countedKey(departure.ownerHost ?? "", departure.ownerSessionId, departure.childKey);
}

/**
 * - `reserved`: added, its row not written yet (it counts already);
 * - `stored`: its row is written;
 * - `deleting`: its delete failed: the row may still be there, and the delete is tried again.
 */
type CountedState = "reserved" | "stored" | "deleting";

interface CountedRow {
	key: string;
	bytes: number;
	state: CountedState;
	/** When it last changed, on the ledger's own clock. */
	changedAt: number;
	/** A row of an earlier keeper of this home: it goes when this broker takes the rows over. */
	earlier?: true;
}

/**
 * What the caps count of a store's rows, by message id, so counting one twice or releasing one twice is never
 * possible: a message counts from when it is added until its row's delete commits.
 */
class CountedRows {
	private readonly rows = new Map<string, CountedRow>();
	private readonly byKey = new Map<string, number>();
	private readonly deletingIds = new Set<string>();
	/**
	 * What the store's sums counted when it opened, per key, for rows not counted by id yet: this keeper's (counted by id
	 * once `load` reads them) and an earlier keeper's (gone once this broker takes the rows over).
	 */
	private readonly baseline = new Map<string, { ours: number; earlier: number }>();
	private totalBytes = 0;
	private clock = 0;
	/** While a recount reads the store: the rows released meanwhile, which its read may still show. */
	private releasedDuringRecount: Set<string> | undefined;

	counted(key: string): Omit<EndedQueueCounted, "counting"> {
		return { child: this.byKey.get(key) ?? 0, total: this.totalBytes };
	}

	get(messageId: string): CountedRow | undefined {
		return this.rows.get(messageId);
	}

	/** The rows whose delete waits to be tried again. */
	deleting(): string[] {
		return [...this.deletingIds];
	}

	/** Whether any message is counted that is neither gone nor going: the queue has not drained. */
	holdsMessages(): boolean {
		return this.rows.size > this.deletingIds.size || this.baseline.size > 0;
	}

	/** Rows the store's sums counted when it opened, not by id. */
	countSum(key: string, bytes: number, earlier: boolean): void {
		const sums = this.baseline.get(key) ?? { ours: 0, earlier: 0 };
		if (earlier) sums.earlier += bytes;
		else sums.ours += bytes;
		this.baseline.set(key, sums);
		this.add(key, bytes);
	}

	/** A row of this keeper, read whole: counted by id from now on, instead of in the sums. */
	adopt(messageId: string, key: string, bytes: number): void {
		if (this.rows.has(messageId)) return;
		const sums = this.baseline.get(key);
		// Never less than counted: a row the sums did not hold (written since) counts on top of them.
		if (sums !== undefined && sums.ours >= bytes) {
			sums.ours -= bytes;
			this.add(key, -bytes);
			if (sums.ours === 0 && sums.earlier === 0) this.baseline.delete(key);
		}
		this.count(messageId, key, bytes, "stored");
	}

	/** An earlier keeper's rows are gone: this broker took the rows over. */
	releaseEarlier(): void {
		for (const [messageId, row] of [...this.rows]) if (row.earlier === true) this.release(messageId);
		for (const [key, sums] of [...this.baseline]) {
			this.add(key, -sums.earlier);
			sums.earlier = 0;
			if (sums.ours === 0) this.baseline.delete(key);
		}
	}

	count(messageId: string, key: string, bytes: number, state: CountedState, earlier = false): void {
		this.forget(messageId);
		this.deletingIds.delete(messageId);
		this.rows.set(messageId, { key, bytes, state, changedAt: ++this.clock, ...(earlier ? { earlier: true as const } : {}) });
		if (state === "deleting") this.deletingIds.add(messageId);
		this.add(key, bytes);
	}

	mark(messageId: string, state: CountedState): void {
		const row = this.rows.get(messageId);
		if (row === undefined) return;
		row.state = state;
		row.changedAt = ++this.clock;
		if (state === "deleting") this.deletingIds.add(messageId);
		else this.deletingIds.delete(messageId);
	}

	/** Its row is smaller now, or counts under another key: only once that change committed. */
	change(messageId: string, change: { readonly key?: string; readonly bytes?: number }): void {
		const row = this.rows.get(messageId);
		if (row === undefined) return;
		this.add(row.key, -row.bytes);
		row.key = change.key ?? row.key;
		row.bytes = change.bytes ?? row.bytes;
		row.changedAt = ++this.clock;
		this.add(row.key, row.bytes);
	}

	/** The row is gone (its delete committed), or never written (its write rolled back). */
	release(messageId: string): void {
		this.releasedDuringRecount?.add(messageId);
		this.forget(messageId);
	}

	/** The rows that count under `key`. */
	under(key: string): string[] {
		return [...this.rows].filter(([, row]) => row.key === key).map(([messageId]) => messageId);
	}

	/**
	 * Recount from what the store holds: `read` returns every row of the home. A row it shows counts, at its size there;
	 * a counted one it does not show is dropped only if its row was written (or deleting) before the read began, so a
	 * row added meanwhile, or not written yet, still counts. Never counts less than the store holds.
	 */
	async recount(read: () => Promise<ReadonlyMap<string, FoundRow>>): Promise<void> {
		const readAt = ++this.clock;
		const released = new Set<string>();
		this.releasedDuringRecount = released;
		let found: ReadonlyMap<string, FoundRow>;
		try {
			found = await read();
		} finally {
			this.releasedDuringRecount = undefined;
		}
		for (const [messageId, row] of [...this.rows]) {
			if (found.has(messageId) || row.state === "reserved" || row.changedAt > readAt) continue;
			this.forget(messageId);
		}
		// Every row the sums counted is in what was read, unless it went meanwhile: counted by id from now on.
		for (const [key, sums] of this.baseline) this.add(key, -(sums.ours + sums.earlier));
		this.baseline.clear();
		for (const [messageId, row] of found) {
			const counted = this.rows.get(messageId);
			if (counted === undefined) {
				// Released while the read ran: its delete committed after the read saw it.
				if (!released.has(messageId)) this.count(messageId, row.key, row.bytes, "stored", row.earlier);
			} else if (counted.changedAt <= readAt && (counted.key !== row.key || counted.bytes !== row.bytes))
				this.change(messageId, row);
		}
	}

	private forget(messageId: string): void {
		const row = this.rows.get(messageId);
		if (row === undefined) return;
		this.rows.delete(messageId);
		this.deletingIds.delete(messageId);
		this.add(row.key, -row.bytes);
	}

	private add(key: string, bytes: number): void {
		this.totalBytes += bytes;
		const next = (this.byKey.get(key) ?? 0) + bytes;
		if (next === 0) this.byKey.delete(key);
		else this.byKey.set(key, next);
	}
}

/** A row as a count reads it from the store. */
interface FoundRow {
	readonly key: string;
	readonly bytes: number;
	readonly earlier: boolean;
}

/** The parts of a failed message its sender's failure needs (whom it was for, and who sent it), not the message. */
function failureForm(senderJson: string, requestJson: string | null): { readonly senderJson: string; readonly requestJson: string } | undefined {
	try {
		const sender = JSON.parse(senderJson) as { info?: { id?: unknown }; registrationReturnAddress?: unknown };
		const request = (requestJson === null ? {} : JSON.parse(requestJson)) as Record<string, unknown>;
		if (typeof sender.info?.id !== "string") return undefined;
		return {
			senderJson: JSON.stringify({
				info: { id: sender.info.id },
				...(typeof sender.registrationReturnAddress === "string"
					? { registrationReturnAddress: sender.registrationReturnAddress }
					: {}),
			}),
			requestJson: JSON.stringify({
				type: request.type,
				to: request.to,
				...(request.logicalTarget === undefined ? {} : { logicalTarget: request.logicalTarget }),
			}),
		};
	} catch {
		return undefined;
	}
}

/**
 * #5999: the queue on `database`, tables `<prefix>intercom_ended_child_queue`, `<prefix>intercom_ended_child_wakes` and
 * `<prefix>intercom_ended_child_meta`. `home` partitions the rows by broker home; `holder` is this broker instance.
 */
export async function openSqlEndedChildQueueStore(
	{ database, prefix }: IntercomBrokerStateOptions,
	{
		home,
		holder,
		ownsDatabase = false,
		retire: retiring = false,
		lockWaitMs = ENDED_QUEUE_LOCK_WAIT_MS,
		servedSinceLastHolder,
		pid,
		compact = false,
	}: {
		readonly home: string;
		readonly holder: string;
		readonly ownsDatabase?: boolean;
		/** How long a write waits for another process's write lock (default {@link ENDED_QUEUE_LOCK_WAIT_MS}). */
		readonly lockWaitMs?: number;
		/**
		 * Whether another broker can have served this home since the store's last holder, which kept nothing and told
		 * senders their messages were lost: given the store's identity, says if this broker could not prove it did not.
		 * Unproven, a store with messages is retired. Absent: never retired so.
		 */
		readonly servedSinceLastHolder?: (storeId: string) => boolean;
		/** This broker's process id, recorded as the store's holder. */
		readonly pid?: string;
		/** A broker that kept the queue in memory told its sessions what this store kept was lost: drop it. */
		readonly retire?: boolean;
		/**
		 * The database is this store's own file: once its queue drains, the file gives the space its messages took back,
		 * a bounded step at a time (incremental auto-vacuum). A shared database keeps its own maintenance.
		 */
		readonly compact?: boolean;
	},
): Promise<EndedChildQueueStore> {
	let retire = retiring;
	const valid = validateStoragePrefix(prefix, dialectOf(database).name);
	const queue = `${valid}intercom_ended_child_queue`;
	// The messages themselves, apart from the rows a broker updates (holder, wake, away, handed over): an update never
	// rewrites a message.
	const bodies = `${valid}intercom_ended_child_bodies`;
	const wakes = `${valid}intercom_ended_child_wakes`;
	const meta = `${valid}intercom_ended_child_meta`;
	const { types } = dialectOf(database);
	const createSchema = () => ensureBrokerSchema(database, prefix, "ended-child-queue", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${queue}(
				seq ${types.serialKey},
				message_id TEXT NOT NULL UNIQUE,
				home TEXT NOT NULL,
				holder TEXT NOT NULL,
				keeper TEXT NOT NULL,
				owner_session_id TEXT NOT NULL,
				owner_host TEXT NOT NULL,
				child_key TEXT NOT NULL,
				child_json TEXT NOT NULL,
				sender_json TEXT NOT NULL,
				bytes ${types.int} NOT NULL,
				queued_at ${types.int} NOT NULL,
				wake_json TEXT,
				owner_away_since ${types.int},
				failed_reason TEXT,
				failed_at ${types.int},
				dispatched ${types.int} NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS ${queue}_home ON ${queue}(home, seq);
			CREATE TABLE IF NOT EXISTS ${bodies}(
				message_id TEXT PRIMARY KEY,
				request_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${queue}_departure ON ${queue}(home, owner_host, owner_session_id, child_key);
			CREATE TABLE IF NOT EXISTS ${wakes}(
				home TEXT NOT NULL,
				child_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				at ${types.int} NOT NULL,
				depth ${types.int} NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${wakes}_home ON ${wakes}(home, at);
			CREATE TABLE IF NOT EXISTS ${meta}(
				home TEXT PRIMARY KEY,
				store_id TEXT NOT NULL,
				holder_pid TEXT
			);
		`),
	);
	// The identity of a store already set up is read without a write, so a broker's start never waits for another
	// process's write lock on it (a reader of a write-ahead log is not blocked by a writer). A new one is set up first.
	const readMeta = async (): Promise<{ readonly id: string; readonly holderPid?: string } | undefined> => {
		try {
			const row = await database.get<SqliteRow & { store_id: string; holder_pid: string | null }>(
				`SELECT store_id, holder_pid FROM ${meta} WHERE home = ?`,
				home,
			);
			if (row === undefined) return undefined;
			return { id: row.store_id, ...(row.holder_pid === null ? {} : { holderPid: row.holder_pid }) };
		} catch {
			return undefined;
		}
	};
	const known = await readMeta();
	// Another broker (an earlier version, which keeps no such queue) served this home since the store's last holder: its
	// sessions were told what the store kept was lost, so it is retired rather than delivered after all.
	if (!retire && known !== undefined && servedSinceLastHolder?.(known.id) === true) {
		const kept = await database.get<SqliteRow>(`SELECT 1 AS found FROM ${queue} WHERE home = ? AND keeper = ? LIMIT 1`, home, known.id);
		if (kept !== undefined) retire = true;
	}
	let id = retire ? undefined : known?.id;
	if (id === undefined) {
		await createSchema();
		id = await database.transaction(async (tx) => {
			// A broker that could not use the store told its sessions their messages were lost: what the store kept for this
			// home before is never delivered (the rows of an earlier keeper are dropped when they are taken up).
			if (retire) await tx.run(`DELETE FROM ${meta} WHERE home = ?`, home);
			await tx.run(`INSERT INTO ${meta}(home, store_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, home, randomUUID());
			const row = await tx.get<SqliteRow & { store_id: string }>(`SELECT store_id FROM ${meta} WHERE home = ?`, home);
			return row?.store_id as string;
		});
	}
	const keeper = id;
	const writes = new OrderedWrites(database, lockWaitMs);
	let compacting: Promise<void> | undefined;
	let closing = false;
	const pragmaOf = async (executor: SqliteExecutor, name: string): Promise<number> => {
		const row = await executor.get<SqliteRow>(`PRAGMA ${name}`);
		return Number(row === undefined ? 0 : Object.values(row)[0]);
	};
	/**
	 * The local file gives back the space of messages that are gone, once its queue is empty. With no free page (the
	 * usual small drain) it does nothing, not even a transaction. Otherwise each step frees at most
	 * {@link ENDED_QUEUE_VACUUM_STEP_PAGES} pages in a maintenance transaction of its own, which runs only while this
	 * database is idle and checks in that same transaction that no message waits; the event loop runs between steps.
	 * Once pages were freed, a checkpoint that never waits folds the log into the file, and one more maintenance
	 * transaction starts the log afresh, cut back to its size limit. No part of it waits for another process's lock or
	 * goes through the message writes, so it never delays, fails or holds off a message write: a busy database is left
	 * alone until the next drain.
	 */
	const giveSpaceBack = async (): Promise<void> => {
		const maintain = database.tryMaintenance?.bind(database);
		if (maintain === undefined || (await pragmaOf(database, "auto_vacuum")) !== 2) return;
		let freed = false;
		let busy = 0;
		while (!closing && (await pragmaOf(database, "freelist_count")) > 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			const step = { messages: false };
			const ran = await maintain(async (tx) => {
				if ((await tx.get(`SELECT 1 AS found FROM ${queue} LIMIT 1`)) !== undefined) {
					step.messages = true;
					return;
				}
				await tx.exec(`PRAGMA incremental_vacuum(${ENDED_QUEUE_VACUUM_STEP_PAGES})`);
			});
			if (!ran) {
				if (++busy > VACUUM_BUSY_RETRIES) break;
				await new Promise<void>((resolve) => setTimeout(resolve, VACUUM_BUSY_RETRY_MS));
				continue;
			}
			// Messages wait again: they reuse the free pages; the next drain gives back what is left.
			if (step.messages) break;
			freed = true;
		}
		if (closing || !freed) return;
		await database.exec("PRAGMA wal_checkpoint(PASSIVE)");
		// A write that changes nothing writes nothing: the header's user version, unused, flips between 0 and 1.
		const restarted = await maintain(async (tx) =>
			tx.exec(`PRAGMA user_version = ${(await pragmaOf(tx, "user_version")) === 0 ? 1 : 0}`),
		);
		if (restarted && !closing) await database.exec("PRAGMA wal_checkpoint(PASSIVE)");
	};
	let compactAgain = false;
	const compactSoon = (): void => {
		if (!compact || closing) return;
		// A drain while space is being given back is looked at once that is over.
		if (compacting !== undefined) {
			compactAgain = true;
			return;
		}
		compacting = giveSpaceBack()
			.catch(() => {})
			.finally(() => {
				compacting = undefined;
				if (compactAgain) {
					compactAgain = false;
					compactSoon();
				}
			});
	};
	if (compact) {
		await database.exec(`PRAGMA journal_size_limit = ${LOCAL_WAL_SIZE_LIMIT}`);
		// A file that cannot give space back (new, or written before this) is converted while its queue is empty, before
		// anything else can use it: VACUUM rewrites the live data, none then. It never waits for another process's lock;
		// a busy file is converted at a later open.
		const empty =
			(await database.transaction((tx) => tx.get(`SELECT 1 AS found FROM ${queue} LIMIT 1`), { readOnly: true })) ===
			undefined;
		if (empty && (await pragmaOf(database, "auto_vacuum")) !== 2) {
			const configured = await pragmaOf(database, "busy_timeout");
			await database.exec("PRAGMA busy_timeout = 0");
			try {
				await database.exec("PRAGMA auto_vacuum = INCREMENTAL");
				await database.exec("VACUUM");
				// The rewritten file is in the log: fold it in, which cuts the file back, and empty the log.
				await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch {
				// Busy: converted at a later open.
			} finally {
				await database.exec(`PRAGMA busy_timeout = ${configured}`);
			}
		}
		// The backstop: the file never grows past this, whatever the caps counted (a setting of this connection). Set once
		// a file from before was converted: it cannot be set below the file's size then.
		const pageSize = Math.max(512, await pragmaOf(database, "page_size"));
		await database.exec(`PRAGMA max_page_count = ${Math.ceil(ENDED_QUEUE_FILE_BYTES_MAX / pageSize)}`);
		compactSoon();
	}
	// Every row of the store, read whole a page at a time, for a recount: its key, the size it recorded when it was
	// written (its sender and its message as written), and whether an earlier keeper wrote it. One statement a page,
	// outside a transaction (a read never waits for a writer): a page is consistent in itself, and a recount's rules
	// hold across pages (see `CountedRows.recount`); the event loop runs between pages.
	const readCounted = async (each: (messageId: string, row: FoundRow) => void): Promise<void> => {
		for (let after = -1; ; ) {
			const rows = await database.all<
				SqliteRow & {
					seq: number | bigint;
					message_id: string;
					owner_host: string;
					owner_session_id: string;
					child_key: string;
					keeper: string;
					bytes: number | bigint;
				}
			>(
				`SELECT seq, message_id, owner_host, owner_session_id, child_key, keeper, bytes FROM ${queue}
				 WHERE home = ? AND seq > ? ORDER BY seq LIMIT ${COUNT_PAGE_ROWS}`,
				home,
				after,
			);
			for (const row of rows)
				each(row.message_id, {
					key: countedKey(row.owner_host, row.owner_session_id, row.child_key),
					bytes: Number(row.bytes),
					earlier: row.keeper !== keeper,
				});
			if (rows.length < COUNT_PAGE_ROWS) return;
			after = Number(rows[rows.length - 1]!.seq);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	// What the caps count of the store: the sums of every row of this home, per subagent, an earlier keeper's too (they
	// stay until this broker takes the rows over). Counted once the store is open, in the background, never while it
	// opens (a broker that opens it waits for nothing more than the store's own setup): a page of rows per statement,
	// the event loop running between pages, and no read waits for a lock. Until the count is done, every subagent and the
	// store count as full (see `counted`), so nothing queued meanwhile can pass a cap. Rows this broker writes meanwhile
	// are counted by id, and `load` counts this keeper's rows by id as it reads them, once the count is done.
	const ledger = new CountedRows();
	// The rows written before this one opened the store: any later one is this broker's, counted by id.
	const newest = await database.get<SqliteRow & { seq: number | bigint | null }>(`SELECT MAX(seq) AS seq FROM ${queue}`);
	const countedUpTo = newest?.seq === null || newest?.seq === undefined ? -1 : Number(newest.seq);
	let counting = true;
	let countDone: () => void = () => {};
	const countedAll = new Promise<void>((resolve) => {
		countDone = resolve;
	});
	const finishCounting = (): void => {
		if (!counting) return;
		counting = false;
		countDone();
	};
	// A page of rows (by their sequence) per statement, so the number of statements follows the rows, never the span of
	// their sequence numbers (shared by every home of a shared database, and never reused).
	const sumRows = async (): Promise<void> => {
		for (let after = -1; after < countedUpTo; ) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (closing) return;
			const sums = await database.all<
				SqliteRow & {
					owner_host: string;
					owner_session_id: string;
					child_key: string;
					keeper: string;
					page_bytes: number | bigint;
					last_seq: number | bigint;
					row_count: number | bigint;
				}
			>(
				`SELECT owner_host, owner_session_id, child_key, keeper, SUM(bytes) AS page_bytes, MAX(seq) AS last_seq, COUNT(*) AS row_count
				 FROM (SELECT owner_host, owner_session_id, child_key, keeper, bytes, seq FROM ${queue}
					WHERE home = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ${COUNT_SUM_ROWS}) page
				 GROUP BY owner_host, owner_session_id, child_key, keeper`,
				home,
				after,
				countedUpTo,
			);
			let rows = 0;
			for (const sum of sums) {
				ledger.countSum(countedKey(sum.owner_host, sum.owner_session_id, sum.child_key), Number(sum.page_bytes), sum.keeper !== keeper);
				rows += Number(sum.row_count);
				after = Math.max(after, Number(sum.last_seq));
			}
			if (rows < COUNT_SUM_ROWS) return;
		}
	};
	/** Delete one row this instance holds, its message too; whether there was one. */
	const deleteRow = async (tx: SqliteExecutor, messageId: string): Promise<boolean> => {
		const { changes } = await tx.run(
			`DELETE FROM ${queue} WHERE message_id = ? AND home = ? AND holder = ?`,
			messageId,
			home,
			holder,
		);
		if (changes !== 0) await tx.run(`DELETE FROM ${bodies} WHERE message_id = ?`, messageId);
		return changes !== 0;
	};
	/** Take this home's rows over: the first of this broker's writes once it loaded them (see `load`). */
	const takeOver = async (tx: SqliteExecutor): Promise<void> => {
		if (pid !== undefined) await tx.run(`UPDATE ${meta} SET holder_pid = ? WHERE home = ?`, pid, home);
		await tx.run(
			`DELETE FROM ${bodies} WHERE message_id IN (SELECT message_id FROM ${queue} WHERE home = ? AND keeper <> ?)`,
			home,
			keeper,
		);
		await tx.run(`DELETE FROM ${queue} WHERE home = ? AND keeper <> ?`, home, keeper);
		await tx.run(`UPDATE ${queue} SET holder = ? WHERE home = ? AND holder <> ?`, holder, home, holder);
		await tx.run(`DELETE FROM ${wakes} WHERE home = ? AND at < ?`, home, Date.now() - BUDGET_EVENT_RETENTION_MS);
	};
	/** Until the take-over commits: rows from before are not this instance's, and a delete of one finds none. */
	let takingOver = false;
	const tookOver = (): void => {
		takingOver = false;
		ledger.releaseEarlier();
	};
	let recounting: Promise<void> | undefined;
	let recountAgain = false;
	/**
	 * Count again from what the store holds, in a read that never waits for a lock: after a write that failed, and once
	 * the queue drained. It never counts less than the store holds (see {@link CountedRows.recount}).
	 */
	const recountSoon = (): void => {
		if (closing) return;
		if (recounting !== undefined) {
			recountAgain = true;
			return;
		}
		// Not while the rows found at open are being summed: the recount would count them twice.
		recounting = summed
			.then(() =>
				ledger.recount(async () => {
					const found = new Map<string, FoundRow>();
					await readCounted((messageId, row) => found.set(messageId, row));
					return found;
				}),
			)
			.then(() => {
				if (!closing) finishCounting();
			})
			.catch(() => {
				// Counted as before; the next failure or drain counts again.
			})
			.finally(() => {
				recounting = undefined;
				if (recountAgain) {
					recountAgain = false;
					recountSoon();
				}
			});
	};
	const drained = (): void => {
		if (!counting && !ledger.holdsMessages()) recountSoon();
	};
	// A step that runs only while the database is idle and its lock free at once; a database that cannot say so runs it
	// as a transaction of its own, apart from the message writes.
	const maintain: (callback: (tx: SqliteExecutor) => Promise<void>) => Promise<boolean> =
		database.tryMaintenance?.bind(database) ??
		((callback) =>
			database.transaction(callback).then(
				() => true,
				() => false,
			));
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retrying: Promise<void> | undefined;
	let retryDelay = RETRY_DELETE_FIRST_MS;
	/**
	 * Try the deletes that failed again (and the take-over, if it failed), in one idle-only maintenance step: never
	 * through the message writes, never waiting for another process's lock. While any is left it is tried again, at
	 * most {@link RETRY_DELETE_MAX_MS} apart.
	 */
	const retrySoon = (): void => {
		if (closing || retryTimer !== undefined || retrying !== undefined) return;
		if (!takingOver && ledger.deleting().length === 0) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retrying = retryDeletes().finally(() => {
				retrying = undefined;
				retrySoon();
			});
		}, retryDelay);
		retryTimer.unref?.();
	};
	const retryDeletes = async (): Promise<void> => {
		if (closing) return;
		const takeOverToo = takingOver;
		const messageIds = ledger.deleting();
		const gone: string[] = [];
		let ran = false;
		try {
			ran = await maintain(async (tx) => {
				gone.length = 0;
				if (takeOverToo) await takeOver(tx);
				for (const messageId of messageIds) {
					// Queued again meanwhile (the same message): its row stays.
					if (ledger.get(messageId)?.state !== "deleting") continue;
					await deleteRow(tx, messageId);
					gone.push(messageId);
				}
			});
		} catch {
			ran = false;
		}
		if (!ran) {
			retryDelay = Math.min(retryDelay * 2, RETRY_DELETE_MAX_MS);
			return;
		}
		retryDelay = RETRY_DELETE_FIRST_MS;
		if (takeOverToo) tookOver();
		for (const messageId of gone) if (ledger.get(messageId)?.state === "deleting") ledger.release(messageId);
		drained();
		compactSoon();
	};
	// Counted in the background from here; one that fails is done again as a recount, row by row.
	const summed = sumRows().then(
		() => {
			if (!closing) finishCounting();
		},
		() => recountSoon(),
	);
	/** Rows of one departure that this instance holds. */
	const departureWhere = (departure: EndedQueueDepartureKey) =>
		departure.ownerHost === undefined
			? {
					sql: "home = ? AND holder = ? AND owner_host = '' AND owner_session_id = ? AND child_key = ?",
					params: [home, holder, departure.ownerSessionId, departure.childKey],
				}
			: {
					sql: "home = ? AND holder = ? AND owner_host = ? AND child_key = ?",
					params: [home, holder, departure.ownerHost, departure.childKey],
				};
	let closed: Promise<void> | undefined;
	return {
		id,
		async load(page) {
			// Once the rows found at open are summed: each row read here then moves from the sums to its own count.
			await summed;
			// Read without a write (never waiting for another process's write lock), a page at a time, then take the rows
			// over: the first of this broker's ordered writes, so every later one finds them this instance's. An earlier
			// instance of the same home is gone (its socket and start-up lock are this broker's), and a hung one is fenced out
			// of every later write by `holder`. Rows of an earlier keeper are dropped: their senders were told they were lost.
			const sizes = await database.transaction(
				(tx) =>
					tx.all<SqliteRow & { seq: number | bigint; bytes: number | bigint }>(
						`SELECT seq, bytes FROM ${queue} WHERE home = ? AND keeper = ? ORDER BY seq`,
						home,
						keeper,
					),
				{ readOnly: true },
			);
			const pages: Array<readonly [number, number]> = [];
			let first: number | undefined;
			let last = 0;
			let bytes = 0;
			for (const size of sizes) {
				const seq = Number(size.seq);
				if (first !== undefined && bytes + Number(size.bytes) > ENDED_QUEUE_LOAD_PAGE_BYTES) {
					pages.push([first, last]);
					first = undefined;
					bytes = 0;
				}
				first ??= seq;
				last = seq;
				bytes += Number(size.bytes);
			}
			if (first !== undefined) pages.push([first, last]);
			const rows: EndedQueueRow[] = [];
			for (const [from, to] of pages) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				const read = await database.transaction(
					(tx) =>
						tx.all<QueueRow>(
							`SELECT q.seq, q.message_id, q.owner_session_id, q.owner_host, q.child_key, q.child_json, q.sender_json,
								b.request_json, q.bytes, q.queued_at, q.wake_json, q.owner_away_since, q.failed_reason, q.failed_at,
								q.dispatched
							 FROM ${queue} q JOIN ${bodies} b ON b.message_id = q.message_id
							 WHERE q.home = ? AND q.keeper = ? AND q.seq >= ? AND q.seq <= ? ORDER BY q.seq`,
							home,
							keeper,
							from,
							to,
						),
					{ readOnly: true },
				);
				const parsed = read.map(rowOf);
				// Counted in the sums when the store opened; by id from now on, so its delete releases exactly it.
				for (const row of parsed) ledger.adopt(row.messageId, countedKey(row.ownerHost ?? "", row.ownerSessionId, row.childKey), row.bytes);
				rows.push(...parsed);
				page?.(parsed);
			}
			const budget = await database.transaction(
				(tx) => tx.all<BudgetRow>(`SELECT child_key, kind, at, depth FROM ${wakes} WHERE home = ? ORDER BY at`, home),
				{ readOnly: true },
			);
			// Should it fail, it is tried again with the deletes that failed: until then, the rows from before still count.
			takingOver = true;
			void writes.run(takeOver).then(tookOver, () => {
				recountSoon();
				retrySoon();
			});
			return {
				rows,
				budget: budget.map((event) => ({
					childKey: JSON.parse(event.child_key) as string,
					kind: event.kind === "awake" ? ("awake" as const) : ("wake" as const),
					at: Number(event.at),
					depth: Number(event.depth),
				})),
			};
		},
		async targets() {
			const children = await database.transaction(
				(tx) =>
					tx.all<SqliteRow & { child_key: string; child_json: string }>(
						`SELECT DISTINCT child_key, child_json FROM ${queue} WHERE home = ? AND keeper = ?`,
						home,
						keeper,
					),
				{ readOnly: true },
			);
			const targets = new Set<string>();
			for (const child of children) {
				targets.add(child.child_key);
				for (const alias of (JSON.parse(child.child_json) as EndedQueueChild).aliases) targets.add(alias.trim().toLowerCase());
			}
			return [...targets];
		},
		counted(departure) {
			const exact = ledger.counted(countedKeyOf(departure));
			if (!counting) return { ...exact, counting: false };
			// Until the rows found at open are counted, every subagent and the store count as full.
			return {
				child: Math.max(exact.child, ENDED_CHILD_QUEUE_BYTES_MAX),
				total: Math.max(exact.total, ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX),
				counting: true,
			};
		},
		whenCounted() {
			return countedAll;
		},
		add(entry, budget) {
			const messageId = entry.messageId;
			// Counted before its row is written. One counted already (a delete before this one may still be going) is held
			// as added again, so that delete does not release it.
			const before = ledger.get(messageId)?.state;
			const known = before !== undefined;
			if (known) ledger.mark(messageId, "reserved");
			else ledger.count(messageId, countedKeyOf(entry), entry.bytes, "reserved");
			const written = writes.run(async (tx) => {
				const { changes } = await tx.run(
					`INSERT INTO ${queue}(message_id, home, holder, keeper, owner_session_id, owner_host, child_key, child_json,
						sender_json, bytes, queued_at, wake_json)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
					entry.messageId,
					home,
					holder,
					keeper,
					entry.ownerSessionId,
					entry.ownerHost ?? "",
					entry.childKey,
					JSON.stringify(entry.child),
					entry.senderJson ?? JSON.stringify(entry.sender),
					entry.bytes,
					entry.queuedAt,
					entry.wake === undefined ? null : JSON.stringify(entry.wake),
				);
				if (changes !== 0)
					await tx.run(
						`INSERT INTO ${bodies}(message_id, request_json) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING`,
						entry.messageId,
						entry.requestJson ?? JSON.stringify(entry.request),
					);
				if (budget !== undefined)
					await tx.run(
						`INSERT INTO ${wakes}(home, child_key, kind, at, depth) VALUES (?, ?, ?, ?, ?)`,
						home,
						// Departure keys hold a NUL, which no database parameter may: kept as JSON text.
						JSON.stringify(budget.childKey),
						budget.kind,
						budget.at,
						budget.depth,
					);
				return changes === 0 ? "duplicate" : "added";
			});
			return written.then(
				(result) => {
					// Its row is there now; one an earlier add of the same message, refused, released counts again.
					if (ledger.get(messageId) === undefined) ledger.count(messageId, countedKeyOf(entry), entry.bytes, "stored");
					else ledger.mark(messageId, "stored");
					// Already kept, or counted from before: what the store holds says what counts.
					if (known || result === "duplicate") recountSoon();
					return result;
				},
				(error: unknown) => {
					// Rolled back: never written. One counted from before is as it was, its delete still to be tried again if
					// that had failed.
					if (before === undefined) ledger.release(messageId);
					else if (ledger.get(messageId)?.state === "reserved") ledger.mark(messageId, before);
					recountSoon();
					retrySoon();
					throw error;
				},
			);
		},
		remove(messageIds) {
			if (messageIds.length === 0) return Promise.resolve();
			return writes
				.run(async (tx) => {
					const deleted = new Set<string>();
					for (const messageId of messageIds) if (await deleteRow(tx, messageId)) deleted.add(messageId);
					return deleted;
				})
				.then(
					(deleted) => {
						let unexpected = false;
						for (const messageId of messageIds) {
							const counted = ledger.get(messageId);
							// Not counted by id: a row the store's sums counted when it opened, before `load` read it, is
							// released by counting again; one never written needs nothing.
							if (counted === undefined) {
								if (deleted.has(messageId)) unexpected = true;
								continue;
							}
							// Added again after this delete was asked for: that add says what counts.
							if (counted.state === "reserved") continue;
							if (deleted.has(messageId)) ledger.release(messageId);
							// A row from before this broker took the rows over: deleted once it has.
							else if (takingOver) ledger.mark(messageId, "deleting");
							else {
								ledger.release(messageId);
								unexpected = true;
							}
						}
						if (unexpected) recountSoon();
						retrySoon();
						drained();
						compactSoon();
					},
					(error: unknown) => {
						// The rows may still be there: they count until a delete tried again goes through.
						for (const messageId of messageIds)
							if (ledger.get(messageId) !== undefined && ledger.get(messageId)?.state !== "reserved")
								ledger.mark(messageId, "deleting");
						recountSoon();
						retrySoon();
						throw error;
					},
				);
		},
		dispatched(messageIds) {
			if (messageIds.length === 0) return Promise.resolve();
			return writes.run(async (tx) => {
				for (const messageId of messageIds)
					await tx.run(
						`UPDATE ${queue} SET dispatched = 1 WHERE message_id = ? AND home = ? AND holder = ?`,
						messageId,
						home,
						holder,
					);
			});
		},
		fail(messageId, reason, at) {
			return writes
				.run(async (tx) => {
					const row = await tx.get<SqliteRow & { sender_json: string; request_json: string | null }>(
						`SELECT q.sender_json, b.request_json FROM ${queue} q LEFT JOIN ${bodies} b ON b.message_id = q.message_id
						 WHERE q.message_id = ? AND q.home = ? AND q.holder = ?`,
						messageId,
						home,
						holder,
					);
					if (row === undefined) return undefined;
					// The failure keeps only what telling its sender needs: a failure for a sender that never comes back would
					// otherwise keep the whole message, counted, for good.
					const kept = failureForm(row.sender_json, row.request_json);
					if (kept === undefined) {
						await tx.run(
							`UPDATE ${queue} SET failed_reason = ?, failed_at = ? WHERE message_id = ? AND home = ? AND holder = ?`,
							reason,
							at,
							messageId,
							home,
							holder,
						);
						return undefined;
					}
					const bytes = Buffer.byteLength(kept.senderJson) + Buffer.byteLength(kept.requestJson);
					await tx.run(
						`UPDATE ${queue} SET failed_reason = ?, failed_at = ?, sender_json = ?, bytes = ?
						 WHERE message_id = ? AND home = ? AND holder = ?`,
						reason,
						at,
						kept.senderJson,
						bytes,
						messageId,
						home,
						holder,
					);
					await tx.run(`UPDATE ${bodies} SET request_json = ? WHERE message_id = ?`, kept.requestJson, messageId);
					return bytes;
				})
				.then(
					(bytes) => {
						if (bytes !== undefined && ledger.get(messageId)?.state === "stored") ledger.change(messageId, { bytes });
					},
					(error: unknown) => {
						recountSoon();
						throw error;
					},
				);
		},
		setWake(departure, wake) {
			const where = departureWhere(departure);
			return writes.run(async (tx) => {
				await tx.run(
					`UPDATE ${queue} SET wake_json = ? WHERE ${where.sql} AND failed_reason IS NULL`,
					wake === undefined ? null : JSON.stringify(wake),
					...where.params,
				);
			});
		},
		setOwnerAway(departures, since) {
			if (departures.length === 0) return Promise.resolve();
			return writes.run(async (tx) => {
				for (const departure of departures) {
					const where = departureWhere(departure);
					await tx.run(`UPDATE ${queue} SET owner_away_since = ? WHERE ${where.sql}`, since ?? null, ...where.params);
				}
			});
		},
		rekeyOwner(departure, ownerSessionId) {
			const where = departureWhere(departure);
			return writes
				.run(async (tx) => {
					await tx.run(`UPDATE ${queue} SET owner_session_id = ? WHERE ${where.sql}`, ownerSessionId, ...where.params);
				})
				.then(() => {
					// Rows of an owner with no host session count under its session id: they follow it.
					if (departure.ownerHost !== undefined) return;
					const to = countedKey("", ownerSessionId, departure.childKey);
					for (const messageId of ledger.under(countedKeyOf(departure))) ledger.change(messageId, { key: to });
				});
		},
		recordBudget(event) {
			return writes.run(async (tx) => {
				await tx.run(
					`INSERT INTO ${wakes}(home, child_key, kind, at, depth) VALUES (?, ?, ?, ?, ?)`,
					home,
					JSON.stringify(event.childKey),
					event.kind,
					event.at,
					event.depth,
				);
			});
		},
		close() {
			closed ??= (async () => {
				closing = true;
				clearTimeout(retryTimer);
				retryTimer = undefined;
				await summed;
				await retrying;
				await recounting;
				await compacting;
				await writes.idle();
				if (ownsDatabase) await database.close();
			})();
			return closed;
		},
	};
}

/**
 * #5999: the queue in the local file `path` (the Intercom directory's `ended-child-queue.sqlite`), owner-only, through
 * the storage layer's node:sqlite database: its transactions wait for another process's write lock on a timer, never
 * on the event loop, and a busy queue of writes commits together.
 */
export async function openLocalEndedChildQueueStore(
	path: string,
	holder: string,
	retire = false,
	continuity: {
		readonly servedSinceLastHolder?: (storeId: string) => boolean;
		readonly pid?: string;
	} = {},
): Promise<EndedChildQueueStore> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
	const database = await openNodeSqliteDatabase(path, {
		busyTimeoutMs: ENDED_QUEUE_LOCK_WAIT_MS,
		lockWaitMs: ENDED_QUEUE_LOCK_WAIT_MS,
	});
	try {
		if (process.platform !== "win32")
			for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
		return await openSqlEndedChildQueueStore(
			{ database, prefix: "" },
			{ home: "local", holder, ownsDatabase: true, retire, compact: true, ...continuity },
		);
	} catch (error) {
		await database.close().catch(() => {});
		throw error;
	}
}

/**
 * The marker a broker that kept the queue in memory leaves next to the store (`<store>.retired`, naming the home): it
 * told its sessions that what the store kept was lost, so the next broker that opens the store drops it, and takes a new
 * identity, rather than deliver a message its sender was told was lost.
 */
export function retiredMarkerPath(storePath: string): string {
	return `${storePath}.retired`;
}
