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

const prefix = `churn_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
const open = () => {
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	return openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
};

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
		test(
			"every write lands once while other connections keep creating and dropping their tables",
			async () => {
				const changers = await Promise.all(Array.from({ length: SCHEMA_CHANGERS }, open));
				let stop = false;
				const churn = Promise.all(
					changers.map(async (changer, index) => {
						for (let round = 0; !stop; round++) {
							const table = `${prefix}churn_${index}_${round % 8}`;
							// The changers only stir the schema: one of their own statements that gives up under the churn they
							// cause is no part of what this test checks.
							await changer.exec(`CREATE TABLE IF NOT EXISTS ${table} (x)`).catch(() => undefined);
							await changer.exec(`CREATE INDEX IF NOT EXISTS ${table}_x ON ${table}(x)`).catch(() => undefined);
							await changer.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
							await new Promise((resolve) => setTimeout(resolve, SCHEMA_CHANGE_PAUSE_MS));
						}
					}),
				);
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
					stop = true;
					await churn;
					for (const changer of changers) await changer.close();
				}
				const row = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${prefix}rows`);
				assert.equal(row?.count, WRITES);
			},
			SCHEMA_CHURN_TIMEOUT_MS,
		);
	},
);
