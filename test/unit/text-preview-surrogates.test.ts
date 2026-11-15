import assert from "node:assert/strict";
import { sliceHead } from "@bastani/atomic";
import { test } from "vitest";
import {
	summarizeSubagentTask,
	TASK_SUMMARY_LIMIT,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

test("sliceHead keeps at most the given UTF-16 units and backs off before a split pair (#5097)", () => {
	assert.equal(sliceHead("ab😀cd", 3), "ab");
	assert.equal(sliceHead("ab😀cd", 4), "ab😀");
	assert.equal(sliceHead("ab😀cd", 2), "ab");
	assert.equal(sliceHead("abc", 10), "abc");
	assert.equal(sliceHead("abc", 0), "");
});

test("a subagent task summary cut next to an emoji keeps no half of it (#5097)", () => {
	const task = `${"x".repeat(TASK_SUMMARY_LIMIT - 2)}😀 and more`;
	const summary = summarizeSubagentTask(task);
	assert.ok(summary.isWellFormed(), `lone surrogate in ${JSON.stringify(summary.slice(-4))}`);
	assert.equal(summary, `${"x".repeat(TASK_SUMMARY_LIMIT - 2)}…`);
});
