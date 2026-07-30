import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const singletonRunIds = new Set<string>();
afterEach(() => {
	for (const runId of singletonRunIds) workflowStore.removeRun(runId);
	singletonRunIds.clear();
});

function copySdk(source: ReturnType<typeof createMockSdk>): ReturnType<typeof createMockSdk> {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

function immutableRunShape(store: ReturnType<typeof createStore>, runId: string) {
	return store
		.runs()
		.find((candidate) => candidate.id === runId)!
		.stages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			parentIds: [...stage.parentIds],
		}));
}

test.sequential("fresh DBOS restores a cache-hit twig through arbitrarily stacked child scopes", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "round2-deep-writer" });
	const writerStore = createStore();
	const rootRunId = "round2-deep-root";
	let twigRuns = 0;
	const stageCalls = new Map<string, number>();
	const complete = async (text: string): Promise<string> => {
		stageCalls.set(text, (stageCalls.get(text) ?? 0) + 1);
		return text;
	};
	let holdLeaf = true;
	let reportTwigCompleted = (): void => {};
	const twigCompleted = new Promise<void>((resolve) => {
		reportTwigCompleted = resolve;
	});
	let releaseLeaf = (): void => {};
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});

	const twig = workflow({
		name: "round2-twig",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			twigRuns += 1;
			const first = await ctx.stage("twig-first").complete("twig-first");
			const second = await ctx.stage("twig-second").complete("twig-second");
			return { value: `${first}:${second}` };
		},
	});
	const leaf = workflow({
		name: "round2-leaf",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("leaf-before").complete("leaf-before");
			const nested = await ctx.workflow(twig);
			if (nested.exited) throw new Error("twig exited");
			if (holdLeaf) {
				reportTwigCompleted();
				await leafGate;
			}
			await ctx.stage("leaf-after").complete("leaf-after");
			return { value: nested.outputs.value };
		},
	});
	const middle = workflow({
		name: "round2-middle",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("middle-before").complete("middle-before");
			const nested = await ctx.workflow(leaf);
			if (nested.exited) throw new Error("leaf exited");
			await ctx.stage("middle-after").complete("middle-after");
			return { value: nested.outputs.value };
		},
	});
	const root = workflow({
		name: "round2-root",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("root-before").complete("root-before");
			const nested = await ctx.workflow(middle);
			if (nested.exited) throw new Error("middle exited");
			await ctx.stage("root-after").complete("root-after");
			return { value: nested.outputs.value };
		},
	});

	const controller = new AbortController();
	const firstRun = run(
		root,
		{},
		{
			runId: rootRunId,
			store: writerStore,
			durableBackend: writer,
			signal: controller.signal,
			adapters: { complete: { complete } },
		},
	);
	await twigCompleted;
	await writer.flush();
	assert.equal(twigRuns, 1);
	assert.equal(stageCalls.get("twig-first"), 1);
	assert.equal(stageCalls.get("twig-second"), 1);
	assert.equal(stageCalls.get("leaf-after"), undefined, "the parent of the completed twig is still incomplete");

	const rootRun = writerStore.runs().find((candidate) => candidate.id === rootRunId)!;
	const middleBoundary = rootRun.stages.find((stage) => stage.name === "workflow:round2-middle")!;
	const middleRun = writerStore.runs().find((candidate) => candidate.parentStageId === middleBoundary.id)!;
	const leafBoundary = middleRun.stages.find((stage) => stage.name === "workflow:round2-leaf")!;
	const leafRun = writerStore.runs().find((candidate) => candidate.parentStageId === leafBoundary.id)!;
	const twigBoundary = leafRun.stages.find((stage) => stage.name === "workflow:round2-twig")!;
	const twigRun = writerStore.runs().find((candidate) => candidate.parentStageId === twigBoundary.id)!;
	const runIds = [rootRunId, middleRun.id, leafRun.id, twigRun.id] as const;
	const priorShapes = new Map(runIds.map((runId) => [runId, immutableRunShape(writerStore, runId)]));
	const priorTwigGraph = expandWorkflowGraph(writerStore.snapshot(), rootRunId)
		.stages.filter((stage) => stage.workflowGraphTarget.runId === twigRun.id)
		.map((stage) => ({
			id: stage.id,
			name: stage.name,
			parentIds: [...stage.parentIds],
			target: { ...stage.workflowGraphTarget },
		}));
	const persisted = copySdk(sdk);

	controller.abort(new Error("round2 writer process stopped"));
	releaseLeaf();
	await firstRun;
	holdLeaf = false;

	const fresh = new DbosDurableBackend(persisted, { executorId: "round2-deep-fresh" });
	await fresh.hydrateWorkflow(rootRunId);
	for (const runId of runIds) singletonRunIds.add(runId);
	const freshStore = workflowStore;
	const resumed = await run(
		root,
		{},
		{
			runId: rootRunId,
			store: freshStore,
			durableBackend: fresh,
			adapters: { complete: { complete } },
		},
	);
	await fresh.flush();

	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(twigRuns, 1, "the completed deepest child must be a boundary cache hit");
	assert.equal(stageCalls.get("twig-first"), 1);
	assert.equal(stageCalls.get("twig-second"), 1);
	assert.equal(stageCalls.get("leaf-after"), 1);
	for (const runId of runIds) {
		const restored = freshStore.runs().find((candidate) => candidate.id === runId);
		assert.ok(restored, `fresh active topology must restore ${runId}`);
		assert.deepEqual(
			immutableRunShape(freshStore, runId).slice(0, priorShapes.get(runId)!.length),
			priorShapes.get(runId),
		);
	}

	const restoredTwig = freshStore.runs().find((candidate) => candidate.id === twigRun.id)!;
	assert.equal(restoredTwig.parentRunId, leafRun.id);
	assert.equal(restoredTwig.parentStageId, twigBoundary.id);
	assert.equal(restoredTwig.rootRunId, rootRunId);
	const graph = expandWorkflowGraph(freshStore.snapshot(), rootRunId);
	const twigStages = graph.stages.filter((stage) => stage.workflowGraphTarget.runId === twigRun.id);
	assert.deepEqual(
		twigStages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			parentIds: [...stage.parentIds],
			target: { ...stage.workflowGraphTarget },
		})),
		priorTwigGraph,
	);
	for (const stage of twigStages) {
		const expected = {
			ok: true as const,
			runId: twigRun.id,
			stageId: stage.workflowGraphTarget.stageId,
		};
		const target = resolveStageTarget(rootRunId, stage.id);
		assert.deepEqual(target, expected);
		assert.equal(Object.getPrototypeOf(target), Object.prototype);
		assert.equal(graph.targets.get(stage.id), stage.workflowGraphTarget);
	}
});
