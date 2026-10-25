import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableCompletedNestedRunSubtree } from "../../packages/workflows/src/durable/completed-subtree.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

const POOL_WIDTH = 8;
const POOL_SIZE = 128;
/**
 * Whole-journal reads replay may make for the entire pool. Linear replay rebuilds the nested runs a constant number
 * of times; the quadratic replay this guards against reads the journal twice per cached child (256 times here).
 */
const MAX_JOURNAL_READS = 4;
/** Structural: records a 128-child pooled root through the real engine before replaying it. */
const POOL_TIMEOUT_MS = 60_000;

const child = workflow({
	name: "pooled-child",
	description: "",
	inputs: { item: Type.String() },
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("work").complete(`done-${ctx.inputs.item}`);
		await ctx.tool("record", { item: ctx.inputs.item }, async () => ctx.inputs.item);
		return {};
	},
}) as WorkflowDefinition;

function pooledRoot(children: number): WorkflowDefinition {
	return workflow({
		name: "pooled-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const inFlight = new Map<number, Promise<void>>();
			let next = 0;
			while (next < children || inFlight.size > 0) {
				while (next < children && inFlight.size < POOL_WIDTH) {
					const index = next++;
					inFlight.set(
						index,
						ctx.workflow(child, { inputs: { item: `item-${index}` } }).then(() => {
							inFlight.delete(index);
						}),
					);
				}
				await Promise.race(inFlight.values());
			}
			return {};
		},
	}) as WorkflowDefinition;
}

async function completedPool(children: number): Promise<{ backend: MemoryJournalBackend; rootId: string }> {
	const backend = await createMemoryTestBackend();
	const rootId = `pooled-root-${children}`;
	const root = pooledRoot(children);
	const result = await run(
		root,
		{},
		{
			runId: rootId,
			registry: createRegistry([root, child]),
			store: createStore(),
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		},
	);
	assert.equal(result.status, "completed");
	return { backend, rootId };
}

/** Count every checkpoint the backend's `listCheckpoints` hands out from now on. */
function countCheckpointReads(backend: MemoryJournalBackend): () => number {
	let checkpointsRead = 0;
	const listCheckpoints: MemoryJournalBackend["listCheckpoints"] = backend.listCheckpoints.bind(backend);
	backend.listCheckpoints = (workflowId) => {
		const checkpoints = listCheckpoints(workflowId);
		checkpointsRead += checkpoints.length;
		return checkpoints;
	};
	return () => checkpointsRead;
}

/**
 * Replay every cached child boundary the way resume does: look up the child's
 * completed subtree, then record the replay metadata for the boundary stage.
 */
async function replayCachedBoundaries(backend: MemoryJournalBackend, rootId: string): Promise<number> {
	const checkpoints = backend.listCheckpoints(rootId);
	const terminals = checkpoints.filter(
		(checkpoint): checkpoint is DurableStageCheckpoint =>
			checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal",
	);
	let completedAt = Math.max(...checkpoints.map((checkpoint) => checkpoint.completedAt));
	for (const [index, terminal] of terminals.entries()) {
		const { boundary, ...topology } = terminal.topology!;
		assert.ok(durableCompletedNestedRunSubtree(backend, rootId, boundary!.child.runId), `child ${index} replays`);
		completedAt += 1;
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: rootId,
			checkpointId: `stage-replay-meta:scaling-${index}`,
			name: terminal.name,
			replayKey: terminal.replayKey,
			completedAt,
			topology,
		});
	}
	return terminals.length;
}

test(
	"replaying cached child boundaries reads the checkpoint journal a bounded number of times",
	async () => {
		const pool = await completedPool(POOL_SIZE);
		const checkpointsRead = countCheckpointReads(pool.backend);
		const replayed = await replayCachedBoundaries(pool.backend, pool.rootId);
		const read = checkpointsRead();
		assert.equal(replayed, POOL_SIZE);
		const journalSize = pool.backend.listCheckpoints(pool.rootId).length;
		const journalReads = read / journalSize;
		assert.ok(
			journalReads <= MAX_JOURNAL_READS,
			`replaying ${POOL_SIZE} cached children read ${read} checkpoints, ` +
				`${journalReads.toFixed(1)} times the ${journalSize}-checkpoint journal (at most ${MAX_JOURNAL_READS})`,
		);
	},
	POOL_TIMEOUT_MS,
);
