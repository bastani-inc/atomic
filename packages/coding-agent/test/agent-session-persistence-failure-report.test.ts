/** What a session reports about a run that stopped on a message it could not save (#5210). */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("a run whose final answer could not be saved reports the storage error and only that answer (#5210)", async () => {
	const sessionManager = SessionManager.inMemory();
	const append = sessionManager.appendMessage.bind(sessionManager);
	sessionManager.appendMessage = async (message) => {
		if (message.role === "assistant" && JSON.stringify(message.content).includes("second reply"))
			throw new Error("ENOSPC: no space left on device, write");
		return append(message);
	};
	const harness = await createHarness({ sessionManager });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

	await harness.session.prompt("first");
	assert.equal(harness.session.getPersistenceFailure(), undefined, "a run that saved everything reports nothing");

	await harness.session.prompt("second");
	const failure = harness.session.getPersistenceFailure();
	assert.match(failure?.error ?? "", /could not persist the assistant message: ENOSPC: no space left on device/);
	assert.deepEqual(
		failure?.unsavedMessages.map((message) => (message.role === "assistant" ? message.content : message.role)),
		[[{ type: "text", text: "second reply" }]],
	);
});

test("a prompt the session could not save stays reported after the context is refreshed (#5210, #5135)", async () => {
	const sessionManager = SessionManager.inMemory();
	const append = sessionManager.appendMessage.bind(sessionManager);
	sessionManager.appendMessage = async (message) => {
		if (message.role === "user" && JSON.stringify(message.content).includes("second"))
			throw new Error("ENOSPC: no space left on device, write");
		return append(message);
	};
	const harness = await createHarness({ sessionManager });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	const unsavedPrompts = () =>
		harness.session
			.getPersistenceFailure()
			?.unsavedMessages.filter((message) => message.role === "user")
			.map((message) => JSON.stringify(message.content));
	assert.equal(unsavedPrompts()?.length, 1);
	assert.match(unsavedPrompts()?.[0] ?? "", /second/);

	harness.session.refreshContext();

	assert.equal(unsavedPrompts()?.length, 1, "the unsaved prompt is still recoverable");
	assert.match(unsavedPrompts()?.[0] ?? "", /second/);
});
