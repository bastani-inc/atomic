import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import type { AdvisoryLock } from "@bastani/atomic-natives";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import { openThreadedSqliteDatabase } from "./ship-shard-thread.js";

/** The root's own lock, held while its shard is open: one process at a time opens a root's local journal. */
async function tryRootLock(path: string): Promise<AdvisoryLock | null> {
	const { tryAdvisoryLock } = await import("@bastani/atomic-natives");
	return tryAdvisoryLock(`${path}.lock`, 0);
}

export function shipShardPath(stateDirectory: string, journalIdentity: string, root: string): string {
	const journal = createHash("sha256").update(journalIdentity).digest("hex").slice(0, 24);
	const file = createHash("sha256").update(root).digest("hex").slice(0, 32);
	return join(stateDirectory, "ship", journal, `${file}.sqlite`);
}

/**
 * What one row of an attempt's local journal records (#4768): a checkpoint, whose payload is the checkpoint's JSON, or a
 * write of one of the attempt's pooled stage sessions, whose payload is the whole pool mutation's JSON.
 */
export type ShipOp = "checkpoint" | "session-create" | "session-replace" | "session-append";

export interface ShipEvent {
	readonly localSeq: number;
	readonly work: string;
	readonly generation: number;
	readonly epoch: number;
	readonly key: string;
	readonly payload: string;
	readonly digest: string;
	readonly at: number;
	readonly op: ShipOp;
}

/**
 * A session write, as the local journal checks it before it accepts it: against the session's last sequence after
 * everything the attempt accepted before it, as the shared store checks it when the write is shipped.
 */
export interface ShipSessionWrite {
	readonly op: Exclude<ShipOp, "checkpoint">;
	readonly session: string;
	/** The replay key of the stage a create or replace binds the session to. */
	readonly replayKey?: string;
	/** The sequence a replace or append expects the session at. */
	readonly expectSeq?: number;
	/** How many entries the write carries. */
	readonly entries: number;
}

/** A session the attempt writes, as the local journal knows it: its last sequence and the stage it is bound to. */
export interface ShipSessionState {
	readonly lastSeq: number;
	readonly replayKey: string | null;
}

export interface ShipBatchRows {
	readonly id: string;
	readonly events: readonly ShipEvent[];
}

type ShipEventRow = SqliteRow & {
	local_seq: number;
	work: string;
	generation: number;
	epoch: number;
	event_key: string;
	payload: string;
	digest: string;
	at: number;
	op: string | null;
};

function shipEventOf(row: ShipEventRow): ShipEvent {
	return {
		localSeq: Number(row.local_seq),
		work: row.work,
		generation: Number(row.generation),
		epoch: Number(row.epoch),
		key: row.event_key,
		payload: row.payload,
		digest: row.digest,
		at: Number(row.at),
		op: (row.op ?? "checkpoint") as ShipOp,
	};
}

/**
 * A batch's content address. A batch of checkpoints alone keeps the address it had before sessions shipped too; a
 * session write adds its kind, so two batches that differ only in what their rows are never share an address.
 */
export function shipBatchId(
	root: string,
	lease: Pick<AttemptLease, "id" | "generation">,
	events: readonly (Pick<ShipEvent, "key" | "digest"> & { readonly op?: ShipOp })[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				root,
				lease.id,
				lease.generation,
				events.map((event) =>
					event.op === undefined || event.op === "checkpoint"
						? [event.key, event.digest]
						: [event.key, event.digest, event.op],
				),
			]),
		)
		.digest("hex");
}

/**
 * The most payload, in UTF-16 code units, one batch carries past its first row: a stage's session writes can be large,
 * and a batch goes to the shared store as one request. A single larger row still ships, alone.
 */
export const SHIP_BATCH_MAX_PAYLOAD = 4 * 1024 * 1024;

interface HeldLease {
	readonly lease: AttemptLease;
	readonly leaseMs: number;
	renewedAt: number;
}

