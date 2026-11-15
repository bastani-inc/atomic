import assert from "node:assert/strict";
import { fencedPath, postgresDialect, type SqliteStatement, sqliteDialect } from "@bastani/atomic/storage";
import { test } from "vitest";
import { locksRows, type SqlPoolBatchOptions } from "../../packages/workflows/src/durable/journal/internal.js";
import { poolWriteBatch } from "../../packages/workflows/src/durable/journal/pool-guarded-write.js";

const statements: SqliteStatement[] = [{ sql: "SELECT 1", params: [] }];
const audit = fencedPath("pool-commit");

test("only a database whose dialect renders lock clauses locks rows (#5102)", () => {
	assert.equal(locksRows(sqliteDialect), false);
	assert.equal(locksRows(postgresDialect), true);
});

test("a libSQL batch carries a pool write, with its priority and without its audit (#5102)", async () => {
	const sent: (SqlPoolBatchOptions | undefined)[] = [];
	const batch = poolWriteBatch(
		{
			batch: async (_statements, options) => {
				sent.push(options);
				return [[{ batched: 1 }]];
			},
			fenced: async () => assert.fail("a database with batches never runs a fenced write"),
		},
		{ audit, priority: true },
	)!;
	assert.deepEqual(await batch(statements, { audit, priority: true }), [[{ batched: 1 }]]);
	await batch(statements);
	assert.deepEqual(sent, [{ priority: true }, undefined]);
});

test("a database that locks rows runs an audited pool write as one fenced write, and others in a transaction (#5102)", async () => {
	const calls: unknown[] = [];
	const storage = {
		fenced: async (sent: readonly SqliteStatement[], name: string) => {
			calls.push([sent, name]);
			return [[{ fenced: 1 }]];
		},
	};
	const batch = poolWriteBatch(storage, { audit })!;
	assert.deepEqual(await batch(statements), [[{ fenced: 1 }]]);
	assert.deepEqual(calls, [[statements, "pool-commit"]]);
	assert.equal(poolWriteBatch(storage, { priority: true }), undefined, "an unaudited write is not fenced");
	assert.equal(poolWriteBatch(storage), undefined);
	assert.equal(poolWriteBatch({}, { audit }), undefined, "nor is a write on a database without fenced writes");
});
