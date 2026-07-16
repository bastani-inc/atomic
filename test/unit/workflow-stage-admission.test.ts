import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";

describe("WorkflowStageAdmissionBoundary", () => {
	test("admission before close is delivered to the stage and drained before close resolves", async () => {
		const events: string[] = [];
		const boundary = new WorkflowStageAdmissionBoundary(async () => { events.push("drained"); });
		const delivery = Promise.withResolvers<void>();
		const admitted = boundary.admit("message-1", async () => {
			events.push("stage");
			await delivery.promise;
		}, () => { events.push("external"); });
		let closed = false;
		const close = boundary.close().then(() => { closed = true; });

		await Promise.resolve();
		assert.equal(admitted.decision, "admitted");
		assert.equal(closed, false);
		assert.deepEqual(events, ["stage"]);
		delivery.resolve();
		await close;
		assert.deepEqual(events, ["stage", "drained"]);
		assert.equal(closed, true);
	});

	test("concurrent close calls share one drain", async () => {
		let drains = 0;
		const boundary = new WorkflowStageAdmissionBoundary(async () => { drains += 1; });

		await Promise.all([boundary.close(), boundary.close()]);
		assert.equal(drains, 1);
	});

	test("close before admission routes externally without stage delivery", async () => {
		const boundary = new WorkflowStageAdmissionBoundary();
		await boundary.close();
		const events: string[] = [];
		const result = boundary.admit("message-1", () => { events.push("stage"); }, () => { events.push("external"); });
		await result.completion;

		assert.equal(result.decision, "late");
		assert.deepEqual(events, ["external"]);
	});

	test("failed routing releases the stable key for a producer retry", async () => {
		const boundary = new WorkflowStageAdmissionBoundary();
		await boundary.close();
		let attempts = 0;
		const route = () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary route failure");
		};

		await assert.rejects(boundary.admit("completion-1", () => {}, route).completion, /temporary route failure/);
		await boundary.admit("completion-1", () => {}, route).completion;
		assert.equal(attempts, 2);
	});

	test("close does not wait for detached producers that have not delivered", async () => {
		const boundary = new WorkflowStageAdmissionBoundary();
		const producer = Promise.withResolvers<void>();
		const events: string[] = [];
		const eventualDelivery = producer.promise.then(() => boundary.admit(
			"completion-1",
			() => { events.push("stage"); },
			() => { events.push("external"); },
		).completion);

		await boundary.close();
		assert.deepEqual(events, []);
		producer.resolve();
		await eventualDelivery;
		assert.deepEqual(events, ["external"]);
	});

	test("a stable key is delivered exactly once across the close boundary", async () => {
		const boundary = new WorkflowStageAdmissionBoundary();
		const events: string[] = [];
		await boundary.admit("message-1", () => { events.push("stage"); }, () => { events.push("external"); }).completion;
		await boundary.close();
		const duplicate = boundary.admit("message-1", () => { events.push("stage"); }, () => { events.push("external"); });
		await duplicate.completion;

		assert.equal(duplicate.decision, "duplicate");
		assert.deepEqual(events, ["stage"]);
	});
});
