import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	attemptReachedCheckpoints,
	forkCopiedNodeIds,
	workflowAttemptCheckpoint,
} from "../../packages/workflows/src/durable/attempt-identity.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableToolCheckpoint,
	type DurableWorkflowHandle,
} from "../../packages/workflows/src/durable/types.js";
import { assertReplayedParentsMaterialised } from "../../packages/workflows/src/shared/replay-topology-failure.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const ROOT = "root";

function stage(id: string, attempt: number, parentIds: readonly string[], completedAt = 10): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${id}:${attempt}`,
		name: id,
		replayKey: `stage:${id}:1`,
		completedAt,
		output: id,
		topology: { version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId: id, parentIds, status: "completed" },
		...(attempt > 0 ? { attempt } : {}),
	};
}

function tool(
	name: string,
	attempt: number,
	parentIds: readonly string[] = [],
	completedAt = 10,
): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: `tool:${name}:${attempt}`,
		name,
		argsHash: name,
		output: `${name} ${attempt}`,
		completedAt,
		topology: { version: DURABLE_TOOL_TOPOLOGY_VERSION, nodeId: `tool:${name}`, ordinal: 1, order: 1, parentIds },
		...(attempt > 0 ? { attempt } : {}),
	};
}

const graph = (checkpoints: readonly DurableCheckpoint[]): readonly string[] =>
	checkpoints.flatMap((checkpoint) => (checkpoint.kind === "ui" ? [] : [checkpoint.checkpointId]));

describe("the records of a run's latest attempt keep its replayed nodes' recorded parents (#4945)", () => {
	test("a parent the latest attempt did not run again is kept, with only its latest attempt's record (#4945)", () => {
		const records = [
			workflowAttemptCheckpoint(ROOT, 1, 1),
			tool("start", 1),
			workflowAttemptCheckpoint(ROOT, 2, 2),
			tool("start", 2),
			stage("agent", 2, ["tool:start"]),
			workflowAttemptCheckpoint(ROOT, 3, 3),
			// The stage replays in attempt 3, and `start` no longer runs.
			stage("agent", 3, ["tool:start"]),
		];
		assert.deepEqual(graph(attemptReachedCheckpoints(records, ROOT, { rootReach: true })), [
			"tool:start:2",
			"agent:2",
			"agent:3",
		]);
	});

	test("the kept parents' own recorded parents are kept too (#4945)", () => {
		const records = [
			workflowAttemptCheckpoint(ROOT, 1, 1),
			tool("seed", 1),
			tool("start", 1, ["tool:seed"]),
			workflowAttemptCheckpoint(ROOT, 2, 2),
			stage("agent", 2, ["tool:start"]),
		];
		assert.deepEqual(graph(attemptReachedCheckpoints(records, ROOT, { rootReach: true })), [
			"tool:seed:1",
			"tool:start:1",
			"agent:2",
		]);
	});

	test("a parent no record names, and a node no reached node names, stay out (#4945)", () => {
		const records = [
			workflowAttemptCheckpoint(ROOT, 1, 1),
			tool("unrelated", 1),
			workflowAttemptCheckpoint(ROOT, 2, 2),
			stage("agent", 2, ["tool:never-recorded"]),
		];
		assert.deepEqual(graph(attemptReachedCheckpoints(records, ROOT, { rootReach: true })), ["agent:2"]);
	});
});

function forkBackend(checkpoints: readonly DurableCheckpoint[], handle: Partial<DurableWorkflowHandle>) {
	return {
		getWorkflow: (runId: string) =>
			runId === "fork" ? ({ workflowId: "fork", createdAt: 100, ...handle } as DurableWorkflowHandle) : undefined,
		listCheckpoints: () => [...checkpoints],
	};
}

describe("the nodes a fork copied, which its first execution may keep as recorded parents (#4945)", () => {
	const copied = [
		tool("start", 1, [], 50),
		stage("agent", 1, ["tool:start"], 60),
		workflowAttemptCheckpoint("fork", 1, 40),
	];

	test("a fork that has not run yet keeps every stage and tool it copied (#4945)", () => {
		const ids = forkCopiedNodeIds(forkBackend(copied, { forkedFrom: { runId: "source" } }), "fork");
		assert.deepEqual([...ids].sort(), ["agent", "tool:start"]);
	});

	test("a run that is not a fork, or a fork that recorded anything since it was copied, keeps none (#4945)", () => {
		assert.deepEqual([...forkCopiedNodeIds(forkBackend(copied, {}), "fork")], []);
		assert.deepEqual([...forkCopiedNodeIds(forkBackend(copied, { forkedFrom: { runId: "source" } }), "missing")], []);
		const ranAt = (completedAt: number) =>
			forkCopiedNodeIds(
				forkBackend([...copied, tool("again", 2, [], completedAt)], { forkedFrom: { runId: "source" } }),
				"fork",
			);
		assert.deepEqual([...ranAt(100)], [], "a record from the moment the fork registered is the fork's own");
		assert.deepEqual([...ranAt(99)].sort(), ["agent", "tool:again", "tool:start"]);
	});
});

function replayedStage(id: string, parentIds: readonly string[], replayed = true): StageSnapshot {
	return { id, name: id, status: "completed", parentIds, toolEvents: [], ...(replayed ? { replayed: true } : {}) };
}

function replayedTool(id: string, parentIds: readonly string[]): ToolNodeSnapshot {
	const node: ToolNodeSnapshot = {
		kind: "tool",
		id,
		name: id,
		argsHash: id,
		ordinal: 1,
		parentIds,
		status: "cached",
		attachable: false,
		replayed: true,
	};
	return node;
}

describe("a run's replayed nodes name only parents the run ran again (#4945)", () => {
	const none = () => false;

	test("a replayed stage or tool whose recorded parent is missing fails, naming it (#4945)", () => {
		assert.throws(
			() =>
				assertReplayedParentsMaterialised(
					{ id: "run", stages: [replayedStage("agent", ["tool:start"])], toolNodes: [] },
					none,
				),
			/replay topology mismatch for stage "agent" \(node "agent"\) in source run run: its recorded parent "tool:start" did not run again/,
		);
		assert.throws(
			() =>
				assertReplayedParentsMaterialised(
					{ id: "run", resumedFromRunId: "source", stages: [], toolNodes: [replayedTool("check", ["agent"])] },
					none,
				),
			/replay topology mismatch for tool "check" \(node "check"\) in source run source: its recorded parent "agent"/,
		);
	});

	test("present parents, live nodes and parents the run may keep pass (#4945)", () => {
		assertReplayedParentsMaterialised(
			{
				id: "run",
				stages: [replayedStage("agent", ["tool:start"]), replayedStage("live", ["elsewhere"], false)],
				toolNodes: [replayedTool("tool:start", [])],
			},
			none,
		);
		assertReplayedParentsMaterialised(
			{ id: "run", stages: [replayedStage("agent", ["tool:copied"])], toolNodes: [] },
			(parentId) => parentId === "tool:copied",
		);
	});
});