export const SHIP_SHARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS ship_events(
	local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
	event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
	batch TEXT,
	UNIQUE(work, generation, event_key)
);
CREATE TABLE IF NOT EXISTS ship_rows(
	local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
	event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
	batch TEXT,
	op TEXT NOT NULL DEFAULT 'checkpoint', session TEXT, result_seq INTEGER,
	UNIQUE(work, generation, event_key)
);
CREATE TABLE IF NOT EXISTS ship_sessions(
	work TEXT NOT NULL, generation INTEGER NOT NULL, session TEXT NOT NULL, last_seq INTEGER NOT NULL,
	replay_key TEXT, PRIMARY KEY(work, generation, session)
);
CREATE TABLE IF NOT EXISTS ship_cursor(
	work TEXT NOT NULL, generation INTEGER NOT NULL, shipped_local_seq INTEGER NOT NULL, shipped_at INTEGER NOT NULL,
	fenced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(work, generation)
);
CREATE TABLE IF NOT EXISTS ship_lease(
	work TEXT PRIMARY KEY, generation INTEGER NOT NULL, worker TEXT NOT NULL, epoch INTEGER NOT NULL
);
`;

export function shipDigest(payload: string): string {
	return createHash("sha256").update(payload).digest("hex");
}

export class ShipIdentityConflictError extends Error {
	override readonly name = "ShipIdentityConflictError";
	constructor() {
		super("Pool checkpoint identity conflict");
	}
}

/**
 * A session write the local journal refuses as the shared store would: a create of a session that exists, a write at a
 * sequence the session is not at, or a replace that binds the session to another stage. Named as the session store
 * names its own refusals, so a worker's session tells them apart the same way.
 */
export class ShipSessionRefusal extends Error {
	readonly sessionId: string;
	readonly expectedSeq?: number;
	readonly actualSeq?: number;
	constructor(kind: "exists" | "conflict" | "scope", session: string, expectedSeq?: number, actualSeq?: number) {
		super(
			kind === "scope"
				? "Pool session scope mismatch"
				: kind === "exists"
					? `Session already exists: ${session}`
					: `Session conflict: ${session}, expected ${expectedSeq}, actual ${actualSeq}`,
		);
		this.name = kind === "exists" ? "SessionExistsError" : kind === "conflict" ? "SessionConflictError" : "Error";
		this.sessionId = session;
		if (kind === "conflict") {
			this.expectedSeq = expectedSeq;
			this.actualSeq = actualSeq;
		}
	}
}

/** The local journal holds nothing of the session yet: its state comes from the shared store first. */
export class ShipSessionUnknownError extends Error {
	override readonly name = "ShipSessionUnknownError";
	constructor(readonly session: string) {
		super(`The local journal holds no state of session ${session}`);
	}
}

export class ShipShard {
	private readonly leases = new Map<string, HeldLease>();
	private closed = false;

	private constructor(
		private readonly database: SqliteDatabase,
		readonly root: string,
		private readonly lock: AdvisoryLock | undefined,
		private readonly path: string,
		private readonly now: () => number = () => performance.now(),
	) {}

	static open(path: string, root: string, now?: () => number): Promise<ShipShard> {
		return underJournalLock(path, () => ShipShard.openUnlocked(path, root, now));
	}

	private static async openUnlocked(path: string, root: string, now?: () => number): Promise<ShipShard> {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const lock = path === ":memory:" ? undefined : await tryRootLock(path);
		if (lock === null) throw new Error(`Checkpoint shard is already open by another process: ${path}`);
		let database: SqliteDatabase | undefined;
		try {
			database = path === ":memory:" ? await openNodeSqliteDatabase(path) : await openThreadedSqliteDatabase(path);
			await database.exec(SHIP_SHARD_SCHEMA);

			const columns = new Set(
				(await database.all<SqliteRow & { name: string }>(`SELECT name FROM pragma_table_info('ship_events')`)).map(
					(row) => String(row.name),
				),
			);
			await database.transaction(async (tx) => {
				await tx.run(
					`INSERT INTO ship_rows(work, generation, epoch, event_key, payload, digest, at, batch, op, session, result_seq)
					SELECT work, generation, epoch, event_key, payload, digest, at, batch,
						${columns.has("op") ? "op" : "'checkpoint'"},
						${columns.has("session") ? "session" : "NULL"},
						${columns.has("result_seq") ? "result_seq" : "NULL"}
					FROM ship_events ORDER BY local_seq`,
				);
				await tx.run(`DELETE FROM ship_events`);
			});
			await database.run(
				`DELETE FROM ship_rows WHERE NOT EXISTS (SELECT 1 FROM ship_lease l WHERE l.work = ship_rows.work AND l.generation = ship_rows.generation)`,
			);
			await database.run(
				`DELETE FROM ship_sessions WHERE NOT EXISTS (SELECT 1 FROM ship_lease l WHERE l.work = ship_sessions.work AND l.generation = ship_sessions.generation)`,
			);
			return new ShipShard(database, root, lock, path, now);
		} catch (error) {
			try {
				await database?.close();
			} finally {
				lock?.release();
			}
			throw error;
		}
	}

	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		const held = this.leases.get(lease.id);
		if (held !== undefined && lease.generation < held.lease.generation) return;
		if (
			held !== undefined &&
			held.lease.generation === lease.generation &&
			held.lease.worker === lease.worker &&
			held.lease.epoch === lease.epoch
		) {
			held.renewedAt = this.now();
			return;
		}
		this.leases.set(lease.id, { lease: { ...lease }, leaseMs, renewedAt: this.now() });
		await this.database.transaction(async (tx) => {
			const current = this.leases.get(lease.id);
			if (current !== undefined && lease.generation < current.lease.generation) return;
			const stored = await tx.get<SqliteRow & { generation: number }>(
				`SELECT generation FROM ship_lease WHERE work = ?`,
				lease.id,
			);
			if (stored !== undefined && lease.generation < Number(stored.generation)) return;
			await tx.run(`DELETE FROM ship_rows WHERE work = ? AND generation < ?`, lease.id, lease.generation);
			await tx.run(`DELETE FROM ship_sessions WHERE work = ? AND generation < ?`, lease.id, lease.generation);
			await tx.run(`DELETE FROM ship_cursor WHERE work = ? AND generation < ?`, lease.id, lease.generation);
			await tx.run(
				`UPDATE ship_cursor SET fenced = 0 WHERE work = ? AND generation = ? AND fenced <> 0`,
				lease.id,
				lease.generation,
			);
			await tx.run(
				`INSERT INTO ship_lease(work, generation, worker, epoch) VALUES (?, ?, ?, ?)
				ON CONFLICT(work) DO UPDATE SET generation = excluded.generation, worker = excluded.worker, epoch = excluded.epoch
				WHERE excluded.generation >= ship_lease.generation`,
				lease.id,
				lease.generation,
				lease.worker,
				lease.epoch,
			);
		});
	}

	release(work: Pick<AttemptLease, "id" | "generation"> & Partial<Pick<AttemptLease, "worker">>): void {
		const held = this.leases.get(work.id);
		if (
			held?.lease.generation === work.generation &&
			(work.worker === undefined || held.lease.worker === work.worker)
		) {
			this.leases.delete(work.id);
		}
	}

	async accept(
		root: string,
		lease: AttemptLease,
		key: string,
		payload: string,
		at: number,
		session?: ShipSessionWrite,
	): Promise<{ readonly localSeq: number; readonly accepted: boolean; readonly lastSeq?: number }> {
		this.assertHeld(root, lease);
		const digest = shipDigest(payload);
		return this.database.transaction(async (tx) => {
			this.assertHeld(root, lease);
			await this.assertStoredLease(tx, root, lease);
			const existing = await tx.get<SqliteRow & { local_seq: number; digest: string; result_seq: number | null }>(
				`SELECT local_seq, digest, result_seq FROM ship_rows WHERE work = ? AND generation = ? AND event_key = ?`,
				lease.id,
				lease.generation,
				key,
			);
			if (existing !== undefined) {
				this.assertHeld(root, lease);
				if (existing.digest !== digest) throw new ShipIdentityConflictError();
				return {
					localSeq: Number(existing.local_seq),
					accepted: false,
					...(existing.result_seq === null || existing.result_seq === undefined
						? {}
						: { lastSeq: Number(existing.result_seq) }),
				};
			}
			const lastSeq = session === undefined ? undefined : await this.writeSession(tx, lease, session);
			const inserted = await tx.get<SqliteRow & { local_seq: number }>(
				`INSERT INTO ship_rows(work, generation, epoch, event_key, payload, digest, at, op, session, result_seq)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING local_seq`,
				lease.id,
				lease.generation,
				lease.epoch,
				key,
				payload,
				digest,
				at,
				session?.op ?? "checkpoint",
				session?.session ?? null,
				lastSeq ?? null,
			);
			this.assertHeld(root, lease);
			return {
				localSeq: Number(inserted!.local_seq),
				accepted: true,
				...(lastSeq === undefined ? {} : { lastSeq }),
			};
		});
	}

	/**
	 * Checks `write` against the session's state after everything the attempt accepted before it, as the shared store
	 * checks it when the write ships, and moves that state past it. Returns the session's last sequence after it.
	 */
	private async writeSession(
		tx: Pick<SqliteDatabase, "get" | "run">,
		lease: AttemptLease,
		write: ShipSessionWrite,
	): Promise<number> {
		const state = await tx.get<SqliteRow & { last_seq: number; replay_key: string | null }>(
			`SELECT last_seq, replay_key FROM ship_sessions WHERE work = ? AND generation = ? AND session = ?`,
			lease.id,
			lease.generation,
			write.session,
		);
		let lastSeq: number;
		let replayKey = state?.replay_key ?? null;
		if (write.op === "session-create") {
			if (state !== undefined) throw new ShipSessionRefusal("exists", write.session);
			lastSeq = write.entries;
			replayKey = write.replayKey ?? null;
		} else {
			if (state === undefined) throw new ShipSessionUnknownError(write.session);
			if (write.op === "session-replace" && replayKey !== null && write.replayKey !== replayKey)
				throw new ShipSessionRefusal("scope", write.session);
			const actual = Number(state.last_seq);
			if (write.expectSeq !== actual)
				throw new ShipSessionRefusal("conflict", write.session, write.expectSeq, actual);
			lastSeq = write.op === "session-append" ? actual + write.entries : write.entries;
		}
		await tx.run(
			`INSERT INTO ship_sessions(work, generation, session, last_seq, replay_key) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(work, generation, session) DO UPDATE SET last_seq = excluded.last_seq, replay_key = excluded.replay_key`,
			lease.id,
			lease.generation,
			write.session,
			lastSeq,
			replayKey,
		);
		return lastSeq;
	}

	/** The session's state as the attempt's writes left it, or undefined when the attempt wrote nothing of it yet. */
	async session(
		lease: Pick<AttemptLease, "id" | "generation">,
		session: string,
	): Promise<ShipSessionState | undefined> {
		const row = await this.database.get<SqliteRow & { last_seq: number; replay_key: string | null }>(
			`SELECT last_seq, replay_key FROM ship_sessions WHERE work = ? AND generation = ? AND session = ?`,
			lease.id,
			lease.generation,
			session,
		);
		return row === undefined ? undefined : { lastSeq: Number(row.last_seq), replayKey: row.replay_key ?? null };
	}

	/**
	 * Takes up a session the attempt writes for the first time though the shared store already holds it, a session an
	 * earlier attempt of the work wrote, at the state the shared store holds it in. A state the attempt's own writes left
	 * already stays.
	 */
	async seedSession(
		lease: Pick<AttemptLease, "id" | "generation">,
		session: string,
		state: ShipSessionState,
	): Promise<void> {
		await this.database.run(
			`INSERT INTO ship_sessions(work, generation, session, last_seq, replay_key) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(work, generation, session) DO NOTHING`,
			lease.id,
			lease.generation,
			session,
			state.lastSeq,
			state.replayKey,
		);
	}

	/** Whether a write of `session` the attempt accepted is not shipped yet; any session's, without one. */
	async holdsSession(lease: Pick<AttemptLease, "id" | "generation">, session?: string): Promise<boolean> {
		const row = await this.database.get(
			session === undefined
				? `SELECT 1 AS held FROM ship_rows WHERE work = ? AND generation = ? AND op <> 'checkpoint' LIMIT 1`
				: `SELECT 1 AS held FROM ship_rows WHERE work = ? AND generation = ? AND session = ? LIMIT 1`,
			...(session === undefined ? [lease.id, lease.generation] : [lease.id, lease.generation, session]),
		);
		return row !== undefined;
	}

	/** Forgets the session states of an attempt that holds nothing left to ship. */
	async forgetSessions(lease: Pick<AttemptLease, "id" | "generation">): Promise<void> {
		await this.database.run(
			`DELETE FROM ship_sessions WHERE work = ? AND generation = ?
			AND NOT EXISTS (SELECT 1 FROM ship_rows e WHERE e.work = ship_sessions.work AND e.generation = ship_sessions.generation)`,
			lease.id,
			lease.generation,
		);
	}

	pending(lease: Pick<AttemptLease, "id" | "generation">, limit = 1_000): Promise<ShipEvent[]> {
		return this.rows(
			this.database,
			`WHERE work = ? AND generation = ? ORDER BY local_seq LIMIT ?`,
			lease.id,
			lease.generation,
			limit,
		);
	}

	async pendingSeqs(lease: Pick<AttemptLease, "id" | "generation">): Promise<number[]> {
		const rows = await this.database.all<SqliteRow & { local_seq: number }>(
			`SELECT local_seq FROM ship_rows WHERE work = ? AND generation = ? ORDER BY local_seq`,
			lease.id,
			lease.generation,
		);
		return rows.map((row) => Number(row.local_seq));
	}

	async seal(lease: Pick<AttemptLease, "id" | "generation">, maxBatch: number): Promise<ShipBatchRows | undefined> {
		return this.database.transaction(async (tx) => {
			const sealed = await tx.get<SqliteRow & { batch: string }>(
				`SELECT batch FROM ship_rows WHERE work = ? AND generation = ? AND batch IS NOT NULL ORDER BY local_seq LIMIT 1`,
				lease.id,
				lease.generation,
			);
			if (sealed !== undefined) {
				const events = await this.rows(tx, `WHERE batch = ? ORDER BY local_seq`, sealed.batch);
				return { id: sealed.batch, events };
			}
			const selected = await this.rows(
				tx,
				`WHERE work = ? AND generation = ? ORDER BY local_seq LIMIT ?`,
				lease.id,
				lease.generation,
				maxBatch,
			);
			if (selected.length === 0) return undefined;
			// A batch goes as one request: past its first row, it takes rows only while their payloads fit the bound.
			const events: ShipEvent[] = [];
			let size = 0;
			for (const event of selected) {
				size += event.payload.length;
				if (events.length > 0 && size > SHIP_BATCH_MAX_PAYLOAD) break;
				events.push(event);
			}
			const id = shipBatchId(this.root, lease, events);
			await tx.run(
				`UPDATE ship_rows SET batch = ? WHERE work = ? AND generation = ? AND local_seq BETWEEN ? AND ?`,
				id,
				lease.id,
				lease.generation,
				events[0]!.localSeq,
				events.at(-1)!.localSeq,
			);
			return { id, events };
		});
	}

	async pendingCount(lease: Pick<AttemptLease, "id" | "generation">): Promise<number> {
		const row = await this.database.get<SqliteRow & { n: number }>(
			`SELECT COUNT(*) AS n FROM ship_rows WHERE work = ? AND generation = ?`,
			lease.id,
			lease.generation,
		);
		return Number(row?.n ?? 0);
	}

	/**
	 * The attempts with checkpoints left to ship, with the work lease each was accepted under, as a host that stopped
	 * left them: what it ships, or drops as fenced, when it starts again (#4768).
	 */
	async leftover(): Promise<{ readonly lease: AttemptLease }[]> {
		const rows = await this.database.all<
			SqliteRow & { work: string; generation: number; worker: string; epoch: number }
		>(
			`SELECT l.work, l.generation, l.worker, l.epoch
			FROM ship_lease l WHERE EXISTS (SELECT 1 FROM ship_rows e WHERE e.work = l.work AND e.generation = l.generation)`,
		);
		return rows.map((row) => ({
			lease: { id: row.work, generation: Number(row.generation), worker: row.worker, epoch: Number(row.epoch) },
		}));
	}

	private async rows(
		executor: Pick<SqliteDatabase, "all">,
		where: string,
		...params: (string | number)[]
	): Promise<ShipEvent[]> {
		const rows = await executor.all<ShipEventRow>(
			`SELECT local_seq, work, generation, epoch, event_key, payload, digest, at, op FROM ship_rows ${where}`,
			...params,
		);
		return rows.map(shipEventOf);
	}

	async shipped(lease: Pick<AttemptLease, "id" | "generation">, localSeq: number, at = Date.now()): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx.run(
				`DELETE FROM ship_rows WHERE work = ? AND generation = ? AND (local_seq = ? OR (batch IS NOT NULL AND local_seq <= ?))`,
				lease.id,
				lease.generation,
				localSeq,
				localSeq,
			);
			await tx.run(
				`INSERT INTO ship_cursor(work, generation, shipped_local_seq, shipped_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(work, generation) DO UPDATE SET
					shipped_local_seq = MAX(ship_cursor.shipped_local_seq, excluded.shipped_local_seq),
					shipped_at = excluded.shipped_at`,
				lease.id,
				lease.generation,
				localSeq,
				at,
			);
		});
	}

	async discard(lease: Pick<AttemptLease, "id" | "generation">, localSeq: number): Promise<void> {
		await this.database.run(
			`DELETE FROM ship_rows WHERE work = ? AND generation = ? AND local_seq = ?`,
			lease.id,
			lease.generation,
			localSeq,
		);
	}

	async fence(lease: Pick<AttemptLease, "id" | "generation">, at = Date.now()): Promise<void> {
		if (this.leases.get(lease.id)?.lease.generation === lease.generation) this.leases.delete(lease.id);
		await this.database.transaction(async (tx) => {
			await tx.run(`DELETE FROM ship_rows WHERE work = ? AND generation = ?`, lease.id, lease.generation);
			await tx.run(`DELETE FROM ship_sessions WHERE work = ? AND generation = ?`, lease.id, lease.generation);
			const stored = await tx.get<SqliteRow & { generation: number }>(
				`SELECT generation FROM ship_lease WHERE work = ?`,
				lease.id,
			);
			if (stored !== undefined && lease.generation < Number(stored.generation)) return;
			await tx.run(
				`INSERT INTO ship_cursor(work, generation, shipped_local_seq, shipped_at, fenced) VALUES (?, ?, 0, ?, 1)
				ON CONFLICT(work, generation) DO UPDATE SET fenced = 1, shipped_at = excluded.shipped_at`,
				lease.id,
				lease.generation,
				at,
			);
		});
	}

	async close(options: { readonly retire?: boolean } = {}): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.leases.clear();
		try {
			if (options.retire === true && this.path !== ":memory:")
				await underJournalLock(this.path, () => this.retire());
		} finally {
			try {
				await this.database.close();
			} finally {
				this.lock?.release();
			}
		}
	}

	private async retire(): Promise<void> {
		const unused = (await this.onlyConnection()) && (await this.holdsNothing());
		const location = unused ? await realpath(this.path).catch(() => undefined) : undefined;
		await this.database.close();
		if (location === undefined) return;
		this.lock?.release();
		await removeShardFiles(location, this.path);
	}

	private async onlyConnection(): Promise<boolean> {
		try {
			await this.database.exec("PRAGMA busy_timeout=0");
			const mode = await this.database.get<SqliteRow & { journal_mode: string }>("PRAGMA journal_mode=DELETE");
			return mode?.journal_mode === "delete";
		} catch {
			return false;
		}
	}

	private async holdsNothing(): Promise<boolean> {
		try {
			return (await this.database.get(`SELECT 1 AS present FROM ship_rows LIMIT 1`)) === undefined;
		} catch {
			return false;
		}
	}

	private staleError(
		root: string,
		lease: AttemptLease,
		reason: "missing" | "generation-mismatch" | "worker-mismatch" | "epoch-mismatch" | "expired",
	): StaleWorkLeaseError {
		return new StaleWorkLeaseError({ root, workId: lease.id, generation: lease.generation, reason });
	}

	private assertHeld(root: string, lease: AttemptLease): void {
		const held = this.leases.get(lease.id);
		if (held === undefined) throw this.staleError(root, lease, "missing");
		if (held.lease.generation !== lease.generation) throw this.staleError(root, lease, "generation-mismatch");
		if (held.lease.worker !== lease.worker) throw this.staleError(root, lease, "worker-mismatch");
		if (held.lease.epoch !== lease.epoch) throw this.staleError(root, lease, "epoch-mismatch");
		if (this.now() - held.renewedAt >= held.leaseMs) throw this.staleError(root, lease, "expired");
	}

	private async assertStoredLease(tx: Pick<SqliteDatabase, "get">, root: string, lease: AttemptLease): Promise<void> {
		const stored = await tx.get<SqliteRow & { generation: number; worker: string; epoch: number }>(
			`SELECT generation, worker, epoch FROM ship_lease WHERE work = ?`,
			lease.id,
		);
		if (stored === undefined) throw this.staleError(root, lease, "missing");
		if (Number(stored.generation) !== lease.generation) throw this.staleError(root, lease, "generation-mismatch");
		if (stored.worker !== lease.worker) throw this.staleError(root, lease, "worker-mismatch");
		if (Number(stored.epoch) !== lease.epoch) throw this.staleError(root, lease, "epoch-mismatch");
		const cursor = await tx.get<SqliteRow & { fenced: number }>(
			`SELECT fenced FROM ship_cursor WHERE work = ? AND generation = ?`,
			lease.id,
			lease.generation,
		);
		if (cursor !== undefined && Number(cursor.fenced) !== 0) {
			if (this.leases.get(lease.id)?.lease.generation === lease.generation) {
				this.leases.delete(lease.id);
			}
			throw this.staleError(root, lease, "missing");
		}
	}
}

async function underJournalLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	if (path === ":memory:") return operation();
	const lock = await openNodeSqliteDatabase(`${dirname(path)}.lock`);
	try {
		return await lock.transaction(() => operation());
	} finally {
		await lock.close();
	}
}

async function removeShardFiles(location: string, path: string): Promise<void> {
	for (const suffix of ["", "-journal", "-wal", "-shm"])
		await rm(`${location}${suffix}`, { force: true }).catch(() => {});
	for (const suffix of ["-holders", "-writers", "-wakes"])
		await rm(`${location}${suffix}`, { recursive: true, force: true }).catch(() => {});
	for (const lock of new Set([`${location}.lock`, `${path}.lock`])) await rm(lock, { force: true }).catch(() => {});
	await rmdir(dirname(location)).catch(() => {});
}
