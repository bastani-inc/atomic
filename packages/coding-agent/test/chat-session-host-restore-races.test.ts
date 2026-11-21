import assert from "node:assert/strict";
import type { Component, EditorTheme } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { ClearedQueue } from "../src/core/agent-session-types.ts";
import { restoreQueuedMessagesToEditor } from "../src/modes/interactive/components/chat-session-host-actions.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import { createChatSessionSteering } from "../src/modes/interactive/components/chat-session-host-steering.ts";
import type {
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "../src/modes/interactive/components/chat-session-host-types.ts";

/**
 * Alt+Up in a chat that steers an agent: what the agent gives back goes to the reader, and the chat lists the agent's
 * queue as the agent last listed it, whatever arrives while the answer is on its way.
 */

const identity = (text: string): string => text;
const style: ChatSessionHostStyle = {
	dim: identity,
	text: identity,
	textMuted: identity,
	accent: identity,
	accentBold: identity,
	rule: (_hex, text) => text,
	cursor: () => "",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};
const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

/** A chat steering an agent whose queue holds `queued` and answers Alt+Up when `answer` is resolved. */
function steeredChat(queued: string[], overrides: Partial<ChatSessionHostOpts> = {}) {
	const answer = Promise.withResolvers<void>();
	const steering = {
		prompt: async () => {},
		clearQueue: async (): Promise<ClearedQueue> => {
			const taken = { steering: [...queued], followUp: [] };
			queued.length = 0;
			await answer.promise;
			return taken;
		},
	};
	const state = new ChatSessionHostState(
		{ style, editorTheme, isStreaming: () => true, steering, ...overrides },
		{
			renderEntry: (): Component => ({ render: () => [], invalidate: () => {} }),
			transcriptCacheKey: () => "",
		},
	);
	state.steeringController = createChatSessionSteering(state, steering);
	state.pendingSteeringMessages = ["first"];
	return { state, answer };
}

test("a message queued while Alt+Up's answer is on its way stays listed as the agent listed it", async () => {
	const { state, answer } = steeredChat(["first"]);
	restoreQueuedMessagesToEditor(state);
	// The agent took the first back and listed the one queued after it.
	state.pendingSteeringMessages = ["second"];
	answer.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(state.inputBuffer, "first");
	assert.deepEqual(state.pendingSteeringMessages, ["second"], "the newer listing is kept");
});

test("the same text queued again while Alt+Up's answer is on its way stays listed", async () => {
	const { state, answer } = steeredChat(["first"]);
	restoreQueuedMessagesToEditor(state);
	// The agent listed its queue again: another message with the same text, queued after the take.
	state.pendingSteeringMessages = ["first"];
	answer.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(state.inputBuffer, "first");
	assert.deepEqual(state.pendingSteeringMessages, ["first"], "the newer one is still listed");
});

test("messages Alt+Up takes back after the chat closed are kept for the reader's next draft", async () => {
	const kept: string[][] = [];
	const { state, answer } = steeredChat(["first"], { keepRestoredMessages: (messages) => kept.push([...messages]) });
	restoreQueuedMessagesToEditor(state);
	state.disposed = true;
	answer.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(kept, [["first"]], "taken back from the agent, so never dropped");
});
