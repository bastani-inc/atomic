/**
 * What the session's event pipeline saves (#4309): the messages of a run, never a kind of message that is saved where
 * it is produced.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, test } from "vitest";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

interface EventPipeline {
	_handleAgentEvent(event: AgentEvent): unknown;
	readonly _agentEventQueue: Promise<void>;
}

async function savedEntriesAfter(harness: Harness, event: AgentEvent): Promise<number> {
	const pipeline = harness.session as unknown as EventPipeline;
	const before = harness.sessionManager.getEntries().length;
	await pipeline._handleAgentEvent(event);
	await pipeline._agentEventQueue;
	return harness.sessionManager.getEntries().length - before;
}

test("a user message that ends is saved, and a bash execution record is not saved by the pipeline (#4309)", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	const bash: BashExecutionMessage = {
		role: "bashExecution",
		command: "echo hi",
		output: "hi",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	};

	const bashSaved = await savedEntriesAfter(harness, { type: "message_end", message: bash });
	const userSaved = await savedEntriesAfter(harness, {
		type: "message_end",
		message: { role: "user", content: "hello", timestamp: Date.now() },
	});

	assert.equal(bashSaved, 0);
	assert.equal(userSaved, 1);
});

describe("a tool result whose call's message could not be saved (#4226)", () => {
	interface FailureState extends EventPipeline {
		_persistenceFailure: string | undefined;
		readonly _messagesWithFailedPersistence: WeakSet<object>;
	}

	const callTurn = (toolCallId: string) =>
		fauxAssistantMessage([fauxToolCall("noop", {}, { id: toolCallId })], { stopReason: "toolUse" });

	const resultFor = (toolCallId: string): ToolResultMessage => ({
		role: "toolResult",
		toolCallId,
		toolName: "noop",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
	});

	/** How many entries the result of call "x" adds to a session whose transcript is `transcript`. */
	async function savedFor(options: {
		readonly transcript: AgentMessage[];
		readonly unsaved: AgentMessage[];
		readonly failure?: string;
	}): Promise<number> {
		const harness = await createHarness();
		harnesses.push(harness);
		const state = harness.session as unknown as FailureState;
		harness.session.agent.state.messages = options.transcript;
		for (const message of options.unsaved) state._messagesWithFailedPersistence.add(message);
		state._persistenceFailure = options.failure;
		return savedEntriesAfter(harness, { type: "message_end", message: resultFor("x") });
	}

	const unsaved = callTurn("x");
	const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });

	test("is not saved, so no result is ahead of its call (#4226)", async () => {
		assert.equal(await savedFor({ transcript: [user("go"), unsaved], unsaved: [unsaved], failure: "unsaved" }), 0);
	});

	test("is not saved when its call's message is the first of the transcript (#4226)", async () => {
		assert.equal(await savedFor({ transcript: [unsaved], unsaved: [unsaved], failure: "unsaved" }), 0);
	});

	test("is not saved when other messages came after its call's message (#4226)", async () => {
		const later = fauxAssistantMessage("a later reply");
		const transcript = [unsaved, user("a later question"), later];

		assert.equal(await savedFor({ transcript, unsaved: [unsaved], failure: "unsaved" }), 0);
	});

	test("is saved when the message that holds its call was saved, even if the last assistant message was not (#4226)", async () => {
		const saved = callTurn("x");
		const lost = fauxAssistantMessage("a reply that could not be saved");

		assert.equal(await savedFor({ transcript: [user("go"), saved, lost], unsaved: [lost], failure: "unsaved" }), 1);
	});

	test("is saved when no message holds its call (#4226)", async () => {
		const other = callTurn("y");

		assert.equal(await savedFor({ transcript: [user("go"), other], unsaved: [other], failure: "unsaved" }), 1);
	});

	test("is saved when the run that failed to save has ended: the next run tries again (#4226)", async () => {
		assert.equal(await savedFor({ transcript: [user("go"), unsaved], unsaved: [unsaved], failure: undefined }), 1);
	});
});
