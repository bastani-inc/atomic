import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readlink, realpath, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import type { AdvisoryLock } from "@bastani/atomic-natives";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";

/** The root's own lock, held while its shard is open: one process at a time opens a root's local journal. */
async function tryRootLock(path: string): Promise<AdvisoryLock | null> {
	const { tryAdvisoryLock } = await import("@bastani/atomic-natives");
	return tryAdvisoryLock(`${path}.lock`, 0);
}

async function tryOpenLock(location: string): Promise<AdvisoryLock | null> {
	const { tryAdvisoryLock } = await import("@bastani/atomic-natives");
	return tryAdvisoryLock(`${location}-open.lock`, 0);
}

export function shipJournalDirectory(stateDirectory: string, journalIdentity: string): string {
	return join(stateDirectory, "ship", createHash("sha256").update(journalIdentity).digest("hex").slice(0, 24));
}

export function shipShardPath(stateDirectory: string, journalIdentity: string, root: string): string {
	const file = createHash("sha256").update(root).digest("hex").slice(0, 32);
	return join(shipJournalDirectory(stateDirectory, journalIdentity), `${file}.sqlite`);
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
CREATE TABLE IF NOT EXISTS ship_root(root TEXT PRIMARY KEY, opens INTEGER NOT NULL);
`;

const GENERATION_UNIQUE_RE = /UNIQUE\s*\(\s*work\s*,\s*generation\s*,\s*event_key\s*\)/i;

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
		if (path === ":memory:") return ShipShard.openUnlocked(path, root, now);
		return underJournalLock(dirname(path), () => ShipShard.openUnlocked(path, root, now));
	}

	private static async openUnlocked(path: string, root: string, now?: () => number): Promise<ShipShard> {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const lock = path === ":memory:" ? undefined : await tryRootLock(path);
		if (lock === null) throw new Error(`Checkpoint shard is already open by another process: ${path}`);
		let database: SqliteDatabase | undefined;
		try {
			database = await openNodeSqliteDatabase(path);
			await database.exec(SHIP_SHARD_SCHEMA);
			const table = await database.get<SqliteRow & { sql: string | null }>(
				`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ship_events'`,
			);
			if (table?.sql !== null && table?.sql !== undefined && !GENERATION_UNIQUE_RE.test(table.sql)) {
				await database.transaction(async (tx) => {
					await tx.run(`ALTER TABLE ship_events RENAME TO ship_events_legacy`);
					await tx.run(
						`CREATE TABLE ship_events(
							local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
							work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
							event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
							batch TEXT,
							op TEXT NOT NULL DEFAULT 'checkpoint', session TEXT, result_seq INTEGER,
							UNIQUE(work, generation, event_key)
						)`,
					);
					await tx.run(
						`INSERT INTO ship_events(local_seq, work, generation, epoch, event_key, payload, digest, at, batch)
						SELECT local_seq, work, generation, epoch, event_key, payload, digest, at, batch FROM ship_events_legacy`,
					);
					await tx.run(`DROP TABLE ship_events_legacy`);
				});
			}
			// A journal an earlier build wrote holds checkpoints only: each row it left is one, as the column's default says.
			const columns = new Set(
				(await database.all<SqliteRow & { name: string }>(`SELECT name FROM pragma_table_info('ship_events')`)).map(
					(row) => String(row.name),
				),
			);
			for (const [column, type] of [
				["op", "TEXT NOT NULL DEFAULT 'checkpoint'"],
				["session", "TEXT"],
				["result_seq", "INTEGER"],
			] as const)
				if (!columns.has(column)) await database.exec(`ALTER TABLE ship_events ADD COLUMN ${column} ${type}`);
			await database.run(
				`DELETE FROM ship_events WHERE NOT EXISTS (SELECT 1 FROM ship_lease l WHERE l.work = ship_events.work AND l.generation = ship_events.generation)`,
			);
			await database.run(
				`DELETE FROM ship_sessions WHERE NOT EXISTS (SELECT 1 FROM ship_lease l WHERE l.work = ship_sessions.work AND l.generation = ship_sessions.generation)`,
			);
			await database.run(
				`INSERT INTO ship_root(root, opens) VALUES (?, 1) ON CONFLICT(root) DO UPDATE SET opens = ship_root.opens + 1`,
				root,
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
			await tx.run(`DELETE FROM ship_events WHERE work = ? AND generation < ?`, lease.id, lease.generation);
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
				`SELECT local_seq, digest, result_seq FROM ship_events WHERE work = ? AND generation = ? AND event_key = ?`,
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
				`INSERT INTO ship_events(work, generation, epoch, event_key, payload, digest, at, op, session, result_seq)
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
				? `SELECT 1 AS held FROM ship_events WHERE work = ? AND generation = ? AND op <> 'checkpoint' LIMIT 1`
				: `SELECT 1 AS held FROM ship_events WHERE work = ? AND generation = ? AND session = ? LIMIT 1`,
			...(session === undefined ? [lease.id, lease.generation] : [lease.id, lease.generation, session]),
		);
		return row !== undefined;
	}

	/** Forgets the session states of an attempt that holds nothing left to ship. */
	async forgetSessions(lease: Pick<AttemptLease, "id" | "generation">): Promise<void> {
		await this.database.run(
			`DELETE FROM ship_sessions WHERE work = ? AND generation = ?
			AND NOT EXISTS (SELECT 1 FROM ship_events e WHERE e.work = ship_sessions.work AND e.generation = ship_sessions.generation)`,
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
			`SELECT local_seq FROM ship_events WHERE work = ? AND generation = ? ORDER BY local_seq`,
			lease.id,
			lease.generation,
		);
		return rows.map((row) => Number(row.local_seq));
	}

	async seal(lease: Pick<AttemptLease, "id" | "generation">, maxBatch: number): Promise<ShipBatchRows | undefined> {
		return this.database.transaction(async (tx) => {
			const sealed = await tx.get<SqliteRow & { batch: string }>(
				`SELECT batch FROM ship_events WHERE work = ? AND generation = ? AND batch IS NOT NULL ORDER BY local_seq LIMIT 1`,
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
				`UPDATE ship_events SET batch = ? WHERE work = ? AND generation = ? AND local_seq BETWEEN ? AND ?`,
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
			`SELECT COUNT(*) AS n FROM ship_events WHERE work = ? AND generation = ?`,
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
			FROM ship_lease l WHERE EXISTS (SELECT 1 FROM ship_events e WHERE e.work = l.work AND e.generation = l.generation)`,
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
			`SELECT local_seq, work, generation, epoch, event_key, payload, digest, at, op FROM ship_events ${where}`,
			...params,
		);
		return rows.map(shipEventOf);
	}

	async shipped(lease: Pick<AttemptLease, "id" | "generation">, localSeq: number, at = Date.now()): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx.run(
				`DELETE FROM ship_events WHERE work = ? AND generation = ? AND (local_seq = ? OR (batch IS NOT NULL AND local_seq <= ?))`,
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
			`DELETE FROM ship_events WHERE work = ? AND generation = ? AND local_seq = ?`,
			lease.id,
			lease.generation,
			localSeq,
		);
	}

	async fence(lease: Pick<AttemptLease, "id" | "generation">, at = Date.now()): Promise<void> {
		if (this.leases.get(lease.id)?.lease.generation === lease.generation) this.leases.delete(lease.id);
		await this.database.transaction(async (tx) => {
			await tx.run(`DELETE FROM ship_events WHERE work = ? AND generation = ?`, lease.id, lease.generation);
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
				await underJournalLock(dirname(this.path), () => this.retire());
		} finally {
			try {
				await this.database.close();
			} finally {
				this.lock?.release();
			}
		}
	}

	private async retire(): Promise<void> {
		if (!(await holdsNothing(this.database))) return;
		await this.database.close();
		await removeConfirmedShard(this.path, this.lock, holdsNothingSync);
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

async function holdsNothing(database: SqliteDatabase): Promise<boolean> {
	try {
		return (await database.get(`SELECT 1 AS present FROM ship_events LIMIT 1`)) === undefined;
	} catch {
		return false;
	}
}

function holdsNothingSync(connection: DatabaseSync): boolean {
	try {
		return connection.prepare(`SELECT 1 AS present FROM ship_events LIMIT 1`).get() === undefined;
	} catch {
		return false;
	}
}

function onlyConnectionSync(connection: DatabaseSync): boolean {
	try {
		connection.exec("PRAGMA busy_timeout=0");
		const mode = connection.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode?: string } | undefined;
		return mode?.journal_mode === "delete";
	} catch {
		return false;
	}
}

async function underJournalLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
	const lock = await openNodeSqliteDatabase(`${directory}.lock`);
	try {
		return await lock.transaction(() => operation());
	} finally {
		await lock.close();
	}
}

