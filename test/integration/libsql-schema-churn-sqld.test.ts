import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

/**
 * Statements on a real libSQL server (sqld) while other connections keep creating and dropping their own tables, as
 * stores of several sessions, workflows and tests sharing one server do. Runs only when a server is named with
 * `ATOMIC_TEST_LIBSQL_URL` (and `ATOMIC_TEST_LIBSQL_TOKEN_FILE` for a server that checks tokens).
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;

/**
 * Connections that change the schema at the same time, each pausing between changes. Enough that the server answers
 * the writes `SQLITE_SCHEMA` without the adapter running them again, yet each pause leaves the server, which other
 * test files share, time for their own statements.
 */
const SCHEMA_CHANGERS = 8;
const SCHEMA_CHANGE_PAUSE_MS = 5;
/** The writes that run while the schema keeps changing: enough that some meet a changed schema. */
const WRITES = 60;
/** A row large enough that the server takes long to prepare and run it, so other connections change the schema meanwhile. */
const ROW_BYTES = 512 * 1024;
/** Sixty large writes to a real server under schema churn, and the churn's own requests: the server's cost, not a slow test. */
const SCHEMA_CHURN_TIMEOUT_MS = 300_000;
/**
 * Texts of one `exec` that hold a trigger, writes that add to a count and another trigger, run while the schema keeps
 * changing. The server refuses a write with `SQLITE_SCHEMA` when the schema changed while it waited for the write lock,
 * which under steady churn happens to several of these writes, after the ones before them committed. Few enough that
 * the churn, which every other test file on the server meets too, lasts no longer than it must: every statement waits
 * for the write lock and commits on its own.
 */
const SEVERAL_STATEMENT_TEXTS = 5;
const WRITES_PER_TEXT = 3;

const prefix = `churn_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
const open = () => {
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	return openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
};

/**
 * Starts connections that keep creating, indexing and dropping tables of their own, and returns once each has changed
 * the schema, so the churn is steady from the first statement a test sends; the function it returns stops them and
 * closes them.
 */
async function churnSchema(): Promise<() => Promise<void>> {
	const changers = await Promise.all(Array.from({ length: SCHEMA_CHANGERS }, open));
	let stop = false;
	const started = changers.map(() => Promise.withResolvers<void>());
	const churn = Promise.all(
		changers.map(async (changer, index) => {
			for (let round = 0; !stop; round++) {
				if (round === 1) started[index]!.resolve();
				const table = `${prefix}churn_${index}_${round % 8}`;
				// The changers only stir the schema: one of their own statements that gives up under the churn they cause is
				// no part of what the tests check.
				await changer.exec(`CREATE TABLE IF NOT EXISTS ${table} (x)`).catch(() => undefined);
				await changer.exec(`CREATE INDEX IF NOT EXISTS ${table}_x ON ${table}(x)`).catch(() => undefined);
				await changer.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
				await new Promise((resolve) => setTimeout(resolve, SCHEMA_CHANGE_PAUSE_MS));
			}
		}),
	);
	await Promise.race([Promise.all(started.map(({ promise }) => promise)), churn]);
	return async () => {
		stop = true;
		await churn;
		for (const changer of changers) await changer.close();
	};
}

let database: SqliteDatabase;
beforeAll(async () => {
	if (serverUrl === undefined) return;
	database = await open();
	await database.exec(`CREATE TABLE ${prefix}rows (k INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
});
afterAll(async () => {
	if (serverUrl === undefined) return;
	await dropLibsqlScope(database, prefix);
	await database.close();
});

