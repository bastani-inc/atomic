import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	createForkContextResolver,
	SubagentForkContextError,
} from "../../packages/subagents/src/shared/fork-context.js";
import { resolveCurrentSessionId } from "../../packages/subagents/src/shared/session-identity.js";

for (const sessionId of ["shared-id", ""]) {
	test(`fork context keeps ${JSON.stringify(sessionId)} in its selected store`, async () => {
		const selected = new MemorySessionStore();
		const other = new MemorySessionStore();
		for (const [store, content] of [
			[selected, "selected parent"],
			[other, "other parent"],
		] as const) {
			const source = new MemorySessionStore();
			const manager = await SessionManager.create(source, process.cwd());
			await manager.appendMessage({ role: "user", content, timestamp: Date.now() });
			const snapshot = await source.load(manager.getSessionId());
			await store.create({ ...snapshot.header, id: sessionId }, snapshot.entries);
		}
		const parent = await SessionManager.open(selected, sessionId);
		assert.equal(resolveCurrentSessionId(parent), sessionId);
		const resolver = createForkContextResolver(parent, "fork");
		const [first, same] = await Promise.all([resolver.sessionManagerForIndex(0), resolver.sessionManagerForIndex(0)]);
		assert.ok(first);
		assert.equal(first, same);
		assert.equal(first.getSessionStore(), selected);
		assert.equal(first.getHeader()?.parentSessionId, sessionId);
		assert.deepEqual(first.buildSessionContext().messages, parent.buildSessionContext().messages);
		assert.equal((await selected.load(first.getSessionId())).header.id, first.getSessionId());
		const second = await resolver.sessionManagerForIndex(1);
		assert.ok(second);
		assert.notEqual(second.getSessionId(), first.getSessionId());
		assert.equal(parent.getSessionId(), sessionId);
	});
}

test("fork context rejects a parent without a committed leaf with a typed error", async () => {
	const parent = await SessionManager.create(new MemorySessionStore(), process.cwd());
	assert.throws(
		() => createForkContextResolver(parent, "fork"),
		(error: Error) => {
			assert.ok(error instanceof SubagentForkContextError);
			assert.equal(error.parentSessionId, parent.getSessionId());
			assert.equal(error.reason, "no_leaf");
			return true;
		},
	);
});
