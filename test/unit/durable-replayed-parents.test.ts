import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	attemptReachedCheckpoints,
	forkCopiedNodes,
	keepsForkCopiedParent,
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

describe("a kept parent that shares its place with the node that replaced it (#4945)", () => {
	const boundary = (id: string, order: number, attempt: number, completedAt: number): DurableStageCheckpoint => ({
		...stage(id, attempt, ["plan"], completedAt),
		name: "workflow:child",
		replayKey: `workflow:child:${id}`,
		topology: { ...stage(id, attempt, ["plan"]).topology!, sourceOrder: order },
	});
	const orders = (checkpoints: readonly DurableCheckpoint[]) =>
		checkpoints.flatMap((checkpoint) =>
			checkpoint.kind === "stage" ? [[checkpoint.topology!.stageId, checkpoint.topology!.sourceOrder]] : [],
		);

	test("is shown just before the node in its place, and the others keep theirs (#4945)", () => {
		const records = [
			workflowAttemptCheckpoint(ROOT, 1, 1),
			{ ...stage("plan", 1, [], 2), topology: { ...stage("plan", 1, []).topology!, sourceOrder: 0 } },
			boundary("old", 1, 1, 3),
			tool("start", 1, ["plan"], 4),
			workflowAttemptCheckpoint(ROOT, 2, 5),
			{ ...stage("plan", 2, [], 6), topology: { ...stage("plan", 2, []).topology!, sourceOrder: 0 } },
			boundary("new", 1, 2, 7),
			// Replays after the boundary its first attempt followed, and the tool that attempt ran.
			{
				...stage("ship", 2, ["old", "tool:start"], 8),
				topology: { ...stage("ship", 2, ["old", "tool:start"]).topology!, sourceOrder: 2 },
			},
		];
		assert.deepEqual(orders(attemptReachedCheckpoints(records, ROOT, { rootReach: true })), [
			["plan", 0],
			["old", 0.5],
			["plan", 0],
			["new", 1],
			["ship", 2],
		]);
	});

	test("keeps its place when nothing replaced it (#4945)", () => {
		const records = [
			workflowAttemptCheckpoint(ROOT, 1, 1),
			boundary("old", 1, 1, 3),
			workflowAttemptCheckpoint(ROOT, 2, 5),
			{ ...stage("ship", 2, ["old"], 8), topology: { ...stage("ship", 2, ["old"]).topology!, sourceOrder: 2 } },
		];
		assert.deepEqual(orders(attemptReachedCheckpoints(records, ROOT, { rootReach: true })), [
			["old", 1],
			["ship", 2],
		]);
	});
});

describe("a copied parent a fork's first execution keeps (#4945)", () => {
	const copied = new Map([
		["tool:start", { kind: "tool" as const, name: "start", source: "async () => 1" }],
		["old", { kind: "stage" as const, name: "workflow:child" }],
	]);
	const startAgain = (fields: Partial<ToolNodeSnapshot> = {}): ToolNodeSnapshot => ({
		...replayedTool("tool:start-v2", []),
		name: "start",
		source: "async () => 1",
		replayed: false,
		...fields,
	});
	const keeps = (toolNodes: ToolNodeSnapshot[], stages: StageSnapshot[], parentId: string) =>
		keepsForkCopiedParent(copied, { stages, toolNodes }, parentId);

	test("is a call the run made again, by the same name, kind and callback (#4945)", () => {
		assert.equal(keeps([startAgain()], [], "tool:start"), true);
		assert.equal(keeps([], [{ ...replayedStage("new", ["plan"], false), name: "workflow:child" }], "old"), true);
	});

	test("is not a node the fork did not copy, or one the run did not make again the same way (#4945)", () => {
		assert.equal(keeps([startAgain()], [], "tool:other"), false);
		assert.equal(keeps([], [], "tool:start"), false, "removed");
		assert.equal(keeps([startAgain({ name: "begin" })], [], "tool:start"), false, "renamed");
		assert.equal(keeps([startAgain({ source: "async () => 2" })], [], "tool:start"), false, "another callback");
		assert.equal(keeps([startAgain({ replayed: true })], [], "tool:start"), false, "replayed, not made again");
		assert.equal(keeps([startAgain({ id: "tool:start" })], [], "tool:start"), false, "itself");
		assert.equal(
			keeps([], [{ ...replayedStage("new", [], false), name: "start" }], "tool:start"),
			false,
			"a stage is no tool",
		);
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
