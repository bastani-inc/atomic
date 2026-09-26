import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import {
	retainedTaskOutput,
	retainTaskOutput,
} from "../../packages/subagents/src/runs/foreground/task-output-retention.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

const child: SingleResult = {
	agent: "fake",
	task: "report",
	status: "ok",
	messages: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

test("evicting a retained task output deletes its private copy (#3294)", () => {
	const owner = `owner-eviction-${process.pid}`;
	retainTaskOutput(child, "first", { ownerId: owner, taskId: "task-0" });
	const firstCopy = retainedTaskOutput(owner, "task-0")?.path;
	assert.ok(firstCopy && existsSync(firstCopy));

	for (let index = 1; index <= 256; index++) {
		retainTaskOutput(child, `output ${index}`, { ownerId: owner, taskId: `task-${index}` });
	}

	assert.equal(retainedTaskOutput(owner, "task-0"), undefined);
	assert.equal(existsSync(firstCopy), false);
	const latestCopy = retainedTaskOutput(owner, "task-256")?.path;
	assert.ok(latestCopy && existsSync(latestCopy));
});
