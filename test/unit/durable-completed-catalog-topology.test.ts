import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";

test("reconstructs multi-level boundary edges when durable completion order is reverse-topological", () => {
	const backend = new InMemoryDurableBackend();
	const rootId = "durable-root";
	const childId = "durable-child";
	const grandId = "durable-grand";
	backend.registerWorkflow({
		workflowId: rootId,
		name: "durable-root",
		inputs: {},
		createdAt: 1,
		status: "completed",
	});
	const rootRun = { runId: rootId, runName: "durable-root" } as const;
	const childRun = {
		runId: childId,
		runName: "durable-child",
		parentRunId: rootId,
		parentStageId: "root-boundary",
		rootRunId: rootId,
	} as const;
	const grandRun = {
		runId: grandId,
		runName: "durable-grand",
		parentRunId: childId,
		parentStageId: "child-boundary",
		rootRunId: rootId,
	} as const;
	const childOutput = {
		workflow: "durable-child",
		runId: childId,
		status: "completed",
		exited: false,
		outputs: {},
	} as const;
	const grandOutput = {
		workflow: "durable-grand",
		runId: grandId,
		status: "completed",
		exited: false,
		outputs: {},
	} as const;
	const checkpoints = [
		{
			checkpointId: "root-after",
			name: "after",
			replayKey: "root-after",
			output: "after",
			completedAt: 10,
			topology: { version: 1 as const, stageId: "root-after", parentIds: ["root-boundary"], run: rootRun },
		},
		{
			checkpointId: "root-boundary",
			name: "workflow:child",
			replayKey: "root-boundary",
			output: childOutput,
			completedAt: 20,
			topology: { version: 1 as const, stageId: "root-boundary", parentIds: ["root-before"], run: rootRun },
		},
		{
			checkpointId: "root-before",
			name: "before",
			replayKey: "root-before",
			output: "before",
			completedAt: 30,
			topology: { version: 1 as const, stageId: "root-before", parentIds: [], run: rootRun },
		},
		{
			checkpointId: "child-end",
			name: "child-end",
			replayKey: "child-end",
			output: "end",
			completedAt: 10,
			topology: { version: 1 as const, stageId: "child-end", parentIds: ["child-boundary"], run: childRun },
		},
		{
			checkpointId: "child-boundary",
			name: "workflow:grand",
			replayKey: "child-boundary",
			output: grandOutput,
			completedAt: 20,
			topology: { version: 1 as const, stageId: "child-boundary", parentIds: ["child-start"], run: childRun },
		},
		{
			checkpointId: "child-start",
			name: "child-start",
			replayKey: "child-start",
			output: "start",
			completedAt: 30,
			topology: { version: 1 as const, stageId: "child-start", parentIds: [], run: childRun },
		},
		{
			checkpointId: "grand-left",
			name: "grand-left",
			replayKey: "grand-left",
			output: "left",
			completedAt: 10,
			topology: { version: 1 as const, stageId: "grand-left", parentIds: [], run: grandRun },
		},
		{
			checkpointId: "grand-right",
			name: "grand-right",
			replayKey: "grand-right",
			output: "right",
			completedAt: 20,
			topology: { version: 1 as const, stageId: "grand-right", parentIds: [], run: grandRun },
		},
	];
	for (const checkpoint of checkpoints) {
		backend.recordCheckpoint({ kind: "stage", workflowId: rootId, ...checkpoint });
	}

	const runs = completedWorkflowRunSnapshots(backend, listCompletedFromBackend(backend)[0]!);
	assert.equal(runs.length, 3);
	const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, rootId);
	assert.deepEqual(
		graph.stages.map((item) => item.id),
		[
			"root-after",
			`${childId}:child-end`,
			`${grandId}:grand-left`,
			`${grandId}:grand-right`,
			`${childId}:child-start`,
			"root-before",
		],
	);
	const byName = (name: string) => graph.stages.find((item) => item.name === name)!;
	assert.deepEqual(byName("after").parentIds, [`${childId}:child-end`]);
	assert.deepEqual(byName("child-end").parentIds, [`${grandId}:grand-left`, `${grandId}:grand-right`]);
	assert.deepEqual(byName("grand-left").parentIds, [`${childId}:child-start`]);
	assert.deepEqual(byName("grand-right").parentIds, [`${childId}:child-start`]);
	assert.deepEqual(byName("child-start").parentIds, ["root-before"]);
});
