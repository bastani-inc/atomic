import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/** The named statements the connection that runs this query has prepared, apart from this query itself. */
async function preparedHere(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all<{ name: string }>(
		"SELECT name FROM pg_prepared_statements WHERE name LIKE 'atomic_%' AND statement NOT LIKE '%pg_prepared_statements%' ORDER BY name",
	);
	return rows.map((row) => row.name);
}

async function runTimes(database: SqliteDatabase, sql: string, times: number): Promise<void> {
	for (let i = 0; i < times; i++) await database.all(sql, i);
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL prepared statements (#6560)", () => {
	test("a statement sent twice is prepared once on its connection, and reused after", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1 });
			await runTimes(database, "SELECT ? + 1 AS next", 1);
			assert.deepEqual(await preparedHere(database), [], "a statement sent once is not prepared");
			await runTimes(database, "SELECT ? + 1 AS next", 4);
			const prepared = await preparedHere(database);
			assert.equal(prepared.length, 1);
			assert.deepEqual(await database.get("SELECT ? + 1 AS next", 41), { next: 42 });
			assert.deepEqual(await preparedHere(database), prepared, "the same statement is not prepared again");
		});
	});

	test("maxPreparedStatements 0 sends every statement unnamed", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1, maxPreparedStatements: 0 });
			await runTimes(database, "SELECT ? + 1 AS next", 5);
			assert.deepEqual(await preparedHere(database), []);
		});
	});

	test("a connection prepares at most maxPreparedStatements statements", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1, maxPreparedStatements: 2 });
			for (const sql of ["SELECT ? + 1 AS a", "SELECT ? + 2 AS b", "SELECT ? + 3 AS c", "SELECT ? + 4 AS d"])
				await runTimes(database, sql, 3);
			assert.equal((await preparedHere(database)).length, 2);
			assert.deepEqual(await database.get("SELECT ? + 4 AS d", 1), { d: 5 });
		});
	});

	test("with listenUrl set, as behind a transaction pooler, statements stay unnamed unless configured", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const pooled = await open({ maxConnections: 1, listenUrl: url });
			await runTimes(pooled, "SELECT ? + 1 AS next", 5);
			assert.deepEqual(await preparedHere(pooled), []);
			const configured = await open({ maxConnections: 1, listenUrl: url, maxPreparedStatements: 8 });
			await runTimes(configured, "SELECT ? + 1 AS next", 5);
			assert.equal((await preparedHere(configured)).length, 1);
		});
	});

	test("when the server loses the connection's statements, as a pooler without support does, the call is run again unnamed", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1 });
			await runTimes(database, "SELECT ? + 1 AS next", 3);
			assert.equal((await preparedHere(database)).length, 1);
			// The server forgets them while pg still believes they are prepared: the next execution is refused (26000).
			await database.exec("DEALLOCATE ALL");
			assert.deepEqual(await database.get("SELECT ? + 1 AS next", 9), { next: 10 });
			await runTimes(database, "SELECT ? + 1 AS next", 3);
			assert.deepEqual(await preparedHere(database), [], "statements are no longer named afterwards");
		});
	});

	test("a statement whose plan a schema change invalidated is run again on a new connection", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1 });
			const other = await open({ maxConnections: 1 });
			await database.exec("CREATE TABLE prepared_probe (a integer)");
			await database.run("INSERT INTO prepared_probe(a) VALUES (?)", 1);
			for (let i = 0; i < 3; i++) await database.all("SELECT * FROM prepared_probe WHERE a = ?", 1);
			// A new result column: the cached plan "must not change result type" (0A000).
			await other.exec("ALTER TABLE prepared_probe ADD COLUMN b integer DEFAULT 7");
			assert.deepEqual(await database.all("SELECT * FROM prepared_probe WHERE a = ?", 1), [{ a: 1, b: 7 }]);
			for (let i = 0; i < 2; i++) await database.all("SELECT * FROM prepared_probe WHERE a = ?", 1);
			assert.equal((await preparedHere(database)).length, 1, "statements are still named after a schema change");
		});
	});

	test("a transaction whose prepared statement went stale runs again and commits once", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ maxConnections: 1 });
			const other = await open({ maxConnections: 1 });
			await database.exec("CREATE TABLE prepared_tx (a integer)");
			const insertAndRead = () =>
				database.transaction(
					async (tx) => {
						await tx.run("INSERT INTO prepared_tx(a) VALUES (?)", 1);
						return tx.all("SELECT * FROM prepared_tx WHERE a = ?", 1);
					},
					{ retryTransientFailures: true },
				);
			for (let i = 0; i < 2; i++) await insertAndRead();
			await other.exec("ALTER TABLE prepared_tx ADD COLUMN b integer DEFAULT 7");
			const rows = await insertAndRead();
			assert.equal(rows.length, 3, "the failed attempt's insert rolled back; only the retry's committed");
			assert.ok(rows.every((row) => row.b === 7));
		});
	});
});
