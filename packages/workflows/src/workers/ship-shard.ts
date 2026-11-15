import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";

/**
 * Where a host keeps the checkpoints it accepted for one shared root and has not shipped yet (#4768): one SQLite file
 * per root, under the host's pool state directory and the identity of the shared journal, so a host serving many
 * roots never contends on one file.
 */
export function shipShardPath(stateDirectory: string, journalIdentity: string, root: string): string {
	const journal = createHash("sha256").update(journalIdentity).digest("hex").slice(0, 24);
	const file = createHash("sha256").update(root).digest("hex").slice(0, 32);
	return join(stateDirectory, "ship", journal, `${file}.sqlite`);
}

/** A checkpoint a host accepted for an attempt, as the local journal holds it. */
export interface ShipEvent {
	readonly localSeq: number;
	readonly work: string;
	readonly generation: number;
	readonly epoch: number;
	readonly key: string;
	readonly payload: string;
	readonly digest: string;
	readonly at: number;
}

/** A sealed batch: its content address and its checkpoints, in the order the host accepted them. */
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
	};
}

/** A batch's content address: the root, the attempt, and each checkpoint's key and digest, in order. */
export function shipBatchId(
	root: string,
	lease: Pick<AttemptLease, "id" | "generation">,
	events: readonly Pick<ShipEvent, "key" | "digest">[],
): string {
	return createHash("sha256")
		.update(JSON.stringify([root, lease.id, lease.generation, events.map((event) => [event.key, event.digest])]))
		.digest("hex");
}

/** The attempt's lease as the host last renewed it: what a local commit is checked against. */
interface HeldLease {
	readonly lease: AttemptLease;
	readonly leaseMs: number;
	/** When the host last renewed it, by `performance.now()`, so a wall-clock step never extends or ends it (#5058). */
	renewedAt: number;
}

