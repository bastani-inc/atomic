import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { persistedManager } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

/** Bound on the 1 ms waits for disposal to stop the running turn. */
const STOP_TURNS = 5_000;
const NOTICE = { customType: "subagent-notify", content: "child finished", display: true } as const;

/** A tool that runs until its turn is aborted, so the session is streaming while the notice arrives. */
function runsUntilAborted(): { readonly tool: AgentTool; readonly started: Promise<void> } {
	let started!: () => void;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Waits until the turn is aborted",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			started();
			await new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { content: [{ type: "text", text: "stopped" }], details: {} };
		},
	};
	return { tool, started: running };
}

test("a protected notice still being saved when its session is disposed is left for the next session to deliver (#5377)", async () => {
	const { manager, store } = await persistedManager();
	const { tool, started } = runsUntilAborted();
	const harness = await createHarness({ tools: [tool], sessionManager: manager });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
	const prompt = harness.session.prompt("wait for the child");
	void prompt.catch(() => {});
	await started;

	// Hold the notice's card save until disposal has begun.
	const append = manager.appendCustomMessageEntry.bind(manager);
	let saveStarted!: () => void;
	const saving = new Promise<void>((resolve) => {
		saveStarted = resolve;
	});
	let releaseSave!: () => void;
	const saveReleased = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	manager.appendCustomMessageEntry = (async (...args: Parameters<typeof append>) => {
		saveStarted();
		await saveReleased;
		return append(...args);
	}) as typeof manager.appendCustomMessageEntry;
	const sent = harness.session.sendCustomMessage(NOTICE, { triggerTurn: true, persistWhenStreaming: true });
	await saving;

	// Disposal stops the turn first; the save finishes only after that, as a slow save does.
	const disposed = harness.session.dispose();
	void disposed.catch(() => {});
	for (let turn = 0; harness.session.isStreaming && turn < STOP_TURNS; turn++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(harness.session.isStreaming, false, "disposal stopped the turn");
	releaseSave();
	await sent;
	await disposed;
	await prompt.catch(() => {});

	const reopened = await createHarness({ sessionManager: await SessionManager.open(store, manager.getSessionId()) });
	harnesses.push(reopened);
	reopened.setResponses([fauxAssistantMessage("noted the child's result")]);
	const recovery = await reopened.session.startPendingRecovery("resume");
	assert.equal(recovery.replayed, 1, "the next session delivers the notice the disposed session could not");
});