describe.skipIf(serverUrl === undefined)(
	"statements while other connections change the schema of a libSQL server",
	() => {
		test("several statements in one exec that the server cannot read run none of them (#5652)", async () => {
			const table = `${prefix}unread`;
			await database.exec(`CREATE TABLE ${table}_rows (x)`);
			for (const sql of [
				`CREATE TABLE ${table} (x); INSERT INTO ${table}_rows VALUES (1); CREATE TABLEE ${table}_more (y)`,
				// A no-break space is whitespace to neither SQLite nor sqld: the second statement is not one.
				`INSERT INTO ${table}_rows VALUES (1);\u00A0INSERT INTO ${table}_rows VALUES (2);`,
			]) {
				await assert.rejects(database.exec(sql), sql);
				assert.equal(
					await database.get("SELECT name FROM sqlite_schema WHERE name = ?", table),
					undefined,
					`the server read the whole text before it ran any statement of it: ${sql}`,
				);
				assert.deepEqual(await database.all(`SELECT x FROM ${table}_rows`), [], sql);
			}
		});

		test(
			"every write lands once while other connections keep creating and dropping their tables",
			async () => {
				const stopChurn = await churnSchema();
				const data = new Uint8Array(ROW_BYTES).fill(7);
				try {
					for (let index = 0; index < WRITES; index++) {
						if (index % 2 === 0)
							await database.run(`INSERT INTO ${prefix}rows (k, data) VALUES (?, ?)`, index, data);
						else
							await database.transaction(async (tx) => {
								await tx.run(`INSERT INTO ${prefix}rows (k, data) VALUES (?, ?)`, index, data);
							});
					}
				} finally {
					await stopChurn();
				}
				const row = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${prefix}rows`);
				assert.equal(row?.count, WRITES);
			},
			SCHEMA_CHURN_TIMEOUT_MS,
		);

		test(
			"a trigger whose name ends in a combining accent, writes and another trigger in one exec each run once while other connections keep changing the schema (#5509, #5652)",
			async () => {
				const table = `${prefix}counts`;
				await database.exec(`CREATE TABLE ${table} (n INTEGER NOT NULL, "case\u0301" TEXT)`);
				await database.run(`INSERT INTO ${table} (n) VALUES (0)`);
				const count = async () => Number((await database.get<{ n: number | bigint }>(`SELECT n FROM ${table}`))?.n);
				const stopChurn = await churnSchema();
				const outcomes: { readonly marker: string; readonly failed: boolean; readonly added: number }[] = [];
				try {
					for (let round = 0; round < SEVERAL_STATEMENT_TEXTS; round++) {
						const marker = `${prefix}first_${round}`;
						// SQLite reads `case` followed by a combining accent (U+0301) as one name, not as the keyword CASE: the
						// first trigger ends at its own END, and every write and the second trigger are statements of their own.
						const sql =
							`CREATE TRIGGER IF NOT EXISTS ${marker} AFTER INSERT ON ${table} BEGIN SELECT new.case\u0301; END; ` +
							`UPDATE ${table} SET n = n + 1; `.repeat(WRITES_PER_TEXT) +
							`CREATE TRIGGER IF NOT EXISTS ${prefix}last_${round} AFTER DELETE ON ${table} BEGIN SELECT 1; END;`;
						const before = await count();
						const failed = await database.exec(sql).then(
							() => false,
							() => true,
						);
						outcomes.push({ marker, failed, added: (await count()) - before });
					}
				} finally {
					await stopChurn();
				}
				// A text sent again whole after the server refused one of its statements would write more than once.
				for (const { marker, failed, added } of outcomes) {
					assert.equal(failed, false, `${marker}'s exec succeeded`);
					assert.equal(added, WRITES_PER_TEXT, `${marker}'s exec wrote ${added} times, once each`);
				}
				const triggers = await database.get<{ count: number | bigint }>(
					"SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?",
					table,
				);
				assert.equal(Number(triggers?.count), 2 * SEVERAL_STATEMENT_TEXTS, "both triggers of every text");
			},
			SCHEMA_CHURN_TIMEOUT_MS,
		);

		test(
			"tables, rows and a count written by several statements in one exec land once each while other connections keep changing the schema (#5652)",
			async () => {
				const counts = `${prefix}several_counts`;
				await database.exec(`CREATE TABLE ${counts} (n INTEGER NOT NULL)`);
				await database.run(`INSERT INTO ${counts} (n) VALUES (0)`);
				const stopChurn = await churnSchema();
				const failures: unknown[] = [];
				try {
					for (let round = 0; round < SEVERAL_STATEMENT_TEXTS; round++) {
						const parents = `${prefix}parents_${round}`;
						const children = `${prefix}children_${round}`;
						// The storage conformance check's own setup, then writes that each add one to the count.
						await database
							.exec(
								`CREATE TABLE ${parents} (id INTEGER PRIMARY KEY); ` +
									`CREATE TABLE ${children} (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES ${parents}(id) DEFERRABLE INITIALLY DEFERRED); ` +
									`INSERT INTO ${parents} (id) VALUES (1); INSERT INTO ${children} (id, parent) VALUES (1, 1); ` +
									`UPDATE ${counts} SET n = n + 1; `.repeat(WRITES_PER_TEXT),
							)
							.catch((error: unknown) => failures.push(error));
					}
				} finally {
					await stopChurn();
				}
				assert.deepEqual(failures, []);
				for (let round = 0; round < SEVERAL_STATEMENT_TEXTS; round++) {
					const row = await database.get<{ count: number }>(
						`SELECT COUNT(*) AS count FROM ${prefix}children_${round} JOIN ${prefix}parents_${round} ON parent = ${prefix}parents_${round}.id`,
					);
					assert.equal(row?.count, 1);
				}
				const count = await database.get<{ n: number | bigint }>(`SELECT n FROM ${counts}`);
				assert.equal(Number(count?.n), SEVERAL_STATEMENT_TEXTS * WRITES_PER_TEXT);
			},
			SCHEMA_CHURN_TIMEOUT_MS,
		);
	},
);
