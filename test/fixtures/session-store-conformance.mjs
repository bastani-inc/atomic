import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSessionStoreConformance } from "../../packages/coding-agent/dist/core/storage/session/conformance.js";
import { SessionConflictError, StoreClosedError } from "../../packages/coding-agent/dist/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/dist/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/dist/core/storage/session/types.js";

assert.equal(SESSION_FORMAT_VERSION, 4);
assert.equal(new SessionConflictError("session", 1, 2).actualSeq, 2);

registerSessionStoreConformance({ describe, it }, "built session storage", async (body) => {
	let store = new MemorySessionStore();
	try {
		await body({
			store,
			reopen: async () => {
				store = await store.reopen();
				return store;
			},
		});
	} finally {
		await store.close().catch((error) => assert.ok(error instanceof StoreClosedError));
	}
});
