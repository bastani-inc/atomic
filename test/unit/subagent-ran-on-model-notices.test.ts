/**
 * A child that ran on another model than its launch asked for says so wherever its result reaches the parent without a
 * task host: a detached or restored child's completion notice (#4188).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { notifyDetachedForegroundChildExit } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";
import { SUBAGENT_COMPLETE_EVENT } from "../../packages/subagents/src/shared/types.js";

function completionSummary(result: { model?: string; thinking?: string; requestedModel?: string }): string {
	const notices: { summary?: string }[] = [];
	const events = {
		on: () => () => {},
		emit(channel: string, data: unknown) {
			if (channel === SUBAGENT_COMPLETE_EVENT) notices.push(data as { summary?: string });
		},
	};
	notifyDetachedForegroundChildExit({
		pi: { events } as never,
		runId: "run",
		mode: "single",
		index: 0,
		result: {
			agent: "worker",
			task: "review",
			status: "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			finalOutput: "review findings",
			...result,
		},
	});
	assert.equal(notices.length, 1);
	return notices[0]!.summary ?? "";
}

test("a detached child's completion notice names the model it ran on beside the one its launch asked for", () => {
	const summary = completionSummary({
		model: "account-a/sol",
		thinking: "medium",
		requestedModel: "account-a/argon:high",
	});
	// Each model reads as its raw ID and level (#4269).
	assert.match(summary, /^Model: ran on account-a\/sol {2}medium, not the requested account-a\/argon {2}high\.$/m);
	assert.match(summary, /review findings/);
});

test("a detached child that ran on the model its launch asked for gets no model line", () => {
	const summary = completionSummary({ model: "account-a/argon", requestedModel: "account-a/argon:high" });
	assert.equal(summary, "review findings");
});