export const SHIP_SHARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS ship_events(
	local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
	work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
	event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
	batch TEXT,
	UNIQUE(work, event_key)
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

/**
 * The attempt accepted a checkpoint under this key before, with another payload: the identity conflict the shared
 * journal reports for the same case, with its message.
 */
export class ShipIdentityConflictError extends Error {
	override readonly name = "ShipIdentityConflictError";
	constructor() {
		super("Pool checkpoint identity conflict");
	}
}

/**
 * One shared root's local checkpoint journal on this host (#4768). The host accepts an attempt's checkpoint here only
 * while it holds the attempt's lease, and ships accepted checkpoints to the shared journal under that lease's fences.
 */
export class ShipShard {
	private readonly leases = new Map<string, HeldLease>();
	private closed = false;

	private constructor(
		private readonly database: SqliteDatabase,
		readonly root: string,
		private readonly now: () => number = () => performance.now(),
	) {}

	static async open(path: string, root: string, now?: () => number): Promise<ShipShard> {
		mkdirSync(dirname(path), { recursive: true });
		const database = await openNodeSqliteDatabase(path);
		try {
			await database.exec(SHIP_SHARD_SCHEMA);
			// Checkpoints whose attempt's lease the journal no longer names can never ship: an attempt replaced here.
			await database.run(
				`DELETE FROM ship_events WHERE NOT EXISTS (SELECT 1 FROM ship_lease l WHERE l.work = ship_events.work AND l.generation = ship_events.generation)`,
			);
		} catch (error) {
			await database.close();
			throw error;
		}
		return new ShipShard(database, root, now);
	}

	/**
	 * The host holds `lease` for its attempt, renewed now: at its claim, and again by each heartbeat. Rows another
	 * generation of the work left behind are dropped: a displaced attempt's checkpoints are never shipped.
	 */
	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		const held = this.leases.get(lease.id);
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
			await tx.run(`DELETE FROM ship_events WHERE work = ? AND generation <> ?`, lease.id, lease.generation);
			await tx.run(`DELETE FROM ship_cursor WHERE work = ? AND generation <> ?`, lease.id, lease.generation);
			await tx.run(
				`INSERT INTO ship_lease(work, generation, worker, epoch) VALUES (?, ?, ?, ?)
				ON CONFLICT(work) DO UPDATE SET generation = excluded.generation, worker = excluded.worker, epoch = excluded.epoch`,
				lease.id,
				lease.generation,
				lease.worker,
				lease.epoch,
			);
		});
	}

	/** The host no longer holds the attempt's lease: its local commits are refused from now on. */
	release(workId: string): void {
		this.leases.delete(workId);
	}

	/**
	 * Accepts `payload` as the attempt's checkpoint under `key`. Refused, with {@link StaleWorkLeaseError}, unless the
	 * host holds the attempt's lease (same generation, worker and epoch) and renewed it within the lease's duration. The
	 * same key with the same payload is the checkpoint accepted before; with another payload it is an identity conflict.
	 */
	async accept(
		root: string,
		lease: AttemptLease,
		key: string,
		payload: string,
		at: number,
	): Promise<{ readonly localSeq: number; readonly accepted: boolean }> {
		this.assertHeld(root, lease);
		const digest = shipDigest(payload);
		return this.database.transaction(async (tx) => {
			const existing = await tx.get<SqliteRow & { local_seq: number; digest: string }>(
				`SELECT local_seq, digest FROM ship_events WHERE work = ? AND event_key = ?`,
				lease.id,
				key,
			);
			if (existing !== undefined) {
				if (existing.digest !== digest) throw new ShipIdentityConflictError();
				return { localSeq: Number(existing.local_seq), accepted: false };
			}
			const inserted = await tx.get<SqliteRow & { local_seq: number }>(
				`INSERT INTO ship_events(work, generation, epoch, event_key, payload, digest, at) VALUES (?, ?, ?, ?, ?, ?, ?)
				RETURNING local_seq`,
				lease.id,
				lease.generation,
				lease.epoch,
				key,
				payload,
				digest,
				at,
			);
			return { localSeq: Number(inserted!.local_seq), accepted: true };
		});
	}

	/** The attempt's accepted checkpoints not shipped yet, in the order the host accepted them. */
	pending(lease: Pick<AttemptLease, "id" | "generation">, limit = 1_000): Promise<ShipEvent[]> {
		return this.rows(
			this.database,
			`WHERE work = ? AND generation = ? ORDER BY local_seq LIMIT ?`,
			lease.id,
			lease.generation,
			limit,
		);
	}

	/**
	 * The attempt's next batch to ship, up to `maxBatch` checkpoints in the order the host accepted them, or undefined
	 * when nothing is left. A batch is sealed once: until it is shipped, the same checkpoints are the same batch, under
	 * the same id, however often it is asked for, so a retry after a lost answer is recognised as delivered.
	 */
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
			const events = await this.rows(
				tx,
				`WHERE work = ? AND generation = ? ORDER BY local_seq LIMIT ?`,
				lease.id,
				lease.generation,
				maxBatch,
			);
			if (events.length === 0) return undefined;
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

	/** How many checkpoints of the attempt the host holds unshipped. */
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
	async leftover(): Promise<{ readonly lease: AttemptLease; readonly pending: number }[]> {
		const rows = await this.database.all<
			SqliteRow & { work: string; generation: number; worker: string; epoch: number; pending: number }
		>(
			`SELECT l.work, l.generation, l.worker, l.epoch,
				(SELECT COUNT(*) FROM ship_events e WHERE e.work = l.work AND e.generation = l.generation) AS pending
			FROM ship_lease l WHERE EXISTS (SELECT 1 FROM ship_events e WHERE e.work = l.work AND e.generation = l.generation)`,
		);
		return rows.map((row) => ({
			lease: { id: row.work, generation: Number(row.generation), worker: row.worker, epoch: Number(row.epoch) },
			pending: Number(row.pending),
		}));
	}

	private async rows(
		executor: Pick<SqliteDatabase, "all">,
		where: string,
		...params: (string | number)[]
	): Promise<ShipEvent[]> {
		const rows = await executor.all<ShipEventRow>(
			`SELECT local_seq, work, generation, epoch, event_key, payload, digest, at FROM ship_events ${where}`,
			...params,
		);
		return rows.map(shipEventOf);
	}

	/** The shared journal holds the attempt's checkpoints up to `localSeq`: the host forgets them. */
	async shipped(lease: Pick<AttemptLease, "id" | "generation">, localSeq: number, at = Date.now()): Promise<void> {
		await this.database.transaction(async (tx) => {
			await tx.run(
				`DELETE FROM ship_events WHERE work = ? AND generation = ? AND local_seq <= ?`,
				lease.id,
				lease.generation,
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

	/**
	 * The shared store refused the attempt's checkpoints because another attempt owns its work: the host drops what it
	 * did not ship, refuses the attempt's next commit, and marks the attempt fenced.
	 */
	async fence(lease: Pick<AttemptLease, "id" | "generation">, at = Date.now()): Promise<void> {
		const held = this.leases.get(lease.id);
		if (held?.lease.generation === lease.generation) this.leases.delete(lease.id);
		await this.database.transaction(async (tx) => {
			await tx.run(`DELETE FROM ship_events WHERE work = ? AND generation = ?`, lease.id, lease.generation);
			await tx.run(
				`INSERT INTO ship_cursor(work, generation, shipped_local_seq, shipped_at, fenced) VALUES (?, ?, 0, ?, 1)
				ON CONFLICT(work, generation) DO UPDATE SET fenced = 1, shipped_at = excluded.shipped_at`,
				lease.id,
				lease.generation,
				at,
			);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.leases.clear();
		await this.database.close();
	}

	private assertHeld(root: string, lease: AttemptLease): void {
		const stale = (reason: "missing" | "generation-mismatch" | "worker-mismatch" | "epoch-mismatch" | "expired") =>
			new StaleWorkLeaseError({ root, workId: lease.id, generation: lease.generation, reason });
		const held = this.leases.get(lease.id);
		if (held === undefined) throw stale("missing");
		if (held.lease.generation !== lease.generation) throw stale("generation-mismatch");
		if (held.lease.worker !== lease.worker) throw stale("worker-mismatch");
		if (held.lease.epoch !== lease.epoch) throw stale("epoch-mismatch");
		if (this.now() - held.renewedAt >= held.leaseMs) throw stale("expired");
	}
}
