import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { SHIP_SHARD_SCHEMA } from "../../packages/workflows/src/workers/ship-shard.js";
import { SHIP_SHARD_SCHEMA as RELEASED_SCHEMA } from "../fixtures/ship-shard-0.9.88/ship-shard.js";

const { localShipRows } = (await import(
	new URL("../../research/evidence/elastic-workers/local-ship-rows.mjs", import.meta.url).href
)) as { localShipRows(database: DatabaseSync): { work: string; generation: number; n: number }[] };

for (const [name, schema, table] of [
	["current", SHIP_SHARD_SCHEMA, "ship_rows"],
	["0.9.88", RELEASED_SCHEMA, "ship_events"],
] as const) {
	test(`shipping measurements count the ${name} journal's pending rows per attempt (#5344)`, () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(schema);
			for (const [work, generation, key] of [
				["a", 1, "first"],
				["a", 1, "second"],
				["b", 2, "third"],
			] as const) {
				database
					.prepare(
						`INSERT INTO ${table}(work, generation, epoch, event_key, payload, digest, at) VALUES (?, ?, 1, ?, '{}', 'digest', 1)`,
					)
					.run(work, generation, key);
			}
			assert.deepEqual(
				localShipRows(database).map((row) => ({ ...row })),
				[
					{ work: "a", generation: 1, n: 2 },
					{ work: "b", generation: 2, n: 1 },
				],
			);
		} finally {
			database.close();
		}
	});
}
