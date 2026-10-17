import assert from "node:assert/strict";
import { test } from "vitest";
import {
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelRunningCapacity,
} from "../../packages/subagents/src/shared/types-runtime.js";

test("subagent parallel concurrency defaults to three and explicit overrides win", () => {
	assert.equal(resolveTopLevelParallelConcurrency(undefined, undefined), 3);
	assert.equal(resolveTopLevelParallelConcurrency(undefined, 6), 6);
	assert.equal(resolveTopLevelParallelConcurrency(8, 6), 8);
	assert.equal(resolveTopLevelParallelConcurrency(1, 6), 1);
	assert.equal(resolveTopLevelParallelConcurrency(undefined, 100), 100);
	assert.equal(resolveTopLevelParallelConcurrency(100, 6), 100);
	for (const invalid of [0, -1, 1.5, NaN, "abc", null]) {
		assert.equal(resolveTopLevelParallelConcurrency(invalid, invalid), 3);
		assert.equal(resolveTopLevelParallelConcurrency(invalid, 100), 100);
	}
});

test("subagent running capacity defaults to four and honors positive integer configuration", () => {
	assert.equal(resolveTopLevelParallelRunningCapacity(undefined), 4);
	assert.equal(resolveTopLevelParallelRunningCapacity(100), 100);
	assert.equal(resolveTopLevelParallelRunningCapacity("100"), 100);
	for (const invalid of [0, -1, 1.5, NaN, "abc", null]) {
		assert.equal(resolveTopLevelParallelRunningCapacity(invalid), 4);
	}
});
