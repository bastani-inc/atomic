import type { SqliteExecutor } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import {
	POOL_USAGE_FIELDS as FIELDS,
	type PoolUsage,
	poolUsageSchema,
	poolUsageTable,
	poolUsageTotalsTable,
	upsertPoolUsage,
} from "./pool-stage-usage.js";
import { openSqlPoolQueue } from "./sql-pool-queue.js";
import { type Lease, type RunJournal, StaleLeaseError } from "./types.js";
import { validateText } from "./values.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

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
		private readonly journal: SqlPoolStorage["tables"],
	) {
		this.table = poolUsageTable(journal.runs);
		this.totals = poolUsageTotalsTable(journal.runs);
	}
	static async open(
		transaction: SqlPoolStorage["transaction"],
		journal: SqlPoolStorage["tables"],
	): Promise<SqlPoolUsage> {
		const usage = new SqlPoolUsage(transaction, journal);
		await transaction((tx) => tx.exec(poolUsageSchema(journal.runs)));
		return usage;
	}
	/**
	 * The root's running total, which triggers keep equal to `SUM()` over its usage rows. A root without one gets it
	 * once, from its rows, provided the root has a pool for the total to belong to.
	 */
	private async totalIn(tx: SqliteExecutor, root: string): Promise<PoolUsage> {
		const columns = FIELDS.map((field) => field.toLowerCase());
		const kept = await tx.get(`SELECT * FROM ${this.totals} WHERE root = ?`, root);
		if (kept)
			return Object.fromEntries(
				FIELDS.map((field, index) => [
					field,
					Number(kept[columns[index]!]) + Number(kept[`${columns[index]}_err`]),
				]),
			) as PoolUsage;
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
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		for (const report of reports) validate(report);
		const snapshot = reports.map((report) => ({ key: report.key, usage: { ...report.usage } }));
		return this.transaction(async (tx) => {
			const authority = await tx.get(
				`SELECT l.epoch, l.holder_id, l.renewed_at, p.timeout, ${STORE_NOW} AS now FROM ${this.journal.leases} l
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
			if (
				(work?.state !== "leased" && work?.state !== "completed") ||
				work.epoch !== token.epoch ||
				work.epoch !== lease.epoch ||
				work.generation !== token.generation ||
				work.worker !== token.worker ||
				(work.state === "leased" && Number(work.expires_at) < Number(authority.now))
			)
				throw new Error("Stale work lease");
			for (const { key, usage } of snapshot)
				await upsertPoolUsage(tx, this.journal.runs, token.id, token.generation, key, usage);
			return this.totalIn(tx, lease.runId);
		});
	}
	total(root: string): Promise<PoolUsage> {
		return this.transaction((tx) => this.totalIn(tx, root));
	}
}

export async function openSqlPoolUsage(journal: RunJournal): Promise<SqlPoolUsage> {
	const storage = sqlPoolStorage(journal);
	if (!storage) throw new Error("Worker pool requires a SQL run journal");
	await openSqlPoolQueue(journal);
	return SqlPoolUsage.open(storage.transaction, storage.tables);
}
