import assert from "node:assert/strict";
import { test } from "vitest";
import { isRetryableTaskError } from "../../packages/coding-agent/src/core/tasks/cleanup-error.js";
import {
	FINISHED_TASK_RETENTION,
	isTaskEvictedError,
	rehydrateTaskEvictedError,
	TaskEvictedError,
} from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { presentTaskError, TaskToolError } from "../../packages/coding-agent/src/core/tools/shell-task-status.js";
import * as atomic from "../../packages/coding-agent/src/index.js";

const taskId = "task-1-0-7";

test("TaskEvictedError carries its code, task, retention and hint, and renders them once (#4385)", () => {
	const cause = new Error("native refusal");
	const error = new TaskEvictedError({ taskId }, { cause });
	assert.ok(error instanceof Error);
	assert.equal(error.name, "TaskEvictedError");
	assert.equal(error.code, "task_evicted");
	assert.equal(error.retryable, false);
	assert.equal(error.taskId, taskId);
	assert.equal(error.retainedFinishedTasks, FINISHED_TASK_RETENTION);
	assert.equal(error.cause, cause);
	assert.equal(FINISHED_TASK_RETENTION, 256);
	assert.equal(
		error.message,
		"Finished task is no longer kept: task-1-0-7 (task_evicted). Only the 256 most recently finished tasks of a " +
			"session or workflow stage are kept. Its result stays where the conversation reported it and a subagent's " +
			"transcript stays in its own saved session, but a shell command's full output is no longer available.",
	);
	assert.equal(error.message, `Finished task is no longer kept: ${taskId} (task_evicted). ${error.hint}.`);
	assert.match(new TaskEvictedError({ taskId, retainedFinishedTasks: 3 }).hint, /^Only the 3 most recently /);
	assert.equal(isRetryableTaskError(error), false);
});

test("isTaskEvictedError matches the class and its structural copy from another realm, and nothing else (#4385)", () => {
	const error = new TaskEvictedError({ taskId });
	assert.equal(isTaskEvictedError(error), true);
	const copied = JSON.parse(JSON.stringify(error));
	assert.equal(isTaskEvictedError(copied), true);
	assert.equal(isTaskEvictedError(Object.assign(new TaskEvictedError({ taskId }), { name: "Renamed" })), true);
	for (const other of [
		{ ...copied, name: "Error" },
		{ ...copied, code: "task_cleanup_unconfirmed" },
		new Error(error.message),
		"TaskEvictedError",
		undefined,
		null,
		7,
	])
		assert.equal(isTaskEvictedError(other), false, JSON.stringify(other));
});

test("a TaskEvictedError copy that crossed a process boundary rehydrates into the class, and a malformed one does not (#4385)", () => {
	const error = new TaskEvictedError({ taskId, retainedFinishedTasks: 12 });
	const copied = JSON.parse(JSON.stringify(error));
	assert.deepEqual(copied, {
		name: "TaskEvictedError",
		code: "task_evicted",
		retryable: false,
		hint: error.hint,
		taskId,
		retainedFinishedTasks: 12,
	});
	const rehydrated = rehydrateTaskEvictedError(copied);
	assert.ok(rehydrated instanceof TaskEvictedError);
	assert.equal(isTaskEvictedError(rehydrated), true);
	assert.equal(rehydrated.taskId, taskId);
	assert.equal(rehydrated.retainedFinishedTasks, 12);
	assert.equal(rehydrated.message, error.message);
	assert.equal(rehydrated.hint, error.hint);
	for (const malformed of [
		{ ...copied, taskId: 7 },
		{ ...copied, taskId: undefined },
		{ ...copied, retainedFinishedTasks: 0 },
		{ ...copied, retainedFinishedTasks: 1.5 },
		{ ...copied, retainedFinishedTasks: "12" },
		{ ...copied, retainedFinishedTasks: undefined },
		{ ...copied, code: "task_missing" },
		undefined,
	])
		assert.equal(rehydrateTaskEvictedError(malformed), undefined, JSON.stringify(malformed));
	assert.equal(rehydrateTaskEvictedError({ ...copied, retainedFinishedTasks: 1 })?.retainedFinishedTasks, 1);
});

test("a wait or kill on an evicted task fails with a plain headline, a hint, and a TaskEvictedError cause (#4385)", () => {
	const error = new TaskToolError({ code: "TaskEvicted", message: "TaskEvicted" }, taskId);
	assert.equal(error.code, "TaskEvicted");
	assert.equal(error.message, `TaskEvicted: Task "${taskId}" finished and is no longer kept in this session`);
	assert.ok(isTaskEvictedError(error.cause));
	assert.equal(error.cause.taskId, taskId);
	assert.deepEqual(presentTaskError(error.message, taskId), {
		headline: `Task "${taskId}" finished and is no longer kept in this session`,
		hint: "Only the most recently finished tasks are kept. Its result is where the conversation reported it.",
	});
	assert.equal(new TaskToolError({ code: "UnknownTask", message: "UnknownTask" }, taskId).cause, undefined);
});

test("the task eviction error family is exported from @bastani/atomic (#4385)", () => {
	assert.equal(atomic.TaskEvictedError, TaskEvictedError);
	assert.equal(atomic.isTaskEvictedError, isTaskEvictedError);
	assert.equal(atomic.rehydrateTaskEvictedError, rehydrateTaskEvictedError);
	assert.equal(atomic.FINISHED_TASK_RETENTION, FINISHED_TASK_RETENTION);
});
