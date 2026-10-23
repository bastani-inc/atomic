import type { SqliteExecutor } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { openSqlPoolQueue } from "./sql-pool-queue.js";
import { type Lease, type RunJournal, StaleLeaseError } from "./types.js";
import { validateText } from "./values.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

export type PoolUsage = Readonly<Record<(typeof FIELDS)[number], number>>;
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

const COLUMNS = FIELDS.map((field) => field.toLowerCase()).join(", ");

function validate(report: PoolUsageReport): void {
	validateText("key", report.key);
	if (report.key === "") throw new Error("Pool usage key must not be empty");
	for (const field of FIELDS) {
		const value = report.usage[field];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`Pool usage ${field} must be a finite non-negative number`);
	}
}

export class SqlPoolUsage {
	private readonly table: string;
	private constructor(
		private readonly transaction: SqlPoolStorage["transaction"],
		private readonly journal: SqlPoolStorage["tables"],
	) {
		this.table = `${journal.runs}_pool_usage`;
	}
	static async open(
		transaction: SqlPoolStorage["transaction"],
		journal: SqlPoolStorage["tables"],
	): Promise<SqlPoolUsage> {
		const usage = new SqlPoolUsage(transaction, journal);
		await transaction((tx) =>
			tx.exec(`
				CREATE TABLE IF NOT EXISTS ${usage.table}(
					work TEXT NOT NULL REFERENCES ${journal.runs}_work(id) ON DELETE CASCADE,
					generation INTEGER NOT NULL, key TEXT NOT NULL,
					input REAL NOT NULL, output REAL NOT NULL, cacheread REAL NOT NULL, cachewrite REAL NOT NULL, cost REAL NOT NULL,
					PRIMARY KEY(work, generation, key)
				)
			`),
		);
		return usage;
	}
	private async totalIn(tx: SqliteExecutor, root: string): Promise<PoolUsage> {
		const row = await tx.get(
			`SELECT ${FIELDS.map((field) => `COALESCE(SUM(u.${field.toLowerCase()}), 0) AS ${field}`).join(", ")}
			 FROM ${this.table} u JOIN ${this.journal.runs}_work w ON w.id = u.work WHERE w.root = ?`,
			root,
		);
		return Object.fromEntries(FIELDS.map((field) => [field, Number(row?.[field] ?? 0)])) as PoolUsage;
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
				await tx.run(
					`INSERT INTO ${this.table}(work, generation, key, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(work, generation, key) DO UPDATE SET ${FIELDS.map((field) => {
							const column = field.toLowerCase();
							return `${column} = MAX(${this.table}.${column}, excluded.${column})`;
						}).join(", ")}`,
					token.id,
					token.generation,
					key,
					...FIELDS.map((field) => usage[field]),
				);
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
