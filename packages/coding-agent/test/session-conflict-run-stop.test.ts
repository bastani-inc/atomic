/** A run that another process's write to its session stopped saves nothing more (#5135). */
import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { MAX_RETAINED_UNSAVED_INPUTS } from "../src/core/agent-session-persistence-failures.ts";
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
		["continue", "system"],
	);
	assert.equal(harness.getPendingResponseCount(), 1, "the stopped run sent no request");

	harness.session.refreshContext();
	assert.deepEqual(
		harness.session.getPersistenceFailure()?.unsavedMessages.map((message) => userText(message) ?? message.role),
		["continue", "system"],
		"a context refresh keeps the unsaved prompt",
	);
	harness.setResponses([fauxAssistantMessage("answered")]);
	await harness.session.prompt("continue");
	assert.equal(harness.session.getPersistenceFailure(), undefined, "the prompt sent again was saved");
	assert.equal(harness.session.getUnsavedInput(), undefined, "the saved prompt settles the one kept unsaved");
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
	const unsaved = harness.session.getPersistenceFailure()?.unsavedMessages ?? [];
	const kept = unsaved.find((message) => message.role === "custom" && message.customType === "note");
	assert.ok(kept, "the refused message stays recoverable in the session, not only with its sender");
	assert.equal(kept.role === "custom" ? kept.content : undefined, "sent while the run saves");
	assert.ok(
		harness.events.some((event) => event.type === "message_end" && event.message === kept),
		"the refused message is shown",
	);
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

/** A session whose run another writer's entries stopped, with a `/noop` command that saves nothing. */
async function conflictStoppedSession() {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({
		sessionManager: await SessionManager.open(store, sessionId),
		extensionFactories: [
			(atomic) => atomic.registerCommand("noop", { description: "does nothing", handler: async () => {} }),
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("never requested")]);
	const otherProcess = await SessionManager.open(store, sessionId);
	await otherProcess.appendMessage({ role: "user", content: "the other process's prompt", timestamp: Date.now() });
	await harness.session.prompt("continue");
	assert.ok(harness.session.getPersistenceFailure()?.conflict instanceof SessionConflictError);
	return { harness, store, sessionId };
}

const unsavedKinds = (harness: Harness) =>
	harness.session.getPersistenceFailure()?.unsavedMessages.map((message) => userText(message) ?? message.role);

test("a command that starts no run keeps what the stopped run could not save (#5135)", async () => {
	const { harness, store, sessionId } = await conflictStoppedSession();
	const stored = (await storedEntries(store, sessionId)).length;
	harness.session.refreshContext();

	await harness.session.prompt("/noop");

	assert.deepEqual(unsavedKinds(harness), ["continue", "system"]);
	assert.deepEqual(
		harness.session.getUnsavedInput()?.messages.map((message) => userText(message)),
		["continue"],
	);
	assert.equal((await storedEntries(store, sessionId)).length, stored);
	harness.session.discardUnsavedInput();
	assert.equal(harness.session.getUnsavedInput(), undefined, "the user can discard it");
});

test("one input sent again and again while refused is kept and shown once (#5135)", async () => {
	const { harness } = await conflictStoppedSession();
	const card = { customType: "notice", content: "the workflow finished", display: true };
	for (let attempt = 0; attempt < 20; attempt++) {
		await assert.rejects(
			harness.session.sendCustomMessage(card, { excludeFromContext: true, stageAdmissionKey: "notice-1" }),
			SessionConflictError,
		);
	}
	assert.equal(
		harness.events.filter(
			(event) =>
				event.type === "message_end" && event.message.role === "custom" && event.message.customType === "notice",
		).length,
		1,
	);
	assert.deepEqual(unsavedKinds(harness), ["continue", "custom", "system"]);
	const kept = harness.session.getUnsavedInput()?.messages.filter((message) => message.role === "custom");
	assert.equal(kept?.length, 1);
});

test("an input saved once it is sent again settles every refused copy of it (#5135)", async () => {
	const { harness } = await conflictStoppedSession();
	const card = { customType: "notice", content: "the workflow finished", display: true };
	for (let attempt = 0; attempt < 20; attempt++) {
		await assert.rejects(
			harness.session.sendCustomMessage(card, { excludeFromContext: true, stageAdmissionKey: "notice-1" }),
			SessionConflictError,
		);
	}

	await harness.session.prompt("/noop");
	await harness.session.sendCustomMessage(card, { excludeFromContext: true, stageAdmissionKey: "notice-1" });

	assert.deepEqual(unsavedKinds(harness), ["continue", "system"]);
});

test("unsaved input is kept up to its limit, and what was dropped is reported (#5135)", async () => {
	const { harness } = await conflictStoppedSession();
	const extra = 3;
	for (let index = 0; index < MAX_RETAINED_UNSAVED_INPUTS + extra; index++) {
		await assert.rejects(
			harness.session.sendCustomMessage(
				{ customType: "note", content: `note ${index}`, display: true },
				{ excludeFromContext: true },
			),
			SessionConflictError,
		);
	}
	const unsaved = harness.session.getUnsavedInput();
	assert.equal(unsaved?.messages.length, MAX_RETAINED_UNSAVED_INPUTS);
	assert.equal(unsaved?.dropped, extra + 1, "the oldest, the prompt and the first notes, are dropped");
	assert.equal(harness.session.getPersistenceFailure()?.droppedUnsavedMessages, extra + 1);
	assert.equal(
		unsaved?.messages.at(-1)?.role === "custom" ? unsaved.messages.at(-1)?.content : undefined,
		`note ${MAX_RETAINED_UNSAVED_INPUTS + extra - 1}`,
	);
});

test("a prompt sent again and again while another writer's entries stop each run is shown once (#5135)", async () => {
	const store = new MemorySessionStore();
	const earlier = await SessionManager.create(store, process.cwd());
	await earlier.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
	const sessionId = earlier.getSessionId();
	const harness = await createHarness({ sessionManager: await SessionManager.open(store, sessionId) });
	harnesses.push(harness);
	const otherProcess = await SessionManager.open(store, sessionId);
	const repeated = "repeated unsaved input";
	for (let attempt = 0; attempt < 20; attempt++) {
		await otherProcess.appendMessage({ role: "user", content: `other ${attempt}`, timestamp: Date.now() });
		harness.setResponses([fauxAssistantMessage("never requested")]);
		await harness.session.prompt(repeated);
		assert.ok(harness.session.getPersistenceFailure()?.conflict instanceof SessionConflictError);
	}

	const shown = harness.events.filter(
		(event) =>
			event.type === "message_start" && event.message.role === "user" && userText(event.message) === repeated,
	);
	assert.equal(shown.length, 1);
	assert.equal(harness.session.messages.filter((message) => userText(message) === repeated).length, 1);
	assert.equal(harness.session.getUnsavedInput()?.messages.length, 1);
});
