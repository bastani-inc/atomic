import type { SqliteExecutor } from "@bastani/atomic/storage";
import { fold_usage } from "../../../builtin/verification-usage.js";
import type { DurableCheckpoint } from "../types.js";

export const POOL_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
export type PoolUsage = Readonly<Record<(typeof POOL_USAGE_FIELDS)[number], number>>;

export function poolUsageTable(runs: string): string {
	return `${runs}_pool_usage`;
}

export function poolUsageSchema(runs: string): string {
	return `CREATE TABLE IF NOT EXISTS ${poolUsageTable(runs)}(
		work TEXT NOT NULL REFERENCES ${runs}_work(id) ON DELETE CASCADE,
		generation INTEGER NOT NULL, key TEXT NOT NULL,
		input REAL NOT NULL, output REAL NOT NULL, cacheread REAL NOT NULL, cachewrite REAL NOT NULL, cost REAL NOT NULL,
		PRIMARY KEY(work, generation, key)
	)`;
}

export function poolStageUsageKey(runId: string, stageId: string): string {
	return `stage:${runId}:${stageId}`;
}

export function poolCheckpointUsage(checkpoint: DurableCheckpoint): { key: string; usage: PoolUsage } | undefined {
	if (
		checkpoint.kind !== "stage" ||
		!("output" in checkpoint) ||
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
