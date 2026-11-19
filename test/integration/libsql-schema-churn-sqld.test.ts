import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
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
/**
 * Eight texts of 2,202 statements, half of them reads of wide rows, sent to a real server that every other storage test
 * file writes to at the same time: the server's cost, up to about 23 s in CI, not a slow test.
 */
const WIDE_TEXTS_TIMEOUT_MS = 120_000;

const prefix = `churn_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
const serverOptions = () => {
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	return { url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) };
};
const open = () => openLibsqlDatabase(serverOptions());

/**
 * How `run` ends for `sql` on a new `table` of unique numbers: the code and message of the server's answer when it
 * fails (`answer` finds it in the failure), and the rows it leaves.
 */
async function outcome(
	table: string,
	sql: string,
	run: (sql: string) => Promise<unknown>,
	answer: (failure: unknown) => unknown = (failure) => failure,
) {
	await database.exec(`DROP TABLE IF EXISTS ${table}`);
	await database.exec(`CREATE TABLE ${table} (x INTEGER UNIQUE)`);
	const failure = await run(sql).then(
		() => undefined,
		(error: unknown) => {
			const { code, message } = answer(error) as { readonly code?: unknown; readonly message?: unknown };
			return { code, message };
		},
	);
	return { failure, rows: await database.all(`SELECT x FROM ${table} ORDER BY x`) };
}

/**
 * How the server answers `sql` sent as one text, the way the adapter sent every `exec`, next to how the adapter's
 * `exec` ends for it; the adapter's failure holds the server's answer as its cause.
 */
async function serverAndExec(table: string, sql: string) {
	const client = createClient(serverOptions());
	try {
		return {
			server: await outcome(table, sql, (text) => client.executeMultiple(text)),
			exec: await outcome(
				table,
				sql,
				(text) => database.exec(text),
				(failure) => (failure as { readonly cause?: unknown }).cause,
			),
		};
	} finally {
		client.close();
	}
}

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

		test("several statements in one exec that the server cannot read whole fail with the server's own answer for the text, at its place in the text, or run as far as the server runs the text (#5652)", async () => {
			const table = `${prefix}answers`;
			for (const sql of [
				`INSERT INTO ${table} VALUES (1);\n  INSERT bad syntax`,
				`INSERT INTO ${table} VALUES (1);  INSERT bad syntax; INSERT INTO ${table} VALUES (2)`,
				`INSERT INTO ${table} VALUES (1); -- a note\n/* and another */INSERT bad syntax`,
				`INSERT bad syntax; INSERT INTO ${table} VALUES (1)`,
				// The server runs the statements before an unfinished last one.
				`INSERT INTO ${table} VALUES (1); INSERT INTO ${table} VALUES (`,
				`INSERT INTO ${table} VALUES (1); INSERT INTO ${table} VALUES (2); DELETE FROM ${table} WHERE x = 10 %`,
				`INSERT INTO ${table} VALUES (1); INSERT INTO ${table} VALUES (1); INSERT INTO ${table} VALUES (2)`,
				`INSERT INTO ${table} VALUES (1); INSERT INTO ${table} VALUES (2)`,
				// The server reports where in a statement it fails, counted from the end of the statement before it.
				`INSERT INTO ${table} VALUES (1);   INSERT INTO ${table} VALUES (nope)`,
				`INSERT INTO ${table} VALUES (1); /* a note */\n  DELETE FROM ${table} WHERE nope(x)`,
				`INSERT INTO ${table} VALUES (1);\n\tCREATE TABLE ${table} (y)`,
			]) {
				const { server, exec } = await serverAndExec(table, sql);
				assert.deepEqual(exec, server, sql);
			}
		});

		test(
			"several statements in one exec that return more columns than the server describes in one response run as the server runs the text (#5652)",
			async () => {
				const table = `${prefix}wide_rows`;
				const view = `${prefix}wide`;
				const returned = `${prefix}wide_returned`;
				// The server runs an exec's text without describing the columns its statements return; 2,200 statements that
				// return 64 columns with long names, or 150 columns, would take over 10 MB to describe, more than the server
				// answers in one response by default.
				const names = Array.from({ length: 64 }, (_, index) => `${"c".repeat(60)}${index}`);
				await database.exec(`CREATE VIEW ${view} AS SELECT ${names.map((name) => `1 AS ${name}`).join(", ")}`);
				await database.exec(`CREATE TABLE ${returned} (${names.join(", ")})`);
				const schemaVersion = async () =>
					Number(
						(await database.get<{ schema_version: number | bigint }>("PRAGMA schema_version"))?.schema_version,
					);
				const written = { failure: undefined, rows: [{ x: 1 }, { x: 2 }] };
				const client = createClient(serverOptions());
				try {
					for (const statement of [
						`SELECT * FROM ${view}`,
						`WITH named AS (SELECT * FROM ${view}) SELECT * FROM named`,
						`VALUES (${Array.from({ length: 150 }, () => "1").join(", ")})`,
						`DELETE FROM ${returned} WHERE 0 RETURNING *`,
					]) {
						const sql = `INSERT INTO ${table} VALUES (1); ${`${statement}; `.repeat(2_200)}INSERT INTO ${table} VALUES (2)`;
						// The text sent as one request, as the adapter sent every exec, and the adapter's exec, whose failure holds
						// the server's answer as its cause, are held to the same outcome.
						for (const [sender, run, answer] of [
							["one request", (text: string) => client.executeMultiple(text), undefined],
							[
								"exec",
								(text: string) => database.exec(text),
								(failure: unknown) => (failure as { readonly cause?: unknown }).cause,
							],
						] as const) {
							let schemaChanged = false;
							const result = await outcome(
								table,
								sql,
								async (text) => {
									const before = await schemaVersion();
									try {
										await run(text);
									} finally {
										schemaChanged = (await schemaVersion()) !== before;
									}
								},
								answer,
							);
							const label = `${statement} (${sender})`;
							// Other test files share the server and write to it, creating and dropping their tables. A text sent whole
							// meets their writes as any text does: the server refuses one of its statements without running it, with
							// `SQLITE_SCHEMA` when another connection changed the schema while the text ran, or with `SQLITE_BUSY` when
							// it cannot take the write lock, after the statements before it committed, and runs none after it (#5652).
							// Those are the only failures the text may have: never one for the size of the server's response, and
							// never one after both writes.
							const refused =
								result.failure?.code === "SQLITE_BUSY" ||
								(result.failure?.code === "SQLITE_SCHEMA" && schemaChanged);
							if (refused) {
								assert.notEqual(result.rows.length, written.rows.length, label);
								assert.deepEqual(result.rows, written.rows.slice(0, result.rows.length), label);
							} else assert.deepEqual(result, written, label);
						}
					}
				} finally {
					client.close();
					await database.exec(`DROP VIEW IF EXISTS ${view}`);
				}
			},
			WIDE_TEXTS_TIMEOUT_MS,
		);

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
