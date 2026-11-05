import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

const HELD_HANDLE_INTERVAL_MS = 60_000;

/**
 * A storage adapter whose database holds a handle the process waits for until the database is closed, as the socket of
 * a remote database client does, so a process cannot exit while its storage is open.
 */
export default {
	atomicStorageAdapter: 1,
	async openDatabase(options) {
		const database = await openNodeSqliteDatabase(String(options.path));
		const handle = setInterval(() => {}, HELD_HANDLE_INTERVAL_MS);
		const close = database.close.bind(database);
		database.close = async () => {
			clearInterval(handle);
			await close();
		};
		return database;
	},
} satisfies StorageAdapterModule;
