import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { AdapterOptions, StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

async function openDatabase(options: AdapterOptions) {
	return openNodeSqliteDatabase(String(options.path));
}

export default {
	atomicStorageAdapter: 1,
	async openSessionStore(options, _context, storage: { readonly prefix?: string } = {}) {
		const database = await openDatabase(options);
		const store = await SqlSessionStore.open(database, storage);
		store.close = () => database.close();
		return store;
	},
	async openRunJournal(options, _context, storage: { readonly prefix?: string } = {}) {
		const database = await openDatabase(options);
		const journal = await SqlRunJournal.open(database, storage);
		journal.close = () => database.close();
		return journal;
	},
} satisfies StorageAdapterModule;
