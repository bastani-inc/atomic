import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { isReopenableSession } from "../../packages/workflows/src/shared/session-transcript.js";

for (const sessionId of ["shared-id", ""]) {
	test(`stage resume and fork load ${JSON.stringify(sessionId)} from the selected project store`, async () => {
		const selected = new MemorySessionStore();
		const other = new MemorySessionStore();
		for (const [store, content] of [
			[selected, "selected project"],
			[other, "   "],
		] as const) {
			const source = new MemorySessionStore();
			const writer = await SessionManager.create(source, process.cwd());
			await writer.appendMessage({ role: "user", content, timestamp: Date.now() });
			const snapshot = await source.load(writer.getSessionId());
			await store.create({ ...snapshot.header, id: sessionId }, snapshot.entries);
		}
		const meta = { runId: "run", stageId: "stage", stageName: "build" };
		const resumed = await stripWorkflowOnlyOptions(
			{ sessionStore: selected, resumeFromSessionId: sessionId },
			undefined,
			meta,
		);
		assert.ok(resumed.sessionManager);
		assert.equal(resumed.sessionManager.getSessionId(), sessionId);
		assert.equal(resumed.sessionManager.getSessionStore(), selected);
		const resumedMessage = resumed.sessionManager.buildSessionContext().messages[0];
		assert.equal(resumedMessage?.role, "user");
		assert.ok(resumedMessage?.role === "user");
		assert.equal(resumedMessage.content, "selected project");
		assert.equal(await isReopenableSession(selected, sessionId), true);
		assert.equal(await isReopenableSession(other, sessionId), false);
		const forked = await stripWorkflowOnlyOptions(
			{ sessionStore: selected, context: "fork", forkFromSessionId: sessionId },
			undefined,
			meta,
		);
		assert.ok(forked.sessionManager);
		assert.notEqual(forked.sessionManager.getSessionId(), sessionId);
		assert.equal(forked.sessionManager.getSessionStore(), selected);
		assert.equal(forked.sessionManager.getHeader()?.parentSessionId, sessionId);
		assert.deepEqual(
			forked.sessionManager.buildSessionContext().messages,
			resumed.sessionManager.buildSessionContext().messages,
		);
		assert.equal((await selected.load(forked.sessionManager.getSessionId())).header.internal, true);
		assert.equal((await other.load(sessionId)).entries.length, 1);
	});
}

test("transcript validation does not create missing or blank sessions", async () => {
	const store = new MemorySessionStore();
	assert.equal(await isReopenableSession(store, "missing"), false);
	assert.equal(await store.readHeader("missing"), undefined);
	const blank = await SessionManager.create(store, process.cwd());
	assert.equal(await isReopenableSession(store, blank.getSessionId()), false);
	await blank.appendMessage({ role: "user", content: "   ", timestamp: Date.now() });
	assert.equal(await isReopenableSession(store, blank.getSessionId()), false);
	await blank.appendMessage({ role: "user", content: "usable", timestamp: Date.now() });
	assert.equal(await isReopenableSession(store, blank.getSessionId()), true);
});
