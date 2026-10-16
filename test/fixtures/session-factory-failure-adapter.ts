import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";

export default {
	atomicStorageAdapter: 1,
	async openSessionStore(options) {
		assert.equal(typeof options.lifecycle, "string");
		const lifecycle = String(options.lifecycle);
		const store = new MemorySessionStore();
		await appendFile(lifecycle, "open\n");
		store.findMostRecent = async () => {
			throw new TypeError("recent");
		};
		const close = store.close.bind(store);
		store.close = async () => {
			await close();
			await appendFile(lifecycle, "close\n");
		};
		return store;
	},
} satisfies StorageAdapterModule;
