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
const SMALL_POOL = 64;
const LARGE_POOL = 640;
/** Ten times the children and checkpoints; linear replay grows about 10×, the quadratic one about 100×. */
const MAX_GROWTH = 15;
const SMALL_REPETITIONS = 3;
/** Structural: records a 640-child pooled root through the real engine before timing its replay. */
const LARGE_POOL_TIMEOUT_MS = 180_000;

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

/**
 * Replay every cached child boundary the way resume does: look up the child's
 * completed subtree, then record the replay metadata for the boundary stage.
 * Returns elapsed milliseconds, or `undefined` once `budgetMs` is exceeded.
 */
async function replayCachedBoundaries(
	backend: MemoryJournalBackend,
	rootId: string,
	budgetMs: number,
): Promise<number | undefined> {
	const terminals = backend
		.listCheckpoints(rootId)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal",
		);
	let completedAt = Math.max(...backend.listCheckpoints(rootId).map((checkpoint) => checkpoint.completedAt));
	const started = performance.now();
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
		if (performance.now() - started > budgetMs) return undefined;
	}
	return performance.now() - started;
}

test(
	"replaying cached child boundaries grows about linearly with the pool",
	async () => {
		// The first replay warms the JIT; the slowest of the rest is the baseline, so load cannot shrink it.
		const smallRuns: number[] = [];
		for (let repetition = 0; repetition <= SMALL_REPETITIONS; repetition++) {
			const small = await completedPool(SMALL_POOL);
			const elapsed = await replayCachedBoundaries(small.backend, small.rootId, Number.POSITIVE_INFINITY);
			if (repetition > 0) smallRuns.push(elapsed!);
		}
		const smallMs = Math.max(1, ...smallRuns);
		const large = await completedPool(LARGE_POOL);
		const budgetMs = smallMs * MAX_GROWTH;
		const largeMs = await replayCachedBoundaries(large.backend, large.rootId, budgetMs);
		assert.ok(
			largeMs !== undefined,
			`${LARGE_POOL} cached children did not replay within ${MAX_GROWTH}× the ${SMALL_POOL}-child time (${smallMs.toFixed(1)} ms)`,
		);
	},
	LARGE_POOL_TIMEOUT_MS,
);
