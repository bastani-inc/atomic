import assert from "node:assert/strict";
import { test } from "vitest";
import { isRecordedCheckpointValue } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";

/** An inspection-only tool failure record as a pooled attempt writes it, at the given time. */
function toolFailure(at: number, error = "Worker exited before delivery acknowledgement"): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: "root",
		checkpointId: "workflow:child:1:tool-failure:h1:cp-1",
		name: "deliver",
		args: {},
		argsHash: "h1",
		output: null,
		throwingFailureError: error,
		completedAt: at,
		topology: { version: 1, nodeId: "tool:h1", ordinal: 1, order: 1, parentIds: [], startedAt: at - 5, endedAt: at },
	};
}

test("a replayed attempt that records the same tool failure again keeps the first record, whatever its times", () => {
	assert.equal(isRecordedCheckpointValue(toolFailure(1_000), toolFailure(2_000)), true);
});

test("a checkpoint recorded again with another value, or with a time the first did not have, still conflicts", () => {
	assert.equal(isRecordedCheckpointValue(toolFailure(1_000), toolFailure(2_000, "another failure")), false);
	const first = toolFailure(1_000);
	const untimed: DurableToolCheckpoint = { ...first, topology: { ...first.topology!, endedAt: undefined } };
	assert.equal(isRecordedCheckpointValue(JSON.parse(JSON.stringify(untimed)), toolFailure(2_000)), false);
});
