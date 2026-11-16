import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";

export function shipShardPath(stateDirectory: string, journalIdentity: string, root: string): string {
	const journal = createHash("sha256").update(journalIdentity).digest("hex").slice(0, 24);
	const file = createHash("sha256").update(root).digest("hex").slice(0, 32);
	return join(stateDirectory, "ship", journal, `${file}.sqlite`);
}

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

export function shipBatchId(
	root: string,
	lease: Pick<AttemptLease, "id" | "generation">,
	events: readonly Pick<ShipEvent, "key" | "digest">[],
): string {
	return createHash("sha256")
		.update(JSON.stringify([root, lease.id, lease.generation, events.map((event) => [event.key, event.digest])]))
		.digest("hex");
}

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
CREATE TABLE IF NOT EXISTS ship_cursor(
	work TEXT NOT NULL, generation INTEGER NOT NULL, shipped_local_seq INTEGER NOT NULL, shipped_at INTEGER NOT NULL,
	fenced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(work, generation)
);
CREATE TABLE IF NOT EXISTS ship_lease(
	work TEXT PRIMARY KEY, generation INTEGER NOT NULL, worker TEXT NOT NULL, epoch INTEGER NOT NULL
);
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

export class ShipShard {
	private readonly leases = new Map<string, HeldLease>();
	private closed = false;

	private constructor(
		private readonly database: SqliteDatabase,
		readonly root: string,
		private readonly path: string,
		private readonly now: () => number = () => performance.now(),
	) {}

	static async open(path: string, root: string, now?: () => number): Promise<ShipShard> {
		mkdirSync(dirname(path), { recursive: true });
		const database = await openNodeSqliteDatabase(path);
		try {
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
		} catch (error) {
			await database.close();
			throw error;
		}
		return new ShipShard(database, root, path, now);
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

	release(work: Pick<AttemptLease, "id" | "generation">): void {
		if (this.leases.get(work.id)?.lease.generation === work.generation) {
			this.leases.delete(work.id);
		}
	}

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
			this.assertHeld(root, lease);
			await this.assertStoredLease(tx, root, lease);
			const existing = await tx.get<SqliteRow & { local_seq: number; digest: string }>(
				`SELECT local_seq, digest FROM ship_events WHERE work = ? AND generation = ? AND event_key = ?`,
				lease.id,
				lease.generation,
				key,
			);
			if (existing !== undefined) {
				this.assertHeld(root, lease);
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
			this.assertHeld(root, lease);
			return { localSeq: Number(inserted!.local_seq), accepted: true };
		});
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

	async pendingCount(lease: Pick<AttemptLease, "id" | "generation">): Promise<number> {
		const row = await this.database.get<SqliteRow & { n: number }>(
			`SELECT COUNT(*) AS n FROM ship_events WHERE work = ? AND generation = ?`,
			lease.id,
			lease.generation,
		);
		return Number(row?.n ?? 0);
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
		const retire = options.retire === true && (await this.holdsNothing());
		const location = retire ? await realpath(this.path).catch(() => undefined) : undefined;
		await this.database.close();
		if (location !== undefined) await removeUnusedShardFiles(location);
	}

	private async holdsNothing(): Promise<boolean> {
		try {
			return (await this.database.get(`SELECT 1 AS present FROM ship_events LIMIT 1`)) === undefined;
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

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function usedByLiveConnection(location: string): boolean {
	let names: string[];
	try {
		names = readdirSync(`${location}-holders`);
	} catch {
		return false;
	}
	return names.some((name) => {
		const pid = Number(/^(\d+)-/.exec(name)?.[1] ?? Number.NaN);
		return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
	});
}

async function removeUnusedShardFiles(location: string): Promise<void> {
	if (usedByLiveConnection(location)) return;
	for (const suffix of ["-wal", "-shm", "-journal", ""])
		await rm(`${location}${suffix}`, { force: true }).catch(() => {});
	for (const suffix of ["-holders", "-writers", "-wakes"])
		await rm(`${location}${suffix}`, { recursive: true, force: true }).catch(() => {});
	await rmdir(dirname(location)).catch(() => {});
}
