import type { SqliteExecutor, SqliteRow } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import type { RunJournal } from "./types.js";

/**
 * The fleet controller's tables in a shared journal (#4768): the controller lease, which fences every write a controller
 * makes, the hosts it asked to drain, and its decisions and provider errors. Every table derives from the journal's own
 * `runs` table name, so it is scoped by the journal's prefix.
 */

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** How long after its last report a registered worker host still counts as live: six of its 5 s reports. */
export const FLEET_HOST_LIVE_MS = 30_000;

/** Fleet events kept: older ones are deleted as new ones are recorded. */
export const FLEET_EVENTS_KEPT = 1_000;

/** The hosts a controller asked to drain, which worker hosts read: worker hosts create it as well. */
export function fleetDrainsSchema(runs: string): string {
	return `CREATE TABLE IF NOT EXISTS ${runs}_fleet_drains(
		host TEXT PRIMARY KEY, provider_id TEXT, requested_at INTEGER NOT NULL
	)`;
}

/** The epoch of the controller lease a controller holds; every write it makes checks it is still current. */
export interface FleetFence {
	readonly holder: string;
	readonly epoch: number;
}

export type FleetLeaseState =
	| { readonly held: true; readonly epoch: number }
	| { readonly held: false; readonly holder: string; readonly epoch: number };

export interface FleetEvent {
	readonly seq: number;
	readonly at: number;
	readonly kind: string;
	readonly target: number | null;
	readonly live: number | null;
	readonly reason: string;
	readonly error: string | null;
}

/** One shared root's queue as the controller reads it. */
export interface FleetRootRow {
	readonly root: string;
	readonly ready: number;
	readonly leased: number;
	readonly sessionLimit?: number;
	/** Budget-blocked, paused, or its root process stopped renewing its lease: it starts no child now. */
	readonly blocked: boolean;
}

/** A registered worker host as the controller reads it. */
export interface FleetRegisteredHost {
	readonly host: string;
	readonly providerId?: string;
	readonly live: boolean;
	readonly leased: number;
}

export interface FleetSnapshot {
	readonly roots: readonly FleetRootRow[];
	readonly hosts: readonly FleetRegisteredHost[];
	readonly drains: readonly { readonly host: string; readonly providerId?: string }[];
	/** Children held by each worker host id, registered or not. */
	readonly leased: ReadonlyMap<string, number>;
}

async function tableExists(executor: SqliteExecutor, name: string): Promise<boolean> {
	return (
		(await executor.get("SELECT 1 AS held FROM sqlite_master WHERE type = 'table' AND name = ?", name)) !== undefined
	);
}

export class SqlFleetStore {
	private readonly lease: string;
	private readonly events: string;
	private readonly drains: string;
	private readonly runs: string;
	private constructor(private readonly storage: SqlPoolStorage) {
		this.runs = storage.tables.runs;
		this.lease = `${this.runs}_fleet_controller`;
		this.events = `${this.runs}_fleet_events`;
		this.drains = `${this.runs}_fleet_drains`;
	}

	/** Opens the fleet tables of `journal`, a SQL journal, creating them. */
	static async open(journal: RunJournal): Promise<SqlFleetStore> {
		const storage = sqlPoolStorage(journal);
		if (storage === undefined) throw new Error("A fleet controller requires a SQL run journal");
		const store = new SqlFleetStore(storage);
		await storage.transaction((tx) =>
			tx.exec(`
				CREATE TABLE IF NOT EXISTS ${store.lease}(
					id INTEGER PRIMARY KEY CHECK(id = 1), holder TEXT NOT NULL, epoch INTEGER NOT NULL, renewed_at INTEGER NOT NULL,
					lease_ms INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS ${store.events}(
					seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, target INTEGER, live INTEGER,
					reason TEXT NOT NULL, error TEXT
				);
				${fleetDrainsSchema(store.runs)};
			`),
		);
		return store;
	}

