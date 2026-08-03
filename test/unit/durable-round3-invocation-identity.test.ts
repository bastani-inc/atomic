import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function copySdk(source: ReturnType<typeof createMockSdk>): ReturnType<typeof createMockSdk> {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

interface InvocationObservation {
	readonly result: string;
	readonly runId: string;
}

function boundaryStarts(backend: DbosDurableBackend, rootId: string): DurableStageCheckpoint[] {
	return backend
		.listCheckpoints(rootId)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "start",
		);
}

function graphIdentity(store: ReturnType<typeof createStore>, rootId: string) {
	return expandWorkflowGraph(store.snapshot(), rootId).stages.map((stage) => ({
		id: stage.id,
		name: stage.name,
		parentIds: [...stage.parentIds],
		target: {
			runId: stage.workflowGraphTarget.runId,
			stageId: stage.workflowGraphTarget.stageId,
		},
	}));
}

test("fresh DBOS restart binds reversed parallel calls to exact validated inputs and keeps identical calls distinct", async () => {
	const rootId = "round3-invocation-root";
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "round3-invocation-writer" });
	const blocked = deferred();
	const reachedInterruption = deferred();
	let process: "writer" | "fresh" = "writer";
	const toolCounts = new Map<string, number>();
	const adapterCounts = new Map<string, number>();

	const child = workflow({
		name: "round3-invocation-child",
		description: "",
		inputs: { raw: Type.String() },
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const raw = ctx.inputs.raw;
			const sideEffect = await ctx.tool("input-counter", { raw }, async () => {
				toolCounts.set(raw, (toolCounts.get(raw) ?? 0) + 1);
				return raw;
			});
			const value = await ctx.stage("input-stage").complete(sideEffect);
			return { value };
		},
	});

	const parent = workflow({
		name: "round3-invocation-parent",
		description: "",
		inputs: {},
		outputs: { summary: Type.String() },
		run: async (ctx) => {
			const invoke = async (raw: string): Promise<InvocationObservation> => {
				const result = await ctx.workflow(child, { inputs: { raw } });
				return { result: result.outputs.value ?? "missing", runId: result.runId };
			};
			let a: Promise<InvocationObservation>;
			let b: Promise<InvocationObservation>;
			let c1: Promise<InvocationObservation>;
			let c2: Promise<InvocationObservation>;
			if (process === "writer") {
				a = invoke("  A\n");
				b = invoke("B");
				c1 = invoke("同じ");
				c2 = invoke("同じ");
			} else {
				c2 = invoke("同じ");
				c1 = invoke("同じ");
				b = invoke("B");
				a = invoke("  A\n");
			}
			const [aResult, bResult, c1Result, c2Result] = await Promise.all([a, b, c1, c2]);
			if (process === "writer") {
				reachedInterruption.resolve();
				await blocked.promise;
			}
			return {
				summary: JSON.stringify({
					a: aResult.result,
					b: bResult.result,
					c1: c1Result.result,
					c2: c2Result.result,
					runIds: [aResult.runId, bResult.runId, c1Result.runId, c2Result.runId],
				}),
			};
		},
	});

	const complete = async (text: string): Promise<string> => {
		adapterCounts.set(text, (adapterCounts.get(text) ?? 0) + 1);
		return text;
	};
	const writerStore = createStore();
	const writerRun = run(
		parent,
		{},
		{
			runId: rootId,
			store: writerStore,
			durableBackend: writer,
			adapters: { complete: { complete } },
		},
	);
	await reachedInterruption.promise;
	await writer.flush();
	const writerStarts = boundaryStarts(writer, rootId);
	assert.equal(writerStarts.length, 4);
	assert.ok(writerStarts.every((start) => start.topology?.boundary?.invocationFingerprint !== undefined));
	assert.equal(new Set(writerStarts.map((start) => start.topology!.stageId)).size, 4);
	const cFingerprints = writerStarts.map((start) => start.topology!.boundary!.invocationFingerprint);
	assert.equal(
		new Set(cFingerprints).size,
		3,
		"distinct inputs have distinct fingerprints; identical inputs share one",
	);
	const beforeIdentity = graphIdentity(writerStore, rootId);
	const persisted = copySdk(sdk);
	const terminalIds = writer
		.listCheckpoints(rootId)
		.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal")
		.map((checkpoint) => checkpoint.checkpointId)
		.sort();

	process = "fresh";
	const fresh = new DbosDurableBackend(persisted, { executorId: "round3-invocation-fresh" });
	await fresh.hydrateWorkflow(rootId);
	const freshStore = createStore();
	const resumed = await run(
		parent,
		{},
		{
			runId: rootId,
			store: freshStore,
			durableBackend: fresh,
			adapters: { complete: { complete } },
		},
	);
	assert.equal(resumed.status, "completed");
	const summary = JSON.parse(resumed.result?.summary as string) as {
		a: string;
		b: string;
		c1: string;
		c2: string;
		runIds: string[];
	};
	assert.deepEqual(
		{ a: summary.a, b: summary.b, c1: summary.c1, c2: summary.c2 },
		{
			a: "  A\n",
			b: "B",
			c1: "同じ",
			c2: "同じ",
		},
	);
	assert.equal(new Set(summary.runIds).size, 4, "identical invocations retain distinct child runs");
	assert.deepEqual(
		[...toolCounts.entries()].sort(),
		[
			["  A\n", 1],
			["B", 1],
			["同じ", 2],
		].sort(),
	);
	assert.deepEqual(
		[...adapterCounts.entries()].sort(),
		[
			["  A\n", 1],
			["B", 1],
			["同じ", 2],
		].sort(),
	);
	assert.deepEqual(graphIdentity(freshStore, rootId), beforeIdentity);
	assert.equal(boundaryStarts(fresh, rootId).length, 4);
	assert.deepEqual(
		fresh
			.listCheckpoints(rootId)
			.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal")
			.map((checkpoint) => checkpoint.checkpointId)
			.sort(),
		terminalIds,
		"cache replay adds no duplicate boundary terminal writes",
	);

	blocked.resolve();
	assert.equal((await writerRun).status, "completed");
});
