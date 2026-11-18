import assert from "node:assert/strict";
import { test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

const SHADOW_TABLES = ["data", "idx", "content", "docsize", "config"].map((suffix) => `scope_search_fts_${suffix}`);

test("dropping a scope never drops a full-text table's shadow tables apart from the table, even when its drop is retried", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		await database.exec("CREATE TABLE scope_sessions (id TEXT PRIMARY KEY)");
		await database.exec("CREATE VIRTUAL TABLE scope_search_fts USING fts5(body)");
		const drops: string[] = [];
		let failedOnce = false;
		// The shared server answers the full-text table's first drop with a transient error, as a busy server does. A
		// shadow table dropped before the retry leaves the full-text table undroppable on the server.
		const busy = new Proxy(database, {
			get(target, key) {
				if (key === "exec")
					return async (sql: string) => {
						drops.push(sql);
						if (!failedOnce && sql.includes('"scope_search_fts"')) {
							failedOnce = true;
							throw new Error("server busy");
						}
						return target.exec(sql);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as SqliteDatabase;

		await dropLibsqlScope(busy, "scope_");

		assert.ok(failedOnce);
		assert.deepEqual(
			drops.filter((sql) => SHADOW_TABLES.some((name) => sql.includes(`"${name}"`))),
			[],
		);
		assert.deepEqual(await database.all("SELECT name FROM sqlite_master WHERE name LIKE 'scope_%'"), []);
	});
});
