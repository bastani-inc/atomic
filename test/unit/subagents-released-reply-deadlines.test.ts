import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type AgentWake,
	type AgentWakeClock,
	AgentWakeDispatcher,
} from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import {
	releasedReplyTimeoutId,
	scheduleReleasedReplyTimeouts,
	withReleasedReplyTimeouts,
} from "../../packages/subagents/src/runs/foreground/released-child-replies.js";
import type { SubagentChildWaitingCall } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

const ASK: SubagentChildWaitingCall = {
	toolCallId: "ask-1",
	toolName: "intercom",
	replyWait: { questionId: "question-1", deadline: 5_000, from: "peer", retryCount: 2 },
};

function handClock() {
	let now = 0;
	let callback: (() => void) | undefined;
	const clock: AgentWakeClock = {
		now: () => now,
		setTimer: (next) => {
			callback = next;
			return {};
		},
		clearTimer: () => {
			callback = undefined;
		},
	};
	return {
		clock,
		advanceTo(ms: number) {
			now = ms;
			const fire = callback;
			callback = undefined;
			fire?.();
		},
	};
}

test("a released asker's deadline waits in the dispatcher as a plain wake with no result of its own (#4326)", async () => {
	const time = handClock();
	const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
	const delivered: AgentWake[] = [];
	dispatcher.handle("subagents", async (_key, wakes) => {
		delivered.push(...wakes);
	});

	scheduleReleasedReplyTimeouts(dispatcher, "subagents:owner:child", [ASK]);
	assert.equal(dispatcher.stats().scheduled, 1);
	time.advanceTo(5_000);
	await dispatcher.whenIdle();

	assert.deepEqual(delivered, [{ id: releasedReplyTimeoutId("question-1"), kind: "tool-result" }]);
});

test("the timeout result of a fired deadline is built from the child's record for the call that asked (#4326)", () => {
	const [wake] = withReleasedReplyTimeouts({ waitingOn: [ASK], heldToolResults: [] }, [
		{ id: releasedReplyTimeoutId("question-1"), kind: "tool-result" },
	]);

	assert.equal(wake?.toolResult?.toolCallId, "ask-1");
	assert.equal(wake?.toolResult?.toolName, "intercom");
	assert.equal(wake?.toolResult?.isError, true);
	assert.deepEqual(wake?.toolResult?.result.details, {
		releasedIntercomTimeout: { from: "peer", retryCount: 2 },
	});
});

test("a deadline whose call was already answered, or whose question the child no longer waits on, is dropped (#4326)", () => {
	const deadline: AgentWake = { id: releasedReplyTimeoutId("question-1"), kind: "tool-result" };
	const answered = {
		toolCallId: "ask-1",
		toolName: "intercom",
		result: { content: [], details: undefined },
		isError: false,
	};

	assert.deepEqual(withReleasedReplyTimeouts({ waitingOn: [ASK], heldToolResults: [answered] }, [deadline]), []);
	assert.deepEqual(withReleasedReplyTimeouts({ waitingOn: [], heldToolResults: [] }, [deadline]), []);
});

test("a wake that is not a deadline passes through unchanged and in order (#4326)", () => {
	const result = {
		toolCallId: "tool-1",
		toolName: "wait",
		result: { content: [], details: undefined },
		isError: false,
	};
	const wakes: AgentWake[] = [
		{ id: "intercom:1", kind: "intercom" },
		{ id: releasedReplyTimeoutId("question-1"), kind: "tool-result" },
		{ id: "tool-result:tool-1", kind: "tool-result", toolResult: result },
	];

	const resolved = withReleasedReplyTimeouts({ waitingOn: [ASK] }, wakes);

	assert.deepEqual(
		resolved.map((wake) => wake.id),
		wakes.map((wake) => wake.id),
	);
	assert.equal(resolved[0], wakes[0]);
	assert.equal(resolved[2], wakes[2]);
});
