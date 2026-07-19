import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { admitWorkflowStageInbound } from "../../packages/intercom/workflow-stage-admission.js";

const stageContext = {
	isIdle: () => true,
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

	test("a busy workflow stage gives its exact foreground owner first refusal before generation admission", async () => {
		const events: string[] = [];
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			() => { events.push("agent-session:generation-admission"); },
			async () => {
				events.push("foreground-owner:probe");
				events.push("foreground-owner:commit");
				return "delivered";
			},
		);

		assert.ok(admitted);
		await admitted;
		assert.deepEqual(events, [
			"foreground-owner:probe",
			"foreground-owner:commit",
			"agent-session:generation-admission",
		]);
	});

	test("unclaimed busy workflow traffic falls back to generation admission", async () => {
		const events: string[] = [];
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			() => { events.push("agent-session:generation-admission"); },
			async () => {
				events.push("foreground-owner:unclaimed");
				return "unclaimed";
			},
		);

		assert.ok(admitted);
		await admitted;
		assert.deepEqual(events, [
			"foreground-owner:unclaimed",
			"agent-session:generation-admission",
		]);
	});
	test("a retired workflow generation cannot admit after foreground-owner cancellation", async () => {
		let delivered = false;
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			() => { delivered = true; },
			async () => "abandoned",
		);

		assert.ok(admitted);
		await assert.rejects(admitted, /retired during foreground-owner admission/);
		assert.equal(delivered, false);
	});

	test("ordinary sessions retain Intercom's existing idle routing", () => {
		let delivered = false;
		const admitted = admitWorkflowStageInbound({}, () => { delivered = true; });

		assert.equal(admitted, false);
		assert.equal(delivered, false);
	});
});
