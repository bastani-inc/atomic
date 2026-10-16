import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { parseSessionTokens } from "../../packages/subagents/src/shared/session-tokens.js";

for (const sessionId of ["shared-id", ""]) {
	test(`token reader loads the selected store for ${JSON.stringify(sessionId)}`, async () => {
		const selected = new MemorySessionStore();
		const other = new MemorySessionStore();
		for (const [store, input] of [
			[selected, 3],
			[other, 99],
		] as const) {
			const source = new MemorySessionStore();
			const manager = await SessionManager.create(source, process.cwd());
			await manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const snapshot = await source.load(manager.getSessionId());
			await store.create({ ...snapshot.header, id: sessionId }, snapshot.entries);
		}
		assert.deepEqual(await parseSessionTokens(selected, sessionId), { input: 3, output: 2, total: 5 });
	});
}

test("token reader includes auxiliary usage and returns null for an unavailable session", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	await manager.appendUsage("summary", "openai", "test", {
		input: 7,
		output: 11,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 18,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.deepEqual(await parseSessionTokens(store, manager.getSessionId()), { input: 7, output: 11, total: 18 });
	assert.equal(await parseSessionTokens(store, "missing"), null);
});
