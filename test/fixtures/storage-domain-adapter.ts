import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";

export default {
	atomicStorageAdapter: 1,
	async openDatabase() {
		throw new StorageConfigError("sdk", "adapter", "database-hook-must-not-run");
	},
	async openSessionStore() {
		return new MemorySessionStore();
	},
} satisfies StorageAdapterModule;
