import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	attemptReachedCheckpoints,
	forkCopiedNodes,
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
import { assertRecordedParentsMaterialised } from "../../packages/workflows/src/shared/replay-topology-failure.js";
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

function forkBackend(
	checkpoints: readonly DurableCheckpoint[],
	handle: Partial<DurableWorkflowHandle>,
	sourceInputs: DurableWorkflowHandle["inputs"] = { tag: "v1" },
) {
	const handles: Record<string, DurableWorkflowHandle> = {
		fork: { workflowId: "fork", createdAt: 100, inputs: { tag: "v2" }, ...handle } as DurableWorkflowHandle,
		source: { workflowId: "source", createdAt: 1, inputs: sourceInputs } as DurableWorkflowHandle,
	};
	return { getWorkflow: (runId: string) => handles[runId], listCheckpoints: () => [...checkpoints] };
}

describe("the nodes a fork copied, which its first execution may keep as recorded parents (#4945)", () => {
	const childTool: DurableToolCheckpoint = {
		...tool("inner", 1, [], 55),
		topology: { ...tool("inner", 1).topology!, run: { runId: "child", runName: "child", parentRunId: "fork" } },
	};
	const copied = [
		{ ...tool("start", 1, [], 50), source: "async () => 1" },
		stage("agent", 1, ["tool:start"], 60),
		childTool,
		workflowAttemptCheckpoint("fork", 1, 40),
	];
	const forked = { forkedFrom: { runId: "source" } };

	test("a fork with replacement inputs that has not run yet keeps its own copied stages and tools (#4945)", () => {
		const nodes = forkCopiedNodes(forkBackend(copied, forked), "fork");
		assert.deepEqual(Object.fromEntries(nodes), {
			"tool:start": { kind: "tool", name: "start", source: "async () => 1" },
			agent: { kind: "stage", name: "agent" },
		});
	});

	test("a run that is not a fork, a fork of its source's inputs or of a source elsewhere, keeps none (#4945)", () => {
		assert.equal(forkCopiedNodes(forkBackend(copied, {}), "fork").size, 0);
		assert.equal(forkCopiedNodes(forkBackend(copied, forked), "missing").size, 0);
		assert.equal(forkCopiedNodes(forkBackend(copied, forked, { tag: "v2" }), "fork").size, 0);
		assert.equal(forkCopiedNodes(forkBackend(copied, { forkedFrom: { runId: "elsewhere" } }), "fork").size, 0);
	});

	test("a fork that recorded anything since it was copied keeps none (#4945)", () => {
		const ranAt = (completedAt: number) =>
			forkCopiedNodes(forkBackend([...copied, tool("again", 2, [], completedAt)], forked), "fork");
		assert.equal(ranAt(100).size, 0, "a record from the moment the fork registered is the fork's own");
		assert.deepEqual([...ranAt(99).keys()].sort(), ["agent", "tool:again", "tool:start"]);
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

describe("a run's nodes name only parents the run has (#4945)", () => {
	const none = () => false;

	test("a replayed stage or tool whose recorded parent is missing fails, naming it (#4945)", () => {
		assert.throws(
			() =>
				assertRecordedParentsMaterialised(
					{ id: "run", stages: [replayedStage("agent", ["tool:start"])], toolNodes: [] },
					none,
				),
			/replay topology mismatch for stage "agent" \(node "agent"\) in source run run: its recorded parent "tool:start" did not run again/,
		);
		assert.throws(
			() =>
				assertRecordedParentsMaterialised(
					{ id: "run", resumedFromRunId: "source", stages: [], toolNodes: [replayedTool("check", ["agent"])] },
					none,
				),
			/replay topology mismatch for tool "check" \(node "check"\) in source run source: its recorded parent "agent"/,
		);
	});

	test("a live stage that took recorded parents the run never had fails too (#4945)", () => {
		assert.throws(
			() =>
				assertRecordedParentsMaterialised(
					{ id: "run", stages: [replayedStage("live", ["tool:start"], false)], toolNodes: [] },
					none,
				),
			/replay topology mismatch for stage "live" \(node "live"\) in source run run: its recorded parent "tool:start"/,
		);
	});

	test("present parents and parents the run may keep pass (#4945)", () => {
		assertRecordedParentsMaterialised(
			{
				id: "run",
				stages: [replayedStage("agent", ["tool:start"]), replayedStage("live", ["agent"], false)],
				toolNodes: [replayedTool("tool:start", [])],
			},
			none,
		);
		assertRecordedParentsMaterialised(
			{ id: "run", stages: [replayedStage("agent", ["tool:copied"])], toolNodes: [] },
			(parentId) => parentId === "tool:copied",
		);
	});
});
