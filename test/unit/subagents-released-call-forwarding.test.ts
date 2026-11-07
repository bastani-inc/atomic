import assert from "node:assert/strict";
import { test } from "vitest";
import type {
	DetachedToolCall,
	DetachedToolResult,
} from "../../packages/coding-agent/src/core/agent-session-detached-tools.js";
import { type AgentWake, AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import {
	releasedReplyTimeoutId,
	scheduleReleasedReplyTimeouts,
} from "../../packages/subagents/src/runs/foreground/released-child-replies.js";
import {
	forwardDetachedResults,
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import type { SubagentChildWaitingCall } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { drained } from "../helpers/wake-completion.js";

const ASK: SubagentChildWaitingCall = {
	toolCallId: "ask-1",
	toolName: "intercom",
	replyWait: { questionId: "question-1", deadline: Date.now() + 600_000, from: "peer" },
};

const answer: DetachedToolResult = {
	toolCallId: "ask-1",
	toolName: "intercom",
	result: { content: [{ type: "text", text: "yes" }], details: undefined },
	isError: false,
};

test("a released child's forwarding keeps the call's result and reply question, not the call, its controller or the child's waiting records (#4403)", async () => {
	const dispatcher = new AgentWakeDispatcher();
	const delivered: AgentWake[] = [];
	dispatcher.handle(subagentWakeNamespace("owner"), async (_key, wakes) => {
		delivered.push(...wakes);
	});
	const wakeKey = subagentWakeKey("owner", "run:0");
	const { promise: result, resolve: finish } = Promise.withResolvers<DetachedToolResult>();
	const tracked = trackCollection();
	(() => {
		const controller = new AbortController();
		const call: DetachedToolCall = {
			toolCallId: "ask-1",
			toolName: "intercom",
			result,
			abort: (reason) => controller.abort(reason),
		};
		const waitingOn: SubagentChildWaitingCall[] = [ASK, { toolCallId: "ci-2", toolName: "wait_for_ci" }];
		scheduleReleasedReplyTimeouts(dispatcher, wakeKey, waitingOn);
		forwardDetachedResults(dispatcher, wakeKey, [call], waitingOn);
		tracked.track(call);
		tracked.track(controller);
		tracked.track(waitingOn);
	})();
	assert.equal(dispatcher.stats().scheduled, 1, "the reply's deadline waits in the dispatcher");

	await collectEverythingTracked(tracked);
	assert.deepEqual(tracked.uncollected(), [], "nothing but the result's own promise is held for the call");

	finish(answer);
	await result;
	assert.equal(await drained(dispatcher), 0);
	assert.deepEqual(delivered, [{ id: "tool-result:ask-1", kind: "tool-result", toolResult: answer }]);
	assert.equal(dispatcher.stats().scheduled, 0, "the answer cancels the reply's deadline");
});

test("the result of a call that asked nothing leaves the reply deadline of the child's other call alone (#4403)", async () => {
	const dispatcher = new AgentWakeDispatcher();
	const delivered: AgentWake[] = [];
	dispatcher.handle(subagentWakeNamespace("owner"), async (_key, wakes) => {
		delivered.push(...wakes);
	});
	const wakeKey = subagentWakeKey("owner", "run:1");
	const ci: DetachedToolResult = { ...answer, toolCallId: "ci-2", toolName: "wait_for_ci" };
	const waitingOn: SubagentChildWaitingCall[] = [ASK, { toolCallId: "ci-2", toolName: "wait_for_ci" }];
	scheduleReleasedReplyTimeouts(dispatcher, wakeKey, waitingOn);
	const call: DetachedToolCall = {
		toolCallId: "ci-2",
		toolName: "wait_for_ci",
		result: Promise.resolve(ci),
		abort() {},
	};

	forwardDetachedResults(dispatcher, wakeKey, [call], waitingOn);
	await call.result;
	assert.equal(await drained(dispatcher), 0);

	assert.deepEqual(delivered, [{ id: "tool-result:ci-2", kind: "tool-result", toolResult: ci }]);
	assert.equal(dispatcher.stats().scheduled, 1, "the ask's deadline still waits");
	dispatcher.cancel(wakeKey, releasedReplyTimeoutId("question-1"));
});
