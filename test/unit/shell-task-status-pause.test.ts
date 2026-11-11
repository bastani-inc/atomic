import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { taskResultStatus, waitResultTail } from "../../packages/coding-agent/src/core/tools/shell-task-status.js";

test("a shell stopped by a pause reads as stopped by a pause, never as paused and awaiting resume (#3996)", () => {
	const result = { kind: "cancelled", cause: "pause" } as const;
	const status = taskResultStatus(result);
	assert.equal(status.detail, "stopped by a pause");
	const tail = waitResultTail({
		observation: { kind: "settled", taskId: "task-7" as TaskId, result },
		truncated: false,
	});
	assert.match(tail, /Task task-7 was cancelled \(stopped by a pause\)\./);
	assert.doesNotMatch(`${status.detail} ${tail}`, /awaiting resume/);
});

test("a wait on a shell its execution timeout stopped names the timeout's length (#4639)", () => {
	const result = { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 1_000 } as const;
	assert.equal(taskResultStatus(result).detail, "timed out after 1 second");
	const tail = waitResultTail({
		observation: { kind: "settled", taskId: "task-7" as TaskId, result },
		truncated: false,
	});
	assert.match(tail, /Task task-7 was cancelled \(timed out after 1 second\)\./);
});

test.each([
	["session-close", "session closed"],
	["stage-close", "workflow stage closed"],
	["app-shutdown", "Atomic shut down"],
] as const)("a wait on a shell its owner's %s cancelled names that close (#4639)", (ownerClose, reason) => {
	const result = { kind: "cancelled", cause: "owner-close", ownerClose } as const;
	assert.equal(taskResultStatus(result).detail, reason);
	const tail = waitResultTail({
		observation: { kind: "settled", taskId: "task-7" as TaskId, result },
		truncated: false,
	});
	assert.ok(tail.endsWith(`Task task-7 was cancelled (${reason}).`), tail);
});
