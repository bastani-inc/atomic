import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

/**
 * Every nested run reconstruction validates the boundary records first, exactly
 * once, so counting that call counts reconstructions without a production seam.
 */
const reconstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../packages/workflows/src/durable/completed-catalog-stage-groups.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../packages/workflows/src/durable/completed-catalog-stage-groups.js")>();
	return {
		...actual,
		validBoundaryRecordSet: (...args: Parameters<typeof actual.validBoundaryRecordSet>) => {
			reconstructions.count += 1;
			return actual.validBoundaryRecordSet(...args);
		},
	};
});

afterEach(closeMemoryTestBackends);

const CHILDREN = 128;
const POOL_WIDTH = 8;
/**
 * Reconstructions one resume may perform, independent of the child count. Replay
 * looks the nested runs up once per cached child, so rebuilding them on each
 * lookup would take at least CHILDREN.
 */
const MAX_RESUME_RECONSTRUCTIONS = 8;
/** Structural: runs a 128-child pooled root through the real engine twice. */
const POOLED_RESUME_TIMEOUT_MS = 60_000;

function childRuns(store: Store, rootId: string) {
	return store
		.runs()
		.filter((candidate) => candidate.id !== rootId)
		.map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			status: candidate.status,
			parentRunId: candidate.parentRunId,
			stages: candidate.stages.map((stage) => [stage.name, stage.status, stage.result]),
			// A replayed tool reports `cached` where the live call reported `completed`.
			tools: candidate.toolNodes.map((tool) => [
				tool.name,
				tool.status === "cached" ? "completed" : tool.status,
				tool.result,
			]),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

test(
	"resuming a pooled root replays every completed child without re-running it or rebuilding its nested runs per child",
	async () => {
		const backend = await createMemoryTestBackend();
		const executions = new Map<string, number>();
		let interrupt = true;
		const child = workflow({
			name: "pooled-child",
			description: "",
			inputs: { item: Type.String() },
			outputs: { value: Type.String() },
			run: async (ctx) => {
				await ctx.stage("work").complete(`done-${ctx.inputs.item}`);
				const value = await ctx.tool("record", { item: ctx.inputs.item }, async () => {
					executions.set(ctx.inputs.item, (executions.get(ctx.inputs.item) ?? 0) + 1);
					return ctx.inputs.item;
				});
				return { value };
			},
		});
		const root = workflow({
			name: "pooled-root",
			description: "",
			inputs: {},
			outputs: { values: Type.Array(Type.String()) },
			run: async (ctx) => {
				const values: string[] = [];
				const inFlight = new Map<number, Promise<void>>();
				let next = 0;
				while (next < CHILDREN || inFlight.size > 0) {
					while (next < CHILDREN && inFlight.size < POOL_WIDTH) {
						const index = next++;
						inFlight.set(
							index,
							ctx.workflow(child, { inputs: { item: `item-${index}` } }).then((result) => {
								if (!result.exited) values[index] = String(result.outputs.value);
								inFlight.delete(index);
							}),
						);
					}
					await Promise.race(inFlight.values());
				}
				await ctx.tool("finish", {}, async () => {
					if (interrupt) throw new Error("interrupted after every child completed");
					return true;
				});
				return { values };
			},
		});
		const rootId = "pooled-root-resume";
		const options = (store: Store) => ({
			runId: rootId,
			registry: createRegistry([root, child] as WorkflowDefinition[]),
			store,
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		});

		const firstStore = createStore();
		const first = await run(root, {}, options(firstStore));
		assert.equal(first.status, "failed");
		assert.equal(executions.size, CHILDREN);

		interrupt = false;
		const resumedStore = createStore();
		reconstructions.count = 0;
		const resumed = await run(root, {}, options(resumedStore));
		const resumeReconstructions = reconstructions.count;
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(
			resumed.result?.values,
			Array.from({ length: CHILDREN }, (_, index) => `item-${index}`),
		);
		assert.ok(
			[...executions.values()].every((count) => count === 1),
			"no completed child re-ran its work",
		);
		const resumedChildren = childRuns(resumedStore, rootId);
		assert.equal(resumedChildren.length, CHILDREN);
		assert.deepEqual(resumedChildren, childRuns(firstStore, rootId));
		assert.ok(
			resumeReconstructions <= MAX_RESUME_RECONSTRUCTIONS,
			`resume rebuilt the nested runs ${resumeReconstructions} times for ${CHILDREN} cached children`,
		);
	},
	POOLED_RESUME_TIMEOUT_MS,
);
