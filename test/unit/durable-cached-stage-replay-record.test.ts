import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCompletedStageCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageTopology,
} from "../../packages/workflows/src/durable/types.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createDurableCachedStageRecorder } from "../../packages/workflows/src/engine/run-durable-topology.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

const RUN_ID = "replay-record-run";
const RUN = { runId: RUN_ID, runName: "replay-record" } as const;

function liveRun(): RunSnapshot {
	return {
		id: RUN_ID,
		name: RUN.runName,
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	};
}

/** A completed stage's record as an earlier process of the run wrote it. */
function record(name: string, topology?: Partial<DurableStageTopology>): DurableCompletedStageCheckpoint {
	return {
		kind: "stage",
		workflowId: RUN_ID,
		checkpointId: `stage:${name}`,
		name,
		replayKey: `stage:${name}:1`,
		output: `${name} done`,
		completedAt: 2,
		result: `${name} done`,
		...(topology === undefined
			? {}
			: {
					topology: {
						version: DURABLE_STAGE_TOPOLOGY_VERSION,
						stageId: `${name}-id`,
						parentIds: [],
						status: "completed",
						...topology,
					},
				}),
	};
}

async function replay(
	checkpoints: readonly DurableCompletedStageCheckpoint[],
	options: { readonly storeHoldsRun?: boolean } = {},
): Promise<{ readonly backend: MemoryJournalBackend; readonly replayRecords: () => DurableStageCheckpoint[] }> {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: RUN.runName,
		inputs: {},
		createdAt: 1,
		status: "running",
		pendingPrompts: 0,
		resumable: true,
	});
	const run = liveRun();
	const store = createStore();
	if (options.storeHoldsRun !== false) store.recordRunStart(run);
	const recorder = createDurableCachedStageRecorder({
		store,
		tracker: new GraphFrontierTracker(),
		run,
		backend,
		rootBackend: backend,
		completedStageReplayKeys: new Map(),
		sourceToReplayedNodeIds: new Map(),
	});
	for (const checkpoint of checkpoints) await recorder.record(checkpoint.name, checkpoint.replayKey, checkpoint);
	return {
		backend,
		replayRecords: () =>
			backend
				.listCheckpoints(RUN_ID)
				.filter(
					(checkpoint): checkpoint is DurableStageCheckpoint =>
						checkpoint.kind === "stage" &&
						checkpoint.checkpointId.startsWith(STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX),
				),
	};
}

describe("the replay record of a cached stage (#4888)", () => {
	test("each replayed stage of this run keeps the identity it recorded, in its own replay record (#4888)", async () => {
		const { replayRecords } = await replay([
			record("first", { run: RUN, sourceOrder: 0 }),
			// Its parent is a tool that replays after it.
			record("second", { run: RUN, sourceOrder: 1, parentIds: ["tool:later"] }),
		]);
		assert.deepEqual(
			replayRecords().map((entry) => [
				entry.name,
				entry.topology?.stageId,
				entry.topology?.parentIds,
				entry.topology?.sourceOrder,
			]),
			[
				["first", "first-id", [], 0],
				["second", "second-id", ["tool:later"], 1],
			],
		);
	});

	test("a replay that would record a stage differently from its own record fails and writes nothing (#4888)", async () => {
		await assert.rejects(
			replay([record("moved", { run: { ...RUN, parentRunId: "elsewhere" }, sourceOrder: 0 })]),
			/immutable stage identity drift within one replay-key group at stage:moved:1/,
		);
	});

	test("a record without a source order is not compared, and its replay records its place in the run (#4888)", async () => {
		const { replayRecords } = await replay([
			record("first", { run: RUN }),
			record("second", { run: { ...RUN, parentRunId: "elsewhere" } }),
		]);
		assert.deepEqual(
			replayRecords().map((entry) => [entry.name, entry.topology?.sourceOrder]),
			[
				["first", 0],
				["second", 1],
			],
		);
	});

	test("records of another run, or without a run or topology, replay without comparison (#4888)", async () => {
		const { replayRecords } = await replay([
			record("forked", { run: { runId: "source-run", runName: "source" }, sourceOrder: 0 }),
			record("runless", { sourceOrder: 1 }),
			record("legacy"),
		]);
		assert.deepEqual(
			replayRecords()
				.map((entry) => entry.name)
				.sort(),
			["forked", "legacy", "runless"],
		);
	});

	test("a stage the store does not hold is neither compared nor recorded (#4888)", async () => {
		const { replayRecords } = await replay([record("unheld", { run: RUN, sourceOrder: 0 })], {
			storeHoldsRun: false,
		});
		assert.deepEqual(replayRecords(), []);
	});
});
