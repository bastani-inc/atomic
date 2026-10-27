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
