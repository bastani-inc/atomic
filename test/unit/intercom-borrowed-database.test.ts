import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { borrowedDatabase } from "../../packages/intercom/broker/open-broker-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openDatabase(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("intercom-borrowed-database-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		await database.close();
		removeTempDirectory(directory);
	});
	return database;
}

test("closing the wake-up bus's borrowed connection leaves the stores' connection open (#5054)", async () => {
	const database = await openDatabase();
	await borrowedDatabase(database).close();
	assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
});

test("the wake-up bus's borrowed connection speaks the database's dialect and keeps its batch method (#5054)", async () => {
	const database = await openDatabase();
	const batches: number[] = [];
	const postgres: SqliteDatabase = {
		...database,
		dialect: postgresDialect,
		batch: async (statements) => {
			batches.push(statements.length);
			return [];
		},
	};
	const borrowed = borrowedDatabase(postgres);
	assert.equal(borrowed.dialect, postgresDialect);
	await borrowed.batch?.([{ sql: "SELECT 1", params: [] }]);
	assert.deepEqual(batches, [1]);
});
