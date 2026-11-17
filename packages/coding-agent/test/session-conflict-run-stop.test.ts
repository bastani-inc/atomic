/** A run that another process's write to its session stopped saves nothing more (#5135). */
import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	return typeof message.content === "string"
		? message.content
		: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("a run stopped because another process wrote to the session saves none of its later messages (#5135)", async () => {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, sessionId) });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("never requested")]);
	const otherProcess = await SessionManager.open(store, sessionId);
	await otherProcess.appendMessage({ role: "user", content: "the other process's prompt", timestamp: Date.now() });

	await harness.session.prompt("continue");

	const stored = (await SessionManager.open(store, sessionId)).getEntries();
	const savedPrompts = stored.flatMap((entry) => {
		const text = entry.type === "message" ? userText(entry.message) : undefined;
		return text === undefined ? [] : [text];
	});
	assert.deepEqual(savedPrompts, ["earlier work", "the other process's prompt"]);
	const failure = harness.session.getPersistenceFailure();
	assert.ok(failure?.conflict instanceof SessionConflictError, failure?.error);
	assert.equal(failure.conflict.sessionId, sessionId);
	assert.deepEqual(
		failure.unsavedMessages.map((message) => userText(message) ?? message.role),
		["system", "continue"],
	);
	assert.equal(harness.getPendingResponseCount(), 1, "the stopped run sent no request");
});
