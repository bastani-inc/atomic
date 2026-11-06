import assert from "node:assert/strict";
import { test } from "vitest";
import { findTaskEvictedError, isTaskEvictedError, TaskEvictedError } from "../src/core/tasks/eviction-error.js";
import {
	isTaskToolError,
	rehydrateTaskToolError,
	TaskToolError,
	type TaskToolFailureCode,
} from "../src/core/tools/shell-task-status.js";
import * as atomic from "../src/index.js";

const taskId = "task-1-0-9";

function failure(code: TaskToolFailureCode, message: string = code): TaskToolError {
	return new TaskToolError({ code, message }, taskId);
}

test("a TaskToolError carries its code, task, hint and retryability; only a stale task list is retryable (#4374)", () => {
	const unknown = failure("UnknownTask");
	const stale = failure("StaleGeneration");
	const closing = failure("EnvironmentClosing");

	assert.deepEqual(
		[unknown.name, unknown.code, unknown.fields, unknown.taskId, unknown.retryable],
		["TaskToolError", "UnknownTask", { taskId }, taskId, false],
	);
	assert.equal(
		unknown.hint,
		"It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
	);
	assert.deepEqual([stale.retryable, stale.hint], [true, "Try again."]);
	assert.deepEqual([closing.retryable, closing.hint], [false, undefined]);
});

test("a TaskToolError's serialized form carries its hint, fields, retryability and its cause chain (#4374)", () => {
	const evicted = failure("TaskEvicted");
	const unknown = failure("UnknownTask");

	const copied = JSON.parse(JSON.stringify(evicted));
	assert.deepEqual(copied, {
		name: "TaskToolError",
		code: "TaskEvicted",
		message: evicted.message,
		hint: evicted.hint,
		retryable: false,
		fields: { taskId },
		cause: { name: "TaskEvictedError", code: "task_evicted", message: (evicted.cause as Error).message },
	});
	assert.equal("cause" in unknown.toJSON(), false);
	assert.equal("hint" in failure("EnvironmentClosing").toJSON(), false);
});

test("isTaskToolError matches the class and its structural copy, and nothing else (#4374)", () => {
	const error = failure("ScopeMismatch");
	const copied = JSON.parse(JSON.stringify(error));

	assert.equal(isTaskToolError(error), true);
	assert.equal(isTaskToolError(copied), true);
	for (const other of [
		{ ...copied, name: "Error" },
		{ ...copied, code: "task_evicted" },
		new TaskEvictedError({ taskId }),
		new Error(error.message),
		"TaskToolError",
		undefined,
		null,
	])
		assert.equal(isTaskToolError(other), false, JSON.stringify(other));
});

test("a TaskToolError that crossed a process boundary rehydrates into the class with its fields and cause (#4374)", () => {
	const evicted = failure("TaskEvicted");
	const cleanup = failure("CleanupFailed", "the process group did not exit");

	const rehydrated = rehydrateTaskToolError(JSON.parse(JSON.stringify(evicted)));
	const rehydratedCleanup = rehydrateTaskToolError(JSON.parse(JSON.stringify(cleanup)));

	assert.ok(rehydrated instanceof TaskToolError);
	assert.equal(isTaskToolError(rehydrated), true);
	assert.deepEqual(
		[rehydrated.code, rehydrated.fields, rehydrated.message, rehydrated.hint, rehydrated.retryable],
		["TaskEvicted", { taskId }, evicted.message, evicted.hint, false],
	);
	assert.ok(isTaskEvictedError(rehydrated.cause));
	assert.equal(findTaskEvictedError(rehydrated)?.taskId, taskId);
	assert.ok(rehydratedCleanup instanceof TaskToolError);
	assert.equal(rehydratedCleanup.message, cleanup.message);
	assert.match(rehydratedCleanup.message, /the process group did not exit/);
});

test("a malformed TaskToolError copy does not rehydrate (#4374)", () => {
	const copied = JSON.parse(JSON.stringify(failure("UnknownTask")));

	for (const malformed of [
		{ ...copied, fields: undefined },
		{ ...copied, fields: { taskId: 9 } },
		{ ...copied, code: "NoSuchCode" },
		{ ...copied, name: "Error" },
		"UnknownTask",
		undefined,
	])
		assert.equal(rehydrateTaskToolError(malformed), undefined, JSON.stringify(malformed));
	assert.equal(rehydrateTaskToolError({ ...copied, message: 7 })?.message, failure("UnknownTask").message);
	const cleanup = JSON.parse(JSON.stringify(failure("CleanupFailed", "the process group did not exit")));
	assert.equal(
		rehydrateTaskToolError({ ...cleanup, message: undefined })?.message,
		`CleanupFailed: Could not stop task "${taskId}"`,
	);
});

test("the task tool error is exported from @bastani/atomic (#4374)", () => {
	assert.deepEqual(
		[atomic.TaskToolError, atomic.isTaskToolError, atomic.rehydrateTaskToolError],
		[TaskToolError, isTaskToolError, rehydrateTaskToolError],
	);
});