	/**
	 * Takes or renews the controller lease for `holder`, which then lasts `leaseMs` from each renewal: renews it when
	 * `holder` holds it at `epoch`, takes it over with the next epoch when nobody does or its holder did not renew it
	 * within the lease that holder set, by the database's clock, and otherwise reports who holds it.
	 */
	acquire(holder: string, epoch: number | undefined, leaseMs: number): Promise<FleetLeaseState> {
		return this.storage.transaction(async (tx) => {
			const row = await tx.get<
				SqliteRow & { holder: string; epoch: number; renewed_at: number; lease_ms: number; now: number }
			>(`SELECT holder, epoch, renewed_at, lease_ms, ${STORE_NOW} AS now FROM ${this.lease} WHERE id = 1`);
			if (row === undefined) {
				await tx.run(
					`INSERT INTO ${this.lease}(id, holder, epoch, renewed_at, lease_ms) VALUES (1, ?, 1, ${STORE_NOW}, ?)`,
					holder,
					leaseMs,
				);
				return { held: true, epoch: 1 };
			}
			const current = Number(row.epoch);
			if (row.holder === holder && current === epoch) {
				await tx.run(`UPDATE ${this.lease} SET renewed_at = ${STORE_NOW}, lease_ms = ? WHERE id = 1`, leaseMs);
				return { held: true, epoch: current };
			}
			// The lease lasts as long as its holder set, whatever this controller's own lease would be.
			if (Number(row.now) - Number(row.renewed_at) < Number(row.lease_ms))
				return { held: false, holder: row.holder, epoch: current };
			await tx.run(
				`UPDATE ${this.lease} SET holder = ?, epoch = ?, renewed_at = ${STORE_NOW}, lease_ms = ? WHERE id = 1`,
				holder,
				current + 1,
				leaseMs,
			);
			return { held: true, epoch: current + 1 };
		});
	}

	/** Gives the lease up at once, so another controller takes over on its next tick. */
	async release(fence: FleetFence): Promise<void> {
		await this.storage.transaction((tx) =>
			tx.run(
				`UPDATE ${this.lease} SET renewed_at = 0 WHERE id = 1 AND holder = ? AND epoch = ?`,
				fence.holder,
				fence.epoch,
			),
		);
	}

	private fenced(): string {
		return `EXISTS (SELECT 1 FROM ${this.lease} WHERE id = 1 AND holder = ? AND epoch = ?)`;
	}

	/** Records a decision or an error, under `fence`; returns whether the lease still allowed it. */
	async record(
		fence: FleetFence,
		event: {
			readonly kind: string;
			readonly target?: number;
			readonly live?: number;
			readonly reason: string;
			readonly error?: string;
		},
	): Promise<boolean> {
		return this.storage.transaction(async (tx) => {
			const inserted = await tx.run(
				`INSERT INTO ${this.events}(at, kind, target, live, reason, error) SELECT ${STORE_NOW}, ?, ?, ?, ?, ? WHERE ${this.fenced()}`,
				event.kind,
				event.target ?? null,
				event.live ?? null,
				event.reason,
				event.error ?? null,
				fence.holder,
				fence.epoch,
			);
			if (inserted.changes === 0) return false;
			await tx.run(
				`DELETE FROM ${this.events} WHERE seq <= (SELECT MAX(seq) FROM ${this.events}) - ?`,
				FLEET_EVENTS_KEPT,
			);
			return true;
		});
	}

	/**
	 * Asks the registered host `host` to drain, under `fence`, only if it holds no child now: a host that took one since
	 * the controller looked is left serving. Returns whether it was asked.
	 */
	async requestDrain(fence: FleetFence, host: string, providerId: string): Promise<boolean> {
		return this.storage.transaction(async (tx) => {
			// A journal whose pool never queued work has no work table, and no lease.
			const idle = (await tableExists(tx, `${this.runs}_work`))
				? `AND NOT EXISTS (SELECT 1 FROM ${this.runs}_work WHERE state = 'leased' AND substr(worker, 1, length(?) + 1) = ? || '/')`
				: "AND ? IS NOT NULL AND ? IS NOT NULL";
			const asked = await tx.run(
				`INSERT INTO ${this.drains}(host, provider_id, requested_at) SELECT ?, ?, ${STORE_NOW}
				WHERE ${this.fenced()} ${idle}
				ON CONFLICT(host) DO NOTHING`,
				host,
				providerId,
				fence.holder,
				fence.epoch,
				host,
				host,
			);
			return asked.changes === 1;
		});
	}

