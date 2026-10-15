import assert from "node:assert/strict";
import { test } from "vitest";
import { parseWorkflowChildResult } from "../../packages/workflows/src/durable/workflow-child-result.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

test("WorkflowChildResult parser accepts only the exact completed/exited discriminated union", () => {
	const identity = { workflow: "child", runId: "child-run", outputs: {} } as const;
	assert.ok(parseWorkflowChildResult({ ...identity, status: "completed", exited: false }));
	for (const status of ["completed", "skipped", "cancelled", "blocked", "failed"] as const) {
		assert.ok(parseWorkflowChildResult({ ...identity, status, exited: true, exitReason: "reason" }), status);
	}
	for (const malformed of [
		{ ...identity, status: "failed", exited: false },
		{ ...identity, status: "skipped", exited: false },
		{ ...identity, status: "completed", exited: false, exitReason: "not-allowed" },
	] as const)
		assert.equal(parseWorkflowChildResult(malformed), undefined);
	for (const [workflow, runId] of [
		["", ""],
		["  workflow:\nverbatim  ", "run::id/with spaces"],
		["工作流", "🧵"],
	] as const) {
		const value = { workflow, runId, outputs: {}, status: "completed", exited: false } as const;
		assert.equal(parseWorkflowChildResult(value), value, `${JSON.stringify(workflow)} / ${JSON.stringify(runId)}`);
	}
	const exoticOutputs = Object.create({ inherited: true }) as Record<string, WorkflowSerializableValue>;
	assert.equal(
		parseWorkflowChildResult({ ...identity, status: "completed", exited: false, outputs: exoticOutputs }),
		undefined,
	);
});
