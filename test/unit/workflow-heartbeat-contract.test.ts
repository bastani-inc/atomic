import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEvent,
	type WorkflowHeartbeatEventDetails,
	type WorkflowHeartbeatIdentity,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";

function minimalWorkflow(heartbeatIntervalMinutes?: number) {
	return workflow({
		name: "heartbeat-contract",
		description: "heartbeat contract test",
		outputs: {},
		run: () => ({}),
		...(heartbeatIntervalMinutes !== undefined ? { heartbeatIntervalMinutes } : {}),
	});
}

describe("workflow heartbeat authoring contract", () => {
	test("defaults the interval to 15 minutes", () => {
		const definition = minimalWorkflow();

		assert.equal(definition.heartbeatIntervalMinutes, 15);
	});

	test("preserves 0 as the disabled interval", () => {
		const definition = minimalWorkflow(0);

		assert.equal(definition.heartbeatIntervalMinutes, 0);
	});

	test("freezes the resolved interval with the definition", () => {
		const definition = minimalWorkflow(30);

		assert.throws(() => Object.defineProperty(definition, "heartbeatIntervalMinutes", { value: 5 }), TypeError);
		assert.equal(definition.heartbeatIntervalMinutes, 30);
	});

	test("preserves positive finite interval bounds", () => {
		for (const heartbeatIntervalMinutes of [Number.MIN_VALUE, 0.5, Number.MAX_VALUE]) {
			const definition = minimalWorkflow(heartbeatIntervalMinutes);

			assert.equal(definition.heartbeatIntervalMinutes, heartbeatIntervalMinutes);
		}
	});

	test("rejects negative intervals", () => {
		for (const heartbeatIntervalMinutes of [-Number.MIN_VALUE, -1]) {
			assert.throws(() => minimalWorkflow(heartbeatIntervalMinutes), {
				name: "TypeError",
				message: "workflow: heartbeatIntervalMinutes must be a non-negative finite number",
			});
		}
	});

	test("rejects non-finite intervals", () => {
		for (const heartbeatIntervalMinutes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			assert.throws(() => minimalWorkflow(heartbeatIntervalMinutes), {
				name: "TypeError",
				message: "workflow: heartbeatIntervalMinutes must be a non-negative finite number",
			});
		}
	});
});

describe("workflow heartbeat event contract", () => {
	test("declares a distinct custom event with the complete payload", () => {
		const details = {
			runId: "run-17",
			workflowName: "release-check",
			startedAt: 1_000,
			scheduledAt: 901_000,
			intervalMinutes: 15,
		} satisfies WorkflowHeartbeatEventDetails;
		const event = {
			customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
			details,
		} satisfies WorkflowHeartbeatEvent;

		assert.equal(event.customType, "workflows:workflow-heartbeat");
		assert.deepEqual(Object.keys(event.details).sort(), [
			"intervalMinutes",
			"runId",
			"scheduledAt",
			"startedAt",
			"workflowName",
		]);
	});

	test("anchors identity to the run and scheduled boundary", () => {
		const identity = {
			runId: "run-17",
			scheduledAt: 901_000,
		} satisfies WorkflowHeartbeatIdentity;

		assert.deepEqual(Object.keys(identity).sort(), ["runId", "scheduledAt"]);
	});
});
