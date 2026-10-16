import { describe, it } from "vitest";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";

registerSessionStoreConformance({ describe, it }, "SqlSessionStore on libSQL", async (body) => {
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
