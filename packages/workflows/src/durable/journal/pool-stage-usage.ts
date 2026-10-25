import type { SqliteExecutor } from "@bastani/atomic/storage";
import { fold_usage } from "../../../builtin/verification-usage.js";
import type { DurableCheckpoint } from "../types.js";

export const POOL_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
export type PoolUsage = Readonly<Record<(typeof POOL_USAGE_FIELDS)[number], number>>;

export function poolUsageTable(runs: string): string {
	return `${runs}_pool_usage`;
}

export function poolUsageTotalsTable(runs: string): string {
	return `${runs}_pool_usage_totals`;
}

/**
 * One compensated (Kahan-Babuska-Neumaier) step adding `value` to a running total: the same summation SQLite's
 * `SUM()` uses, so the total plus its error term rounds to what `SUM()` over the root's rows returns.
 */
function addToTotals(totals: string, runs: string, work: string, sign: "" | "-", row: "NEW" | "OLD"): string {
	const assignments = POOL_USAGE_FIELDS.map((field) => {
		const total = field.toLowerCase();
		const value = `(${sign}${row}.${total})`;
		return `${total} = ${total} + ${value}, ${total}_err = ${total}_err + CASE WHEN abs(${total}) > abs(${value}) THEN (${total} - (${total} + ${value})) + ${value} ELSE (${value} - (${total} + ${value})) + ${total} END`;
	});
	return `UPDATE ${totals} SET ${assignments.join(", ")} WHERE root = (SELECT root FROM ${runs}_work WHERE id = ${work});`;
}

/**
 * The usage table, and each root's running total of it. Triggers keep a root's total current with every write to
 * its usage rows, from any connection; a root without a total row (a journal from before the totals table, or one
 * whose total a deletion invalidated) gets one from `SUM()` the next time its total is read.
 */
export function poolUsageSchema(runs: string): string {
	const usage = poolUsageTable(runs);
	const totals = poolUsageTotalsTable(runs);
	const columns = POOL_USAGE_FIELDS.map((field) => field.toLowerCase());
	return `CREATE TABLE IF NOT EXISTS ${usage}(
		work TEXT NOT NULL REFERENCES ${runs}_work(id) ON DELETE CASCADE,
		generation INTEGER NOT NULL, key TEXT NOT NULL,
		input REAL NOT NULL, output REAL NOT NULL, cacheread REAL NOT NULL, cachewrite REAL NOT NULL, cost REAL NOT NULL,
		PRIMARY KEY(work, generation, key)
	);
	CREATE TABLE IF NOT EXISTS ${totals}(
		root TEXT PRIMARY KEY REFERENCES ${runs}_pool(root) ON DELETE CASCADE,
		${columns.map((column) => `${column} REAL NOT NULL, ${column}_err REAL NOT NULL`).join(", ")}
	);
	CREATE TRIGGER IF NOT EXISTS ${totals}_insert AFTER INSERT ON ${usage} BEGIN
		${addToTotals(totals, runs, "NEW.work", "", "NEW")}
	END;
	CREATE TRIGGER IF NOT EXISTS ${totals}_update AFTER UPDATE ON ${usage}
	WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")} OR OLD.work IS NOT NEW.work BEGIN
		${addToTotals(totals, runs, "OLD.work", "-", "OLD")}
		${addToTotals(totals, runs, "NEW.work", "", "NEW")}
	END;
	CREATE TRIGGER IF NOT EXISTS ${totals}_delete AFTER DELETE ON ${usage} BEGIN
		DELETE FROM ${totals} WHERE root = (SELECT root FROM ${runs}_work WHERE id = OLD.work);
	END;
	CREATE TRIGGER IF NOT EXISTS ${totals}_work_delete BEFORE DELETE ON ${runs}_work BEGIN
		DELETE FROM ${totals} WHERE root = OLD.root;
	END;`;
}

export function poolStageUsageKey(runId: string, stageId: string): string {
	return `stage:${runId}:${stageId}`;
}

export function poolCheckpointUsage(checkpoint: DurableCheckpoint): { key: string; usage: PoolUsage } | undefined {
	if (
		checkpoint.kind !== "stage" ||
		(!("output" in checkpoint) && checkpoint.topology?.status !== "failed") ||
		!checkpoint.modelAttempts?.length ||
		!checkpoint.topology?.run
	)
		return;
	const { input, output, cacheRead, cacheWrite, cost } = fold_usage([
		{ stageName: checkpoint.name, text: "", modelAttempts: checkpoint.modelAttempts },
	]);
	const usage = { input, output, cacheRead, cacheWrite, cost };
	return { key: poolStageUsageKey(checkpoint.topology.run.runId, checkpoint.topology.stageId), usage };
}

export async function upsertPoolUsage(
	tx: SqliteExecutor,
	runs: string,
	work: string,
	generation: number,
	key: string,
	usage: PoolUsage,
): Promise<void> {
	const table = poolUsageTable(runs);
	const columns = POOL_USAGE_FIELDS.map((field) => field.toLowerCase());
	await tx.run(
		`INSERT INTO ${table}(work, generation, key, ${columns.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(work, generation, key) DO UPDATE SET ${columns.map((column) => `${column} = MAX(${table}.${column}, excluded.${column})`).join(", ")}`,
		work,
		generation,
		key,
		...POOL_USAGE_FIELDS.map((field) => usage[field]),
	);
}