	/** Forgets the drain of `host`, once its provider removed it: a host that registers with that id later serves. */
	async clearDrain(fence: FleetFence, host: string): Promise<void> {
		await this.storage.transaction((tx) =>
			tx.run(`DELETE FROM ${this.drains} WHERE host = ? AND ${this.fenced()}`, host, fence.holder, fence.epoch),
		);
	}

	/** The latest events, newest last. */
	async recent(limit: number): Promise<readonly FleetEvent[]> {
		const rows = await this.storage.read((executor) =>
			executor.all<SqliteRow & FleetEvent>(
				`SELECT seq, at, kind, target, live, reason, error FROM ${this.events} ORDER BY seq DESC LIMIT ?`,
				limit,
			),
		);
		return rows.reverse().map((row) => ({
			seq: Number(row.seq),
			at: Number(row.at),
			kind: row.kind,
			target: row.target === null ? null : Number(row.target),
			live: row.live === null ? null : Number(row.live),
			reason: row.reason,
			error: row.error,
		}));
	}

	/**
	 * The shared roots' queues, the registered worker hosts with the children each holds, and the hosts asked to drain,
	 * read without the write lock. Empty while the journal never ran a shared pool.
	 */
	snapshot(): Promise<FleetSnapshot> {
		const runs = this.runs;
		return this.storage.read(async (executor) => {
			const drains = (
				await executor.all<SqliteRow & { host: string; provider_id: string | null }>(
					`SELECT host, provider_id FROM ${this.drains} ORDER BY host`,
				)
			).map((row) => ({ host: row.host, ...(row.provider_id === null ? {} : { providerId: row.provider_id }) }));
			if (!(await tableExists(executor, `${runs}_pool_shared`)))
				return { roots: [], hosts: [], drains, leased: new Map() };
			const roots = await executor.all<
				SqliteRow & { root: string; config: string; blocked: number; ready: number; leased: number }
			>(
				`SELECT s.root, s.config,
				(s.budget_blocked = 1 OR r.status != 'running' OR ${STORE_NOW} - l.renewed_at > p.timeout) AS blocked,
				(SELECT COUNT(*) FROM ${runs}_work w WHERE w.root = s.root AND w.state = 'ready') AS ready,
				(SELECT COUNT(*) FROM ${runs}_work w WHERE w.root = s.root AND w.state = 'leased') AS leased
				FROM ${runs}_pool_shared s JOIN ${runs} r ON r.run_id = s.root
				JOIN ${this.storage.tables.leases} l ON l.run_id = s.root AND l.epoch = s.epoch
				JOIN ${runs}_pool p ON p.root = s.root
				WHERE r.status IN ('running', 'paused') ORDER BY s.rowid`,
			);
			const leases = await executor.all<SqliteRow & { worker: string; count: number }>(
				`SELECT worker, COUNT(*) AS count FROM ${runs}_work WHERE state = 'leased' GROUP BY worker`,
			);
			const heldBy = new Map<string, number>();
			for (const row of leases) {
				const host = row.worker.slice(0, Math.max(0, row.worker.lastIndexOf("/")));
				heldBy.set(host, (heldBy.get(host) ?? 0) + Number(row.count));
			}
			const registered = await executor.all<SqliteRow & { host: string; provider_id?: string | null; ago: number }>(
				`SELECT *, ${STORE_NOW} - heartbeat_at AS ago FROM ${runs}_pool_hosts ORDER BY host`,
			);
			return {
				roots: roots.map((row) => {
					const session = (JSON.parse(row.config) as { admission?: { limits?: { session?: number } } }).admission
						?.limits?.session;
					return {
						root: row.root,
						ready: Number(row.ready),
						leased: Number(row.leased),
						...(session === undefined ? {} : { sessionLimit: session }),
						blocked: Number(row.blocked) === 1,
					};
				}),
				hosts: registered.map((row) => ({
					host: row.host,
					...(row.provider_id === undefined || row.provider_id === null ? {} : { providerId: row.provider_id }),
					live: Number(row.ago) <= FLEET_HOST_LIVE_MS,
					leased: heldBy.get(row.host) ?? 0,
				})),
				drains,
				leased: heldBy,
			};
		});
	}
}
