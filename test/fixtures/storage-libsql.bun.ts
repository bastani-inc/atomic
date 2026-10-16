import { describe, it } from "bun:test";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";

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
