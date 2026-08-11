import assert from "node:assert/strict";
import { test } from "vitest";
import {
	emitWorkflowControlIntercom,
	emitWorkflowResultIntercom,
} from "../../packages/workflows/src/intercom/result-intercom.js";
import type { WorkflowDetails } from "../../packages/workflows/src/shared/types.js";

test("intercom result deliveries preserve intentional failed status, reason, and outputs", () => {
	const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
	const port = {
		emit(event: string, payload: Record<string, unknown>): void {
			events.push({ event, payload });
		},
	};
	const details: WorkflowDetails = {
		mode: "inspection",
		runId: "run-failed-exit",
		status: "failed",
		exited: true,
		exitReason: "all candidates rejected",
		output: { attempted: 3 },
	};

	assert.equal(
		emitWorkflowControlIntercom(port, details, "workflow failed intentionally", {
			delivery: "control-and-result",
		}),
		true,
	);
	assert.equal(emitWorkflowResultIntercom(port, details, { delivery: "control-and-result" }), true);

	assert.deepEqual(
		{
			event: events[0]?.event,
			status: events[0]?.payload.status,
			exited: events[0]?.payload.exited,
			exitReason: events[0]?.payload.exitReason,
			outputs: events[0]?.payload.outputs,
		},
		{
			event: "workflow:control-intercom",
			status: "failed",
			exited: true,
			exitReason: "all candidates rejected",
			outputs: { attempted: 3 },
		},
	);
	assert.equal(events[1]?.event, "workflow:result-intercom");
	assert.equal(events[1]?.payload.status, "failed");
	assert.deepEqual(events[1]?.payload.details, details);
	assert.equal(events[1]?.payload.exited, undefined);
	assert.equal(events[1]?.payload.exitReason, undefined);
	assert.equal(events[1]?.payload.outputs, undefined);
});
