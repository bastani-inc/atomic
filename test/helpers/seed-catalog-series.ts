import type { SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.js";

/** Inserts every integer in [first, last] as n.i, releasing the shared server's write lock between fixture batches. */
export async function seedCatalogSeries(
	database: SqliteExecutor,
	first: number,
	last: number,
	insert: string,
): Promise<void> {
	const batchRows = 4096;
	for (let start = first; start <= last; start += batchRows) {
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?) ${insert}`,
			start,
			Math.min(last, start + batchRows - 1),
		);
	}
}
