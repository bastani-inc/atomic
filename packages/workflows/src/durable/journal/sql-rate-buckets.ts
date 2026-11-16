import { ensureStorageSchema, fencedPath, type SqliteRow, type SqliteStatement } from "@bastani/atomic/storage";
import { poolSchemaLedger, type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { poolWriteBatch } from "./pool-guarded-write.js";
import { poolSchemaPresent } from "./pool-schema-probe.js";
import { FLEET_HOST_LIVE_MS } from "./sql-fleet.js";
import type { RunJournal } from "./types.js";

/**
 * Fleet-wide model rate limits in a shared journal (#4768): one token bucket per provider or `provider/model` scope,
 * kept as a GCRA "theoretical arrival time" on the database's clock, and a 429 cooldown every host of the journal sees.
 * The table derives from the journal's `runs` table name, so it is scoped by the journal's prefix.
 */

/** A bucket's shape: one token every `intervalMs`, at most `burst` ahead of now. */
export interface RateBucketShape {
	readonly intervalMs: number;
	readonly burst: number;
}

/** What one acquire got: the tokens, or how long until one is free. */
export type RateAcquireOutcome =
	| { readonly granted: number }
	/** `waitMs` until `fits` tokens are free; `cooldownMs` of it is a shared 429 cooldown. */
	| { readonly granted: 0; readonly waitMs: number; readonly fits: number; readonly cooldownMs: number };

/** What every host polls: shared cooldowns still running, and how many worker hosts report. */
export interface RateBucketPoll {
	readonly cooldowns: readonly { readonly scope: string; readonly remainingMs: number }[];
	readonly liveHosts: number;
}

const RATE_BUCKET = { audit: fencedPath("rate-bucket") } as const;

export class SqlRateBuckets {
	private readonly table: string;
	private readonly hosts: string;
	private readonly now: string;
	private readonly storage: SqlPoolStorage;
	private constructor(storage: SqlPoolStorage) {
		this.storage = storage;
		this.table = `${storage.tables.runs}_rate_buckets`;
		this.hosts = `${storage.tables.runs}_pool_hosts`;
		this.now = storage.dialect.nowMs;
	}

	/** Opens the rate bucket table of `journal`, a SQL journal, creating it. */
	static async open(journal: RunJournal): Promise<SqlRateBuckets> {
		const storage = sqlPoolStorage(journal);
		if (storage === undefined) throw new Error("Fleet rate limits require a SQL run journal");
		const store = new SqlRateBuckets(storage);
		const { int, real } = storage.dialect.types;
		// A current schema runs no DDL, so a role with only DML privileges opens it (#5218).
		const schema = { ledger: poolSchemaLedger(storage), domain: "rate-buckets", revision: 1 };
		const table = `CREATE TABLE IF NOT EXISTS ${store.table}(
				scope TEXT PRIMARY KEY, tat ${int} NOT NULL, interval_ms ${real} NOT NULL, burst ${int} NOT NULL,
				cooldown_until ${int} NOT NULL DEFAULT 0, kind TEXT, updated_at ${int}
			)`;
		// A schema that is current opens with reads alone, without a shared server's write lock (#4768).
		if (await poolSchemaPresent(storage, [table])) return store;
		await storage.transaction((tx) => ensureStorageSchema(tx, storage.dialect, schema, () => tx.exec(table)));
		return store;
	}

	/** Runs `statements` as one write: one batch or fenced transaction where the database has them. */
	private async write(statements: readonly SqliteStatement[]): Promise<SqliteRow[][]> {
		const batch = poolWriteBatch(this.storage, RATE_BUCKET);
		if (batch !== undefined) return batch(statements, RATE_BUCKET);
		return this.storage.transaction(async (tx) => {
			const rows: SqliteRow[][] = [];
			for (const statement of statements) rows.push(await tx.all(statement.sql, ...statement.params));
			return rows;
		});
	}

	/** Creates `scope`'s bucket with `shape`, or gives an existing one that shape: the last root to configure it wins. */
	private shape(scope: string, shape: RateBucketShape): SqliteStatement {
		return {
			sql: `INSERT INTO ${this.table}(scope, tat, interval_ms, burst, cooldown_until, updated_at)
				VALUES (?, 0, ?, ?, 0, ${this.now})
				ON CONFLICT(scope) DO UPDATE SET interval_ms = excluded.interval_ms, burst = excluded.burst
				WHERE ${this.table}.interval_ms <> excluded.interval_ms OR ${this.table}.burst <> excluded.burst`,
			params: [scope, shape.intervalMs, shape.burst],
		};
	}

	/**
	 * Takes `count` tokens of `scope` in one request (GCRA): granted when they fit within its burst and no cooldown
	 * runs, else nothing is taken and the outcome says how long until one token is free. `shape` is applied first when
	 * given. A failed request is never sent again: it may have taken the tokens (#4818), and the caller falls back.
	 */
	async acquire(scope: string, count: number, shape?: RateBucketShape): Promise<RateAcquireOutcome> {
		const d = this.storage.dialect;
		const next = `${d.greatest("tat", this.now)} + ? * interval_ms`;
		const statements: SqliteStatement[] = [
			...(shape === undefined ? [] : [this.shape(scope, shape)]),
			{
				sql: `UPDATE ${this.table} SET tat = CAST(${next} AS ${d.types.int}), updated_at = ${this.now}
					WHERE scope = ? AND ${next} - ${this.now} <= burst * interval_ms AND cooldown_until <= ${this.now}
					RETURNING tat`,
				params: [count, scope, count],
			},
			{
				sql: `SELECT tat, interval_ms, burst, cooldown_until, ${this.now} AS now FROM ${this.table} WHERE scope = ?`,
				params: [scope],
			},
		];
		const rows = await this.write(statements);
		const [taken, state] = rows.slice(-2) as [SqliteRow[], SqliteRow[]];
		if (taken.length > 0) return { granted: count };
		const row = state[0];
		// A scope nobody configured (its row never created) has no limit here.
		if (row === undefined) return { granted: count };
		return waitFor({
			tat: Number(row.tat),
			intervalMs: Number(row.interval_ms),
			burst: Number(row.burst),
			cooldownUntil: Number(row.cooldown_until),
			now: Number(row.now),
		});
	}

	/** Holds every host's requests to `scope` for `remainingMs` from now, by the database's clock; never shortens one. */
	async cooldown(scope: string, remainingMs: number): Promise<void> {
		const d = this.storage.dialect;
		await this.write([
			{
				sql: `INSERT INTO ${this.table}(scope, tat, interval_ms, burst, cooldown_until, kind, updated_at)
					VALUES (?, 0, 0, 1, ${this.now} + ?, 'cooldown', ${this.now})
					ON CONFLICT(scope) DO UPDATE SET cooldown_until = ${d.greatest(`${this.table}.cooldown_until`, "excluded.cooldown_until")},
					kind = 'cooldown', updated_at = excluded.updated_at`,
				params: [scope, Math.max(1, Math.ceil(remainingMs))],
			},
		]);
	}

	/** The shared cooldowns still running, and the worker hosts that reported within the fleet's live window. */
	poll(): Promise<RateBucketPoll> {
		return this.storage.read(async (executor) => {
			const rows = await executor.all<SqliteRow & { scope: string; remaining: number }>(
				`SELECT scope, cooldown_until - ${this.now} AS remaining FROM ${this.table} WHERE cooldown_until > ${this.now}`,
			);
			const probe = this.storage.dialect.tableExists(this.hosts);
			// A journal whose shared pool never opened has no host registry yet.
			const live =
				(await executor.get(probe.sql, ...probe.params)) === undefined
					? undefined
					: await executor.get<SqliteRow & { live: number }>(
							`SELECT COUNT(*) AS live FROM ${this.hosts} WHERE ${this.now} - heartbeat_at <= ?`,
							FLEET_HOST_LIVE_MS,
						);
			return {
				cooldowns: rows.map((row) => ({ scope: row.scope, remainingMs: Number(row.remaining) })),
				liveHosts: Number(live?.live ?? 0),
			};
		});
	}
}

/** A bucket as GCRA keeps it, on one clock. */
export interface GcraState {
	readonly tat: number;
	readonly intervalMs: number;
	readonly burst: number;
	readonly cooldownUntil: number;
	readonly now: number;
}

/**
 * How long until one token of a bucket is free, and how many fit then, from its state after an acquire was refused.
 */
export function waitFor(state: GcraState): RateAcquireOutcome & { readonly granted: 0 } {
	const { tat, intervalMs, burst, cooldownUntil, now } = state;
	const base = Math.max(tat, now);
	const cooldownMs = Math.max(0, cooldownUntil - now);
	// One token fits once `base + interval - t <= burst * interval`.
	const tokenMs = Math.max(0, base + intervalMs - burst * intervalMs - now);
	const waitMs = Math.max(cooldownMs, tokenMs);
	const at = now + waitMs;
	const fits =
		intervalMs <= 0 ? burst : Math.max(1, Math.floor((burst * intervalMs - (Math.max(base, at) - at)) / intervalMs));
	return { granted: 0, waitMs: Math.ceil(waitMs), fits, cooldownMs: Math.ceil(cooldownMs) };
}
