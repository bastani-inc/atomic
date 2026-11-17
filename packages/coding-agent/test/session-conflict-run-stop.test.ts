/** A run that another process's write to its session stopped saves nothing more (#5135). */
import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
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

/** The store's entries of `sessionId`, as a reader that opens it now sees them. */
async function storedEntries(store: MemorySessionStore, sessionId: string): Promise<readonly SessionEntry[]> {
	return (await SessionManager.open(store, sessionId)).getEntries();
}

/** Holds this store's first append that saves a system message until `release` resolves. */
function holdSystemAppend(store: MemorySessionStore): {
	readonly started: Promise<void>;
	readonly release: () => void;
} {
	const append = store.append.bind(store);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	store.append = (async (sessionId, entries, options) => {
		if (!held && entries.some((entry) => entry.type === "message" && entry.message.role === "system")) {
			held = true;
			started.resolve();
			await release.promise;
		}
		return append(sessionId, entries, options);
	}) as typeof store.append;
	return { started: started.promise, release: () => release.resolve() };
}

test("a message sent while a run's first write waits is not saved once another writer's entries stop that run (#5135)", async () => {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, sessionId) });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("never requested")]);
	const otherProcess = await SessionManager.open(store, sessionId);
	await otherProcess.appendMessage({ role: "user", content: "the other process's prompt", timestamp: Date.now() });
	const systemAppend = holdSystemAppend(store);

	const run = harness.session.prompt("continue");
	await systemAppend.started;
	const note = harness.session.sendCustomMessage(
		{ customType: "note", content: "sent while the run saves", display: true },
		{ excludeFromContext: true },
	);
	systemAppend.release();
	await run;

	await assert.rejects(note, SessionConflictError);
	const entries = await storedEntries(store, sessionId);
	assert.equal(entries.length, 2, JSON.stringify(entries.map((entry) => entry.type)));
	await otherProcess.appendMessage({ role: "user", content: "the other process goes on", timestamp: Date.now() });
});

test("disposal leaves a reconciliation that another writer's entries stopped pending in the store (#5135)", async () => {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, sessionId) });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("never requested")]);
	const otherProcess = await SessionManager.open(store, sessionId);
	const append = store.append.bind(store);
	let interleaved = false;
	store.append = (async (id, entries, options) => {
		if (!interleaved && entries.some((entry) => entry.type === "message" && entry.message.role === "system")) {
			interleaved = true;
			await otherProcess.appendMessage({
				role: "user",
				content: "the other process's prompt",
				timestamp: Date.now(),
			});
		}
		return append(id, entries, options);
	}) as typeof store.append;

	await harness.session.sendCustomMessage(
		{ customType: "notice", content: "the workflow finished", display: true },
		{ triggerTurn: true, persistWhenStreaming: true },
	);
	await harness.session.agent.waitForIdle();
	assert.ok(harness.session.getPersistenceFailure()?.conflict instanceof SessionConflictError);
	const stored = (await storedEntries(store, sessionId)).length;
	await harness.session.dispose();

	const entries = await storedEntries(store, sessionId);
	assert.equal(entries.length, stored, "disposal saved nothing after the other writer's entries");
	assert.ok(
		entries.some((entry) => entry.type === "custom_message" && entry.protectedReconciliation !== undefined),
		"the notice's card stays pending, so the session that reopens delivers it",
	);
	await otherProcess.appendMessage({ role: "user", content: "the other process goes on", timestamp: Date.now() });
});
