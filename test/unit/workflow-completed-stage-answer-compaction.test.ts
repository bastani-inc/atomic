import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession, AgentSessionEventListener } from "../../packages/coding-agent/src/core/agent-session.js";
import { collectTurnReply } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import { assistantMessageWithUsage } from "./stage-runner-helpers.js";

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const SAVED_CONVERSATION_LENGTH = 13;

test("a released stage's ask returns the reply even when compaction shortens the conversation mid-turn (#3622)", async () => {
	const listeners = new Set<AgentSessionEventListener>();
	const handle = {
		messages: Array.from({ length: SAVED_CONVERSATION_LENGTH }, (_, index) =>
			assistantMessageWithUsage(`earlier turn ${index}`, NO_USAGE),
		) as AgentSession["messages"],
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt() {
			const reply = assistantMessageWithUsage("the review touched src/run.ts", NO_USAGE);
			handle.messages = [assistantMessageWithUsage("summary of earlier turns", NO_USAGE), reply];
			for (const listener of listeners) listener({ type: "message_end", message: reply });
		},
	};
	const lengthBeforeTurn = handle.messages.length;

	const reply = await collectTurnReply(handle, "which file did you review?");

	assert.ok(handle.messages.length < lengthBeforeTurn, "the scenario compacts below the pre-turn length");
	assert.equal(reply, "the review touched src/run.ts");
	assert.equal(listeners.size, 0, "the turn's listener is removed");
});

test("a released stage's ask reports no reply when the turn says nothing (#3622)", async () => {
	const handle = {
		subscribe: (_listener: AgentSessionEventListener) => () => {},
		prompt: async () => {},
	};
	assert.equal(await collectTurnReply(handle, "anything?"), undefined);
});
