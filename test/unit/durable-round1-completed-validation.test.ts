import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	completedWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
	resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { testRunId } from "../helpers/run-id.js";

function seedCompletedBoundary(
	backend: InMemoryDurableBackend,
	runId: string,
	output: WorkflowSerializableValue,
	childRunId = testRunId(`${runId}-child`),
): void {
	const replayKey = "workflow:child:1";
	const rootRun = { runId, runName: "completed-parent" } as const;
	const child = {
		runId: childRunId,
		runName: "child",
		parentRunId: runId,
		parentStageId: "boundary",
		rootRunId: runId,
	} as const;
	backend.registerWorkflow({
		workflowId: runId,
		name: "completed-parent",
		inputs: {},
		createdAt: 1,
		status: "completed",
		updatedAt: 5,
		resumable: false,
	});
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-start:${replayKey}`,
		name: "workflow:child",
		replayKey,
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "boundary",
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: rootRun,
			boundary: {
				version: 1,
				event: "start",
				replayScope: replayKey,
				alias: "child",
				workflow: "child",
				status: "running",
				child,
			},
		},
	});
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: `${replayKey}:stage:child:1`,
		name: "child-stage",
		replayKey: `${replayKey}:stage:child:1`,
		output: "child",
		completedAt: 3,
		topology: {
			version: 1,
			stageId: "child-stage",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: { ...child, runId: childRunId },
		},
	});
	backend.recordCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-terminal:${replayKey}:completed`,
		name: "workflow:child",
		replayKey,
		output,
		result: "completed",
		completedAt: 4,
		topology: {
			version: 1,
			stageId: "boundary",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: rootRun,
			boundary: {
				version: 1,
				event: "terminal",
				replayScope: replayKey,
				alias: "child",
				workflow: "child",
				status: "completed",
				child,
			},
		},
	});
}

test("completed catalog uses the shared strict WorkflowChildResult parser", () => {
	const valid = new InMemoryDurableBackend();
	const validRootId = testRunId("valid-completed");
	seedCompletedBoundary(
		valid,
		validRootId,
		{
			workflow: "child",
			runId: testRunId("valid-completed-child"),
			status: "completed",
			exited: false,
			outputs: {},
		},
		testRunId("valid-completed-child"),
	);
	assert.equal(listOpenableCompletedWorkflows(valid).length, 1);
	assert.equal(completedWorkflowRunSnapshots(valid, valid.listCompletedWorkflows()[0]!).length, 2);

	for (const [index, output] of (
		[
			{ workflow: "child", runId: testRunId("malformed-0-child"), status: "completed", outputs: {} },
			{ workflow: "child", runId: testRunId("malformed-1-child"), status: "failed", exited: false, outputs: {} },
			{ workflow: "child", runId: testRunId("malformed-2-child"), status: "completed", exited: false, outputs: [] },
		] satisfies readonly WorkflowSerializableValue[]
	).entries()) {
		const backend = new InMemoryDurableBackend();
		const runId = testRunId(`malformed-${index}`);
		seedCompletedBoundary(backend, runId, output);
		assert.deepEqual(listOpenableCompletedWorkflows(backend), [], runId);
		assert.equal(resolveCompletedWorkflow(runId, backend).kind, "stale", runId);
	}
});
