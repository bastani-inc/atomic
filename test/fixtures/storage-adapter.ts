import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

const cleanupFailure = new StorageUnavailableError(
	{ adapter: "test-adapter", location: "cleanup" },
	new Error("injected-close-failure"),
);

/** A database whose every call first waits `ms` on a timer, so each crosses a macrotask as a remote database's would. */
function withCallDelay(database: SqliteDatabase, ms: number): SqliteDatabase {
	const pause = () => new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));
	return {
		descriptor: database.descriptor,
		exec: async (sql) => (await pause(), database.exec(sql)),
		run: async (sql, ...params) => (await pause(), database.run(sql, ...params)),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await pause(), database.get<T>(sql, ...params)
		),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await pause(), database.all<T>(sql, ...params)
		),
		transaction: async (callback) => (await pause(), database.transaction(callback)),
		close: () => database.close(),
	};
}

export default {
	atomicStorageAdapter: 1,
	cleanupFailure,
	cleanupErrorType: StorageUnavailableError,
	async openDatabase(options, context) {
		assert.equal(typeof options.path, "string");
		const database = await openNodeSqliteDatabase(String(options.path));
		await database.exec("CREATE TABLE IF NOT EXISTS adapter_probe (options TEXT, domain TEXT)");
		await database.run("INSERT INTO adapter_probe VALUES (?, ?)", JSON.stringify(options), context.domain);
		if (typeof options.lifecycle === "string") {
			await appendFile(options.lifecycle, "open\n");
			const close = database.close.bind(database);
			database.close = async () => {
				await close();
				await appendFile(String(options.lifecycle), "close\n");
				if (options.closeFailure === true) {
					throw cleanupFailure;
				}
			};
		}
		if (typeof options.callDelayMs === "number") return withCallDelay(database, options.callDelayMs);
		return database;
	},
} satisfies StorageAdapterModule & {
	readonly cleanupFailure: StorageUnavailableError;
	readonly cleanupErrorType: typeof StorageUnavailableError;
};
