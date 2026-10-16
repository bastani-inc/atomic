import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";

export default {
	atomicStorageAdapter: 1,
	async openDatabase() {
		throw new StorageConfigError("sdk", "adapter", "database-hook-must-not-run");
	},
	async openSessionStore() {
		return new MemorySessionStore();
	},
	async openRunJournal() {
		return new MemoryRunJournal();
	},
} satisfies StorageAdapterModule;
