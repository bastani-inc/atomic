import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX } from "../../packages/workflows/src/durable/backend.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { RunContinuationOpts, RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

/**
 * The stage is created before the tool its call follows, so the stage's recorded parent is that tool (#4888). On a
 * same-id replay the cached stage replays when it is created, before the tool replays.
 */
function stageBeforeTool(state: { finishFails: boolean }): WorkflowDefinition {
	return workflow({
		name: "stage-before-tool",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const agent = ctx.stage("agent");
			await ctx.tool("start", {}, async () => "started");
			await agent.prompt("reply");
			await ctx.tool("finish", {}, async () => {
				if (state.finishFails) throw new Error("planned finish failure");
				return "finished";
			});
			return {};
		},
	}) as WorkflowDefinition;
}

async function runWith(
	definition: WorkflowDefinition,
	backend: MemoryJournalBackend,
	runId: string,
	continuation?: RunContinuationOpts,
	store = createStore(),
): Promise<RunResult> {
	return run(
		definition,
		{},
		{
			runId,
			registry: createRegistry([definition]),
			store,
			durableBackend: backend,
			adapters: { prompt: { prompt: async (text: string) => text } },
			...(continuation === undefined ? {} : { continuation }),
		},
	);
}

/** The run's edges, by stage and tool name, so runs with different node ids compare. */
function edges(run: Pick<RunSnapshot, "stages" | "toolNodes">): readonly string[] {
	const nodes = [...run.stages, ...run.toolNodes];
	const names = new Map(nodes.map((node) => [node.id, node.name]));
	return nodes
		.flatMap((node) => node.parentIds.map((parentId) => `${names.get(parentId) ?? parentId} -> ${node.name}`))
		.sort();
}

function stageRecords(backend: MemoryJournalBackend, runId: string): DurableStageCheckpoint[] {
	return backend
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
}

function replayRecords(backend: MemoryJournalBackend, runId: string): DurableStageCheckpoint[] {
	return stageRecords(backend, runId).filter((checkpoint) =>
		checkpoint.checkpointId.startsWith(STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX),
	);
}

describe("a stage created before the tool its call follows (#4888)", () => {
	test("a same-id resume replays the stage with its recorded tool parent (#4888)", async () => {
		const control = await runWith(
			stageBeforeTool({ finishFails: false }),
			await createMemoryTestBackend(),
			testRunId("stage-before-tool-control"),
		);
		assert.equal(control.status, "completed");
		assert.deepEqual(edges(control), ["agent -> finish", "start -> agent"]);

		const backend = await createMemoryTestBackend();
		const state = { finishFails: true };
		const runId = testRunId("stage-before-tool");
		const failed = await runWith(stageBeforeTool(state), backend, runId);
		assert.equal(failed.status, "failed");
		state.finishFails = false;
		const resumed = await runWith(stageBeforeTool(state), backend, runId);
		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(resumed.stages.find((stage) => stage.name === "agent")?.replayed, true);
		assert.deepEqual(edges(resumed), edges(control));

		// Every record of the stage, the replay's own included, names the same parents.
		const replayed = replayRecords(backend, runId);
		assert.equal(replayed.length, 1);
		const parents = stageRecords(backend, runId).map((record) => record.topology?.parentIds);
		assert.ok(parents.length > 1);
		for (const recorded of parents) assert.deepEqual(recorded, [failed.toolNodes[0]!.id]);

		const entry = listCompletedFromBackend(backend).find((candidate) => candidate.workflowId === runId);
		assert.ok(entry, "the completed catalog lists the resumed run");
		const [inspected] = await completedWorkflowRunSnapshots(backend, entry, new MemorySessionStore());
		assert.ok(inspected, "the resumed run's records rebuild it");
		assert.deepEqual(edges({ stages: inspected.stages, toolNodes: resumed.toolNodes }), edges(control));
	});

	test("a pooled-style child re-run with the same id completes after the stage replays (#4888)", async () => {
		const state = { finishFails: true };
		const child = stageBeforeTool(state);
		const parent = workflow({
			name: "stage-before-tool-parent",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.workflow(child);
				return {};
			},
		}) as WorkflowDefinition;
		const backend = await createMemoryTestBackend();
		const runId = testRunId("stage-before-tool-parent");
		const start = (definitions: readonly WorkflowDefinition[]) =>
			run(
				parent,
				{},
				{
					runId,
					registry: createRegistry([...definitions]),
					store: createStore(),
					durableBackend: backend,
					adapters: { prompt: { prompt: async (text: string) => text } },
				},
			);
		assert.equal((await start([parent, child])).status, "failed");
		state.finishFails = false;
		const resumed = await start([parent, child]);
		assert.equal(resumed.status, "completed", resumed.error);
		const again = await start([parent, child]);
		assert.equal(again.status, "completed", again.error);
	});

	test("a same-id replay refuses to write a replay record that disagrees with the stage's record (#4888)", async () => {
		const backend = await createMemoryTestBackend();
		const state = { finishFails: true };
		const runId = testRunId("stage-before-tool-drift");
		assert.equal((await runWith(stageBeforeTool(state), backend, runId)).status, "failed");
		// The stage's record now names a parent run this run does not have: its replay cannot record it the same way.
		const [record] = stageRecords(backend, runId);
		assert.ok(record?.topology?.run);
		await backend.commitCheckpoint({
			...record,
			checkpointId: `${record.checkpointId}:moved`,
			topology: { ...record.topology, run: { ...record.topology.run, parentRunId: "elsewhere" } },
		});
		state.finishFails = false;
		const resumed = await runWith(stageBeforeTool(state), backend, runId);
		assert.equal(resumed.status, "failed");
		assert.match(resumed.error ?? "", /immutable stage identity drift/);
		assert.deepEqual(replayRecords(backend, runId), []);
	});

	test("a fork of the run refuses the stage loudly instead of recording other parents (#4888)", async () => {
		const backend = await createMemoryTestBackend();
		const sourceStore = createStore();
		const state = { finishFails: true };
		const sourceId = testRunId("stage-before-tool-source");
		const failed = await runWith(stageBeforeTool(state), backend, sourceId, undefined, sourceStore);
		assert.equal(failed.status, "failed");
		const source = sourceStore.runs().find((candidate) => candidate.id === sourceId);
		assert.ok(source);
		state.finishFails = false;
		const forkId = testRunId("stage-before-tool-fork");
		const fork = await runWith(stageBeforeTool(state), backend, forkId, {
			source,
			resumeFromToolNodeId: source.toolNodes.find((node) => node.name === "finish")!.id,
		});
		assert.equal(fork.status, "failed");
		assert.match(fork.error ?? "", /insufficient_state: replay topology mismatch for stage "agent"/);
		assert.deepEqual(replayRecords(backend, forkId), []);
		assert.deepEqual(
			fork.stages.filter((stage) => stage.name === "agent" && stage.parentIds.length === 0),
			[],
		);
	});
});
