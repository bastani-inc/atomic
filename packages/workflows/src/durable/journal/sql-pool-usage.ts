import { ensureStorageSchema, type SqliteExecutor, type SqliteRow, type StorageDialect } from "@bastani/atomic/storage";
import { StaleWorkLeaseError, type StaleWorkLeaseReason } from "../../shared/worker-pool-errors.js";
import { locksRows, poolSchemaLedger, type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { poolSchemaPresent } from "./pool-schema-probe.js";
import {
	POOL_USAGE_FIELDS as FIELDS,
	type PoolUsage,
	poolUsageSchema,
	poolUsageTable,
	poolUsageTotalsSeed,
	poolUsageTotalsTable,
	poolUsageUpsert,
	upsertPoolUsage,
} from "./pool-stage-usage.js";
import { openSqlPoolQueue, type PoolHeartbeatRecord } from "./sql-pool-queue.js";
import { type Lease, type RunJournal, StaleLeaseError } from "./types.js";
import { validateText } from "./values.js";

export type { PoolUsage };
export interface PoolUsageReport {
	readonly key: string;
	readonly usage: PoolUsage;
}
type UsageToken = {
	readonly id: string;
	readonly generation: number;
	readonly worker: string | null;
	readonly epoch: number;
};

function validate(report: PoolUsageReport): void {
	validateText("key", report.key);
	if (report.key === "") throw new Error("Pool usage key must not be empty");
	for (const field of FIELDS) {
		const value = report.usage[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`Pool usage ${field} must be a finite non-negative number`);
	}
}

/** One Kahan-Babuska-Neumaier step, as SQLite's `SUM()` and the usage-total triggers take it. */
function addCompensated(total: { sum: number; error: number }, value: number): void {
	const sum = total.sum + value;
	total.error += Math.abs(total.sum) > Math.abs(value) ? total.sum - sum + value : value - sum + total.sum;
	total.sum = sum;
}

export class SqlPoolUsage {
	private readonly table: string;
	private readonly totals: string;
	private constructor(
		private readonly transaction: SqlPoolStorage["transaction"],
		private readonly read: SqlPoolStorage["read"],
		private readonly journal: SqlPoolStorage["tables"],
		private readonly dialect: StorageDialect,
	) {
		this.table = poolUsageTable(journal.runs);
		this.totals = poolUsageTotalsTable(journal.runs);
	}
	static async open(
		transaction: SqlPoolStorage["transaction"],
		read: SqlPoolStorage["read"],
		journal: SqlPoolStorage["tables"],
		dialect: StorageDialect,
		/** The tables exist already, as a read without the write lock found: the open writes nothing (#4768). */
		present = false,
	): Promise<SqlPoolUsage> {
		const usage = new SqlPoolUsage(transaction, read, journal, dialect);
		if (present) return usage;
		// A current schema runs no DDL, so a role with only DML privileges opens it (#5218).
		const schema = { ledger: poolSchemaLedger({ tables: journal }), domain: "pool-usage", revision: 1 };
		await transaction((tx) =>
			ensureStorageSchema(tx, dialect, schema, () => tx.exec(poolUsageSchema(journal.runs, dialect))),
		);
		return usage;
	}
	private async keptTotal(executor: SqliteExecutor, root: string): Promise<PoolUsage | undefined> {
		const columns = FIELDS.map((field) => field.toLowerCase());
		const kept = await executor.get(`SELECT * FROM ${this.totals} WHERE root = ?`, root);
		if (!kept) return undefined;
		return Object.fromEntries(
			FIELDS.map((field, index) => [field, Number(kept[columns[index]!]) + Number(kept[`${columns[index]}_err`])]),
		) as PoolUsage;
	}
	/**
	 * The root's running total, which triggers keep equal to `SUM()` over its usage rows. A root without one gets it
	 * once, from its rows, provided the root has a pool for the total to belong to.
	 */
	private async totalIn(tx: SqliteExecutor, root: string): Promise<PoolUsage> {
		const kept = await this.keptTotal(tx, root);
		if (kept) return kept;
		if (locksRows(this.dialect)) {
			// Fenced heartbeats create the row concurrently (#5102): create it the way they do, or keep theirs.
			const seed = poolUsageTotalsSeed(this.dialect, this.journal.runs, root);
			await tx.run(seed.sql, ...seed.params);
			const seeded = await this.keptTotal(tx, root);
			if (seeded) return seeded;
		}
		const columns = FIELDS.map((field) => field.toLowerCase());
		const row = await tx.get(
			`SELECT ${FIELDS.map((field) => `COALESCE(SUM(u.${field.toLowerCase()}), 0) AS ${field}`).join(", ")}
			 FROM ${this.table} u JOIN ${this.journal.runs}_work w ON w.id = u.work WHERE w.root = ?`,
			root,
		);
		const total = Object.fromEntries(FIELDS.map((field) => [field, Number(row?.[field] ?? 0)])) as PoolUsage;
		if (!(await tx.get(`SELECT 1 FROM ${this.journal.runs}_pool WHERE root = ?`, root))) return total;
		// SUM() returns its compensated sum rounded once; later steps need the sum and its error term both.
		const sums = columns.map(() => ({ sum: 0, error: 0 }));
		const rows = await tx.all(
			`SELECT ${columns.map((column) => `u.${column}`).join(", ")}
			 FROM ${this.table} u JOIN ${this.journal.runs}_work w ON w.id = u.work WHERE w.root = ?`,
			root,
		);
		for (const usage of rows)
			for (const [index, column] of columns.entries()) addCompensated(sums[index]!, Number(usage[column]));
		await tx.run(
			`INSERT INTO ${this.totals}(root, ${columns.map((column) => `${column}, ${column}_err`).join(", ")})
			 VALUES (?, ${columns.map(() => "?, ?").join(", ")})`,
			root,
			...sums.flatMap(({ sum, error }) => [sum, error]),
		);
		return total;
	}
	async report(lease: Lease, token: UsageToken, reports: readonly PoolUsageReport[]): Promise<PoolUsage> {
		return this.transaction(this.recording(lease, token, reports));
	}
	/**
	 * Validates `reports` now and returns what records them inside a pool transaction: the work of {@link report}, for a
	 * caller that records usage within a transaction of its own, such as a worker's heartbeat. Its `batched` form is the
	 * same recording as statements for a heartbeat's one request, whose own fences hold the attempt's lease: the reports'
	 * rows, then the root's total, which a root without one gets from `SUM()` over its rows first.
	 */
	recording(lease: Lease, token: UsageToken, reports: readonly PoolUsageReport[]): PoolHeartbeatRecord<PoolUsage> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		for (const report of reports) validate(report);
		const snapshot = reports.map((report) => ({ key: report.key, usage: { ...report.usage } }));
		const columns = FIELDS.map((field) => field.toLowerCase());
		const batched = {
			writes: [
				poolUsageTotalsSeed(this.dialect, this.journal.runs, lease.runId),
				...snapshot.map(({ key, usage }) =>
					poolUsageUpsert(this.dialect, this.journal.runs, token.id, token.generation, key, usage),
				),
			],
			reads: [{ sql: `SELECT * FROM ${this.totals} WHERE root = ?`, params: [lease.runId] }],
			result: ([rows]: readonly SqliteRow[][]) => {
				const kept = rows?.[0];
				return Object.fromEntries(
					FIELDS.map((field, index) => [
						field,
						kept === undefined ? 0 : Number(kept[columns[index]!]) + Number(kept[`${columns[index]}_err`]),
					]),
				) as PoolUsage;
			},
		};
		const record = async (tx: SqliteExecutor): Promise<PoolUsage> => {
			const authority = await tx.get(
				`SELECT l.epoch, l.holder_id, l.renewed_at, p.timeout, ${this.dialect.nowMs} AS now FROM ${this.journal.leases} l
				 LEFT JOIN ${this.journal.runs}_pool p ON p.root = l.run_id WHERE l.run_id = ?`,
				lease.runId,
			);
			if (
				!authority ||
				authority.timeout === null ||
				authority.epoch !== lease.epoch ||
				authority.holder_id !== lease.holderId ||
				isWorkflowLeaseExpired(Number(authority.renewed_at), Number(authority.timeout), Number(authority.now))
			)
				throw new StaleLeaseError(lease.runId, lease.epoch, Number(authority?.epoch ?? 0));
			const work = await tx.get(
				`SELECT * FROM ${this.journal.runs}_work WHERE id = ? AND root = ?`,
				token.id,
				lease.runId,
			);
			const stale = (reason: StaleWorkLeaseReason) =>
				new StaleWorkLeaseError({ root: lease.runId, workId: token.id, generation: token.generation, reason });
			if (work === undefined) throw stale("missing");
			if (work.state !== "leased" && work.state !== "completed") throw stale("not-leased");
			if (work.epoch !== token.epoch || work.epoch !== lease.epoch) throw stale("epoch-mismatch");
			if (work.generation !== token.generation) throw stale("generation-mismatch");
			if (work.worker !== token.worker) throw stale("worker-mismatch");
			if (work.state === "leased" && Number(work.expires_at) < Number(authority.now)) throw stale("expired");
			if (locksRows(this.dialect)) {
				// The totals row first, as a fenced heartbeat makes it, so this usage's trigger adds to it (#5102).
				const seed = poolUsageTotalsSeed(this.dialect, this.journal.runs, lease.runId);
				await tx.run(seed.sql, ...seed.params);
			}
			for (const { key, usage } of snapshot)
				await upsertPoolUsage(tx, this.dialect, this.journal.runs, token.id, token.generation, key, usage);
			return this.totalIn(tx, lease.runId);
		};
		return Object.assign(record, { batched });
	}
	async total(root: string): Promise<PoolUsage> {
		const kept = await this.read((executor) => this.keptTotal(executor, root));
		return kept ?? this.transaction((tx) => this.totalIn(tx, root));
	}
}

export async function openSqlPoolUsage(journal: RunJournal): Promise<SqlPoolUsage> {
	const storage = sqlPoolStorage(journal);
	if (!storage) throw new Error("Worker pool requires a SQL run journal");
	await openSqlPoolQueue(journal);
	// A schema that is current opens with reads alone, without a shared server's write lock (#4768).
	const present = await poolSchemaPresent(storage, [poolUsageSchema(storage.tables.runs, storage.dialect)]);
	return SqlPoolUsage.open(storage.transaction, storage.read, storage.tables, storage.dialect, present);
}
