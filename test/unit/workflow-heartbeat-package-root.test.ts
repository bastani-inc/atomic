import assert from "node:assert/strict";
import {
	DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatEvent,
	type WorkflowHeartbeatEventDetails,
	type WorkflowHeartbeatIdentity,
} from "@bastani/workflows";
import { test } from "vitest";

test("exports the workflow heartbeat contract from the package root", () => {
	const identity = {
		runId: "run-17",
		scheduledAt: 901_000,
	} satisfies WorkflowHeartbeatIdentity;
	const details = {
		...identity,
		workflowName: "release-check",
		startedAt: 1_000,
		intervalMinutes: DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
	} satisfies WorkflowHeartbeatEventDetails;
	const event = {
		customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
		details,
	} satisfies WorkflowHeartbeatEvent;

	assert.equal(DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES, 15);
	assert.equal(event.customType, "workflows:workflow-heartbeat");
	assert.deepEqual(event.details, {
		runId: "run-17",
		scheduledAt: 901_000,
		workflowName: "release-check",
		startedAt: 1_000,
		intervalMinutes: 15,
	});
});
