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

	test("a busy workflow stage admits before waiting for exact foreground-owner first refusal", async () => {
		const events: string[] = [];
		const firstRefusal = Promise.withResolvers<void>();
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			async (admissionBarrier) => {
				events.push("agent-session:generation-admission");
				await admissionBarrier?.();
				events.push("agent-session:queue-delivery");
			},
			async () => {
				events.push("foreground-owner:probe");
				await firstRefusal.promise;
				events.push("foreground-owner:commit");
				return "delivered";
			},
		);

		assert.ok(admitted);
		assert.deepEqual(events, [
			"agent-session:generation-admission",
			"foreground-owner:probe",
		]);
		firstRefusal.resolve();
		await admitted;
		assert.deepEqual(events, [
			"agent-session:generation-admission",
			"foreground-owner:probe",
			"foreground-owner:commit",
			"agent-session:queue-delivery",
		]);
	});

	test("a retried stage delivery executes foreground first refusal exactly once", async () => {
		let claims = 0;
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			async (admissionBarrier) => {
				await admissionBarrier?.();
				await admissionBarrier?.();
			},
			async () => { claims += 1; return "unclaimed"; },
		);

		assert.ok(admitted);
		await admitted;
		assert.equal(claims, 1);
	});
	test("unclaimed busy workflow traffic falls back inside the admitted generation", async () => {
		const events: string[] = [];
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			async (admissionBarrier) => {
				events.push("agent-session:generation-admission");
				await admissionBarrier?.();
				events.push("agent-session:queue-delivery");
			},
			async () => {
				events.push("foreground-owner:unclaimed");
				return "unclaimed";
			},
		);

		assert.ok(admitted);
		await admitted;
		assert.deepEqual(events, [
			"agent-session:generation-admission",
			"foreground-owner:unclaimed",
			"agent-session:queue-delivery",
		]);
	});
	test("a retired generation reports failure before its admitted delivery settles", async () => {
		let delivered = false;
		let settled = false;
		const failureReported = Promise.withResolvers<void>();
		const admitted = admitWorkflowStageInbound(
			{ ...stageContext, isIdle: () => false },
			async (admissionBarrier) => {
				await Promise.all([admissionBarrier?.(), admissionBarrier?.()]);
				delivered = true;
			},
			async () => "abandoned",
			async () => { await failureReported.promise; },
		);

		assert.ok(admitted);
		void admitted.finally(() => { settled = true; }).catch(() => {});
		await Bun.sleep(0);
		assert.equal(settled, false, "correlated failure reporting remains inside admitted work");
		failureReported.resolve();
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
