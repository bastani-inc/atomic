import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_HISTORY_PAGE_ENTRIES } from "../src/core/storage/session/types.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { createHarness } from "./suite/harness.js";

test("RPC pages a compacted session's saved entries without putting them back in the engine (#5554)", async () => {
	const store = new MemorySessionStore();
	const timestamp = new Date(0).toISOString();
	const entries: SessionEntry[] = Array.from({ length: SESSION_HISTORY_PAGE_ENTRIES * 2 + 3 }, (_, i) => ({
		type: "message",
		id: `row${i}`,
		parentId: i ? `row${i - 1}` : null,
		timestamp,
		message: { role: "user", timestamp: 0, content: `prompt ${i}` },
	}));
	entries.push({
		type: "compaction",
		id: "cut",
		parentId: entries.at(-1)!.id,
		timestamp,
		summary: "cleared",
		tokensBefore: 1000,
		firstKeptEntryId: null,
		details: { strategy: "verbatim-lines" },
	});
	await store.create({ id: "rpc-paged", version: 4, createdAt: timestamp, cwd: process.cwd() }, entries);
	const manager = await SessionManager.open(store, "rpc-paged");
	const harness = await createHarness({ sessionManager: manager });
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const handle = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: () => {},
	});
	try {
		const held = manager.getEntryCount();
		const received: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await handle({ type: "get_entries", cursor });
			assert.ok(result?.success && result.command === "get_entries");
			assert.equal(manager.getEntryCount(), held, "the RPC reader hydrated old messages");
			const { items, nextCursor } = result.data;
			assert.ok(items.length > 0 && items.length <= SESSION_HISTORY_PAGE_ENTRIES);
			for (const item of items) {
				assert.ok("entry" in item);
				received.push(item.entry.id);
			}
			cursor = nextCursor;
		} while (cursor);
		assert.deepEqual(
			received,
			entries.map((entry) => entry.id),
		);
	} finally {
		await harness.cleanup();
		await store.close();
	}
});