export interface EndedShipRoots {
	readonly roots: ReadonlySet<string>;
	readonly works: ReadonlySet<string>;
}

export type FindEndedShipRoots = (roots: readonly string[], works: readonly string[]) => Promise<EndedShipRoots>;

interface ShardOwner {
	readonly root: string | undefined;
	readonly opens: number;
	readonly work: string | undefined;
}

interface IdleShard extends ShardOwner {
	readonly path: string;
	readonly file: string;
}

async function fileIdentity(path: string): Promise<string> {
	const stats = await stat(path, { bigint: true });
	return `${stats.ino}:${stats.birthtimeNs}`;
}

async function shardOwner(database: SqliteDatabase): Promise<ShardOwner> {
	const tables = new Set(
		(await database.all<SqliteRow & { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(
			(row) => row.name,
		),
	);
	const owner = tables.has("ship_root")
		? await database.get<SqliteRow & { root: string; opens: number }>(`SELECT root, opens FROM ship_root LIMIT 1`)
		: undefined;
	if (owner !== undefined) return { root: owner.root, opens: Number(owner.opens), work: undefined };
	const held = ["ship_lease", "ship_events"].filter((table) => tables.has(table));
	const attempt =
		held.length === 0
			? undefined
			: await database.get<SqliteRow & { work: string }>(
					`${held.map((table) => `SELECT work FROM ${table}`).join(" UNION ALL ")} LIMIT 1`,
				);
	return { root: undefined, opens: 0, work: attempt?.work };
}

function shardOwnerSync(connection: DatabaseSync): ShardOwner {
	const tables = new Set(
		(connection.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
			(row) => row.name,
		),
	);
	const owner = tables.has("ship_root")
		? (connection.prepare(`SELECT root, opens FROM ship_root LIMIT 1`).get() as
				| { root: string; opens: number }
				| undefined)
		: undefined;
	if (owner !== undefined) return { root: owner.root, opens: Number(owner.opens), work: undefined };
	const held = ["ship_lease", "ship_events"].filter((table) => tables.has(table));
	const attempt =
		held.length === 0
			? undefined
			: (connection
					.prepare(`${held.map((table) => `SELECT work FROM ${table}`).join(" UNION ALL ")} LIMIT 1`)
					.get() as { work: string } | undefined);
	return { root: undefined, opens: 0, work: attempt?.work };
}

function sameOwner(a: ShardOwner, b: ShardOwner): boolean {
	return a.root === b.root && a.opens === b.opens && a.work === b.work;
}

const PROC_SCAN_CONCURRENCY = 8;
const PROC_FD_BATCH_SIZE = 32;
const OPEN_FILE_SCAN_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

async function scanProcFdDir(fdDir: string, targets: ReadonlySet<string>, found: Set<string>): Promise<void> {
	const fds = await readdir(fdDir).catch(() => []);
	for (let offset = 0; offset < fds.length && found.size < targets.size; offset += PROC_FD_BATCH_SIZE) {
		await Promise.all(
			fds.slice(offset, offset + PROC_FD_BATCH_SIZE).map(async (fd) => {
				const link = await readlink(`${fdDir}/${fd}`).catch(() => undefined);
				if (link !== undefined && targets.has(link)) found.add(link);
			}),
		);
	}
}

async function selfHasOpenFile(location: string): Promise<boolean> {
	if (process.platform !== "linux") return false;
	const targets = new Set([location, `${location}-wal`, `${location}-shm`]);
	const found = new Set<string>();
	await scanProcFdDir("/proc/self/fd", targets, found);
	return found.size > 0;
}

async function otherProcessesOpenFiles(locations: readonly string[]): Promise<ReadonlySet<string>> {
	if (locations.length === 0) return new Set();
	const byTarget = new Map<string, string>();
	for (const location of locations) {
		for (const suffix of ["", "-wal", "-shm"]) byTarget.set(`${location}${suffix}`, location);
	}
	const targets = new Set(byTarget.keys());
	const matchedTargets = new Set<string>();
	if (process.platform === "linux") {
		const selfPid = String(process.pid);
		const entries = await readdir("/proc").catch(() => undefined);
		if (entries === undefined) return new Set(locations);
		const pids = entries.filter((entry) => entry !== selfPid && /^\d+$/.test(entry));
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(PROC_SCAN_CONCURRENCY, pids.length) }, async () => {
				while (matchedTargets.size < targets.size) {
					const pid = pids[next++];
					if (pid === undefined) return;
					await scanProcFdDir(`/proc/${pid}/fd`, targets, matchedTargets);
				}
			}),
		);
	} else if (process.platform === "darwin") {
		let output: string;
		try {
			({ stdout: output } = await execFileAsync("lsof", ["-F", "n", "--", ...targets], {
				encoding: "utf8",
				timeout: OPEN_FILE_SCAN_TIMEOUT_MS,
			}));
		} catch (error) {
			const failure = error as { code?: string | number; stdout?: string };
			if (failure.code !== 1 || typeof failure.stdout !== "string") return new Set(locations);
			output = failure.stdout;
		}
		for (const line of output.split("\n")) {
			if (line.startsWith("n") && targets.has(line.slice(1))) matchedTargets.add(line.slice(1));
		}
	}
	const openLocations = new Set<string>();
	for (const target of matchedTargets) {
		const owner = byTarget.get(target);
		if (owner !== undefined) openLocations.add(owner);
	}
	return openLocations;
}

