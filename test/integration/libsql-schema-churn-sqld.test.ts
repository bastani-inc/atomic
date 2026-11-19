import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
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
 * changing. Each text holds enough writes that the server often refuses one of them after the ones before it committed,
 * and few enough that a loaded server commits all of them in time: every statement commits on its own.
 */
const SEVERAL_STATEMENT_TEXTS = 20;
const WRITES_PER_TEXT = 10;

const prefix = `churn_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
const open = () => {
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	return openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
};

/**
 * Starts connections that keep creating, indexing and dropping tables of their own; the function it returns stops them
 * and closes them.
 */
async function churnSchema(): Promise<() => Promise<void>> {
	const changers = await Promise.all(Array.from({ length: SCHEMA_CHANGERS }, open));
	let stop = false;
	const churn = Promise.all(
		changers.map(async (changer, index) => {
			for (let round = 0; !stop; round++) {
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
				// Every request that carries a text's first trigger, counted by the trigger's name, and those that also carry
				// one of the text's writes.
				const sent = new Map<string, number>();
				const sentWithWrites = new Map<string, number>();
				const real = globalThis.fetch;
				vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = new Request(input, init);
					const body = await request.clone().text();
					for (const marker of body.match(new RegExp(`${prefix}first_\\d+`, "g")) ?? []) {
						sent.set(marker, (sent.get(marker) ?? 0) + 1);
						if (body.includes("SET n = n + 1")) sentWithWrites.set(marker, (sentWithWrites.get(marker) ?? 0) + 1);
					}
					return real(request);
				});
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
					vi.unstubAllGlobals();
				}
				for (const { marker, failed, added } of outcomes) {
					assert.ok((sent.get(marker) ?? 0) >= 1, `${marker} was sent`);
					assert.equal(
						sentWithWrites.get(marker),
						undefined,
						`${marker} was never sent together with the writes after it, which would run them again`,
					);
					assert.equal(failed, false, `${marker}'s exec succeeded`);
					assert.equal(added, WRITES_PER_TEXT, `${marker}'s exec wrote ${added} times, once each`);
				}
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
