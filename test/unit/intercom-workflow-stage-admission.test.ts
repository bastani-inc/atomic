import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { admitWorkflowStageInbound } from "../../packages/intercom/workflow-stage-admission.js";

const stageContext = {
	orchestrationContext: {
		kind: "workflow-stage" as const,
		workflowRunId: "run-1",
		workflowStageId: "stage-1",
		workflowStageName: "schema-review",
		constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 5 },
	},
};

describe("Intercom workflow-stage admission", () => {
	test("a message received during a schema-backed structured_output tool turn is surfaced synchronously", async () => {
		const events: string[] = ["structured_output:start"];
		const admitted = admitWorkflowStageInbound(stageContext, () => {
			events.push("agent-session:queue-follow-up");
		});
		events.push("structured_output:end");

		assert.ok(admitted);
		await admitted;
		assert.deepEqual(events, [
			"structured_output:start",
			"agent-session:queue-follow-up",
			"structured_output:end",
		]);
	});

	test("ordinary sessions retain Intercom's existing idle routing", () => {
		let delivered = false;
		const admitted = admitWorkflowStageInbound({}, () => { delivered = true; });

		assert.equal(admitted, false);
		assert.equal(delivered, false);
	});
});
