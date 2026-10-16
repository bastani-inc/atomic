import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";

assert.ok(process.env.ATOMIC_TEST_LIBSQL_ROOT, "Bun conformance requires a parent-owned temporary root");

registerSqliteDatabaseConformance({ describe, it }, "libSQL file on Bun", withLibsqlDatabase);
registerSessionStoreConformance({ describe, it }, "SqlSessionStore on libSQL on Bun", async (body) => {
	await withLibsqlDatabase(async (subject) => {
		let store = await SqlSessionStore.open(subject.database);
		await body({
			store,
			async reopen() {
				store = await SqlSessionStore.open(await subject.reopen());
				return store;
			},
		});
	});
});