async function inspectShard(path: string): Promise<IdleShard> {
	const file = await fileIdentity(path);
	const database = await openNodeSqliteDatabase(path, { readOnly: true, busyTimeoutMs: 0, lockWaitMs: 0 });
	try {
		return { path, file, ...(await shardOwner(database)) };
	} finally {
		await database.close();
	}
}

async function idleShard(path: string): Promise<IdleShard | undefined> {
	const lock = await tryRootLock(path).catch(() => null);
	if (lock === null) return undefined;
	try {
		return await inspectShard(path).catch(() => undefined);
	} finally {
		lock.release();
	}
}

async function removeConfirmedShard(
	path: string,
	rootLock: AdvisoryLock | undefined,
	confirm: (connection: DatabaseSync) => boolean | Promise<boolean>,
	openInOtherProcesses?: (location: string) => Promise<boolean>,
): Promise<void> {
	let openLock: AdvisoryLock | null = null;
	let location: string | undefined;
	let removed = false;
	try {
		location = await realpath(path).catch(() => undefined);
		if (location === undefined) return;
		openLock = await tryOpenLock(location).catch(() => null);
		if (openLock === null) return;
		if (await selfHasOpenFile(location)) return;
		if (await openInOtherProcesses?.(location)) return;
		const { DatabaseSync } = await import("node:sqlite");
		const connection = new DatabaseSync(location);
		let confirmed = false;
		try {
			confirmed = Boolean(await confirm(connection)) && onlyConnectionSync(connection);
		} finally {
			connection.close();
		}
		if (!confirmed || (await selfHasOpenFile(location))) return;
		removed = await removeShardFiles(location, path);
	} catch {
		return;
	} finally {
		openLock?.release();
		rootLock?.release();
	}
	if (removed && location !== undefined) await rmdir(dirname(location)).catch(() => {});
}

