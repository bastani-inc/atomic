import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

const cleanupFailure = new StorageUnavailableError(
	{ adapter: "test-adapter", location: "cleanup" },
	new Error("injected-close-failure"),
);

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
		return database;
	},
} satisfies StorageAdapterModule & {
	readonly cleanupFailure: StorageUnavailableError;
	readonly cleanupErrorType: typeof StorageUnavailableError;
};
