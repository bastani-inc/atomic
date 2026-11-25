import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

for (const shared of [false, true]) {
	registerSessionStoreConformance(
		{ describe, it },
		`SqlSessionStore${shared ? " shared database" : ""}`,
		async (body) => {
			const directory = makeTempDirectory("atomic-sql-session-");
			const path = join(directory, "sessions.sqlite");
			let database = await openNodeSqliteDatabase(path);
			const other = renderStorageIdentifiers("sessions", { data: "data" }, "other_");
			let writes = 0;
			const writeOther = async () => {
				if (!shared) return;
				await database.exec(`CREATE TABLE IF NOT EXISTS ${other.data} (value INTEGER) STRICT`);
				await database.run(`INSERT INTO ${other.data} VALUES (?)`, ++writes);
			};
			await writeOther();
			let store = await SqlSessionStore.open(database);
			try {
				await body({
					store,
					reopen: async () => {
						await database.close();
						database = await openNodeSqliteDatabase(path);
						await writeOther();
						store = await SqlSessionStore.open(database);
						return store;
					},
				});
				await writeOther();
				if (shared) {
					assert.equal((await database.get(`SELECT COUNT(*) AS count FROM ${other.data}`))?.count, writes);
					assert.equal(
						await database.get("SELECT name FROM sqlite_schema WHERE name = 'session_data'"),
						undefined,
					);
					assert.equal(
						await database.get("SELECT name FROM sqlite_schema WHERE name = 'other_session_sessions'"),
						undefined,
					);
				}
			} finally {
				await store.close().catch((error: Error) => assert.ok(error instanceof StoreClosedError));
				await database.close();
				removeTempDirectory(directory);
			}
		},
	);
}