async function removeUnchanged(
	shard: IdleShard,
	openInOtherProcesses: (location: string) => Promise<boolean>,
): Promise<void> {
	const lock = await tryRootLock(shard.path).catch(() => null);
	if (lock === null) return;
	if ((await fileIdentity(shard.path).catch(() => undefined)) !== shard.file) {
		lock.release();
		return;
	}
	await removeConfirmedShard(
		shard.path,
		lock,
		async (connection) =>
			(await fileIdentity(shard.path).catch(() => undefined)) === shard.file &&
			sameOwner(shardOwnerSync(connection), shard),
		openInOtherProcesses,
	);
}

export async function retireEndedShipShards(directory: string, findEnded: FindEndedShipRoots): Promise<void> {
	const names = await readdir(directory).catch(() => []);
	const paths = names.filter((name) => name.endsWith(".sqlite")).map((name) => join(directory, name));
	if (paths.length === 0) return;
	const idle = await underJournalLock(directory, async () => {
		const found: IdleShard[] = [];
		for (const path of paths) {
			const shard = await idleShard(path);
			if (shard !== undefined) found.push(shard);
		}
		return found;
	});
	if (idle.length === 0) return;
	const roots = idle.flatMap((shard) => (shard.root === undefined ? [] : [shard.root]));
	const works = idle.flatMap((shard) => (shard.root === undefined && shard.work !== undefined ? [shard.work] : []));
	const ended = await findEnded(roots, works);
	const retired = idle.filter((shard) =>
		shard.root !== undefined ? ended.roots.has(shard.root) : shard.work === undefined || ended.works.has(shard.work),
	);
	if (retired.length === 0) return;
	await underJournalLock(directory, async () => {
		let otherOpen: Promise<ReadonlySet<string>> | undefined;
		const resolvedLocations: string[] = [];
		for (const shard of retired) {
			const location = await realpath(shard.path).catch(() => undefined);
			if (location !== undefined) resolvedLocations.push(location);
		}
		const openInOtherProcesses = async (location: string): Promise<boolean> => {
			otherOpen ??= otherProcessesOpenFiles(resolvedLocations);
			return (await otherOpen).has(location);
		};
		for (const shard of retired) await removeUnchanged(shard, openInOtherProcesses);
	});
}

async function removeShardFiles(location: string, path: string): Promise<boolean> {
	const removed = await rm(location, { force: true }).then(
		() => true,
		() => false,
	);
	if (!removed) return false;
	for (const suffix of ["-journal", "-wal", "-shm"]) await rm(`${location}${suffix}`, { force: true }).catch(() => {});
	for (const suffix of ["-holders", "-writers", "-wakes"])
		await rm(`${location}${suffix}`, { recursive: true, force: true }).catch(() => {});
	for (const lock of new Set([`${location}-open.lock`, `${path}-open.lock`, `${location}.lock`, `${path}.lock`]))
		await rm(lock, { force: true }).catch(() => {});
	return true;
}
