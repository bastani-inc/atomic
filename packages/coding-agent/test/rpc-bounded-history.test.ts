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
		const window = await handle({ type: "get_entries" });
		assert.ok(window?.success && window.command === "get_entries");
		assert.deepEqual(window.data, { entries: manager.getEntries(), leafId: manager.getLeafId() });
		const tree = await handle({ type: "get_tree" });
		assert.ok(tree?.success && tree.command === "get_tree");
		assert.deepEqual(tree.data, { tree: manager.getTree(), leafId: manager.getLeafId() });
		const prompts = await handle({ type: "get_fork_messages" });
		assert.ok(prompts?.success && prompts.command === "get_fork_messages");
		assert.deepEqual(prompts.data, { messages: [] });
		const received: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await handle({ type: "get_history_page", cursor });
			assert.ok(result?.success && result.command === "get_history_page");
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
		const last = await manager.readHistory({ direction: "backward" }).next();
		assert.ok(!last.done);
		assert.equal(last.value.items.at(-1)?.seq, entries.length, "the latest page ends at the stored watermark");
		assert.ok(last.value.nextCursor);
		await manager.appendMessage({ role: "user", content: "later", timestamp: 2 });
		const previous = await manager.readHistory({ cursor: last.value.nextCursor }).next();
		assert.ok(!previous.done);
		assert.equal(previous.value.items.at(-1)?.seq, last.value.items[0]!.seq - 1);
	} finally {
		await harness.cleanup();
		await store.close();
	}
});
