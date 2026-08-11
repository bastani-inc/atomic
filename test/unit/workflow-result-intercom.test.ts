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
		events.map(({ event, payload }) => ({
			event,
			status: payload.status,
			exited: payload.exited,
			exitReason: payload.exitReason,
			outputs: payload.outputs,
		})),
		[
			{
				event: "workflow:control-intercom",
				status: "failed",
				exited: true,
				exitReason: "all candidates rejected",
				outputs: { attempted: 3 },
			},
			{
				event: "workflow:result-intercom",
				status: "failed",
				exited: true,
				exitReason: "all candidates rejected",
				outputs: { attempted: 3 },
			},
		],
	);
});
