import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	RELEASED_CHILD_REPLY_EVENT,
	type ReleasedChildReplyRequest,
} from "../../packages/intercom/released-reply-wait.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

test("an owner saves a released child's reply before accepting it, and refuses a duplicate (#4326)", async () => {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as never;
	const events = createEventBus();
	let appends = 0;
	const pi = {
		events,
		async appendEntry<T>(type: string, data?: T) {
			appends++;
			await sessionManager.appendCustomEntry(type, data);
		},
	};
	const sink = createSubagentChildRecordSink(pi, ctx);
	sink.record({
		runId: "run",
		index: 0,
		agent: "worker",
		cwd: "/repo",
		state: "terminal",
		terminalStatus: "paused",
		intercomTarget: "child",
		waitingOn: [
			{
				toolCallId: "call-1",
				toolName: "intercom",
				replyWait: { questionId: "q-1", deadline: Date.now() + 60_000, from: "peer" },
			},
		],
	});
	await sink.flushed?.();
	const dispatcher = new AgentWakeDispatcher();
	const stop = bindReleasedChildWakes({ pi } as never, ctx, events, dispatcher);
	assert.equal(dispatcher.stats().scheduled, 1);
	const request: ReleasedChildReplyRequest = {
		childName: "child",
		replyTo: "q-1",
		message: { id: "reply-1", timestamp: 1, replyTo: "q-1", content: { text: "answer" } },
	};
	events.emit(RELEASED_CHILD_REPLY_EVENT, request);
	assert.ok(request.completion);
	assert.equal(await request.completion, true);
	assert.equal(dispatcher.stats().scheduled, 0);
	assert.deepEqual(
		readSubagentChildRecords(sessionManager.getEntries()).get("run:0")?.heldToolResults?.[0]?.result.details,
		{ releasedIntercomReply: { replyTo: "q-1", text: "answer" } },
	);
	const count = appends;
	const duplicate: ReleasedChildReplyRequest = { ...request, completion: undefined };
	events.emit(RELEASED_CHILD_REPLY_EVENT, duplicate);
	assert.equal(await duplicate.completion, false);
	assert.equal(appends, count);
	await dispatcher.whenIdle();
	stop();
});
