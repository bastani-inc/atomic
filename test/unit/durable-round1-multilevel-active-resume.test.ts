import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function copySdk(source: ReturnType<typeof createMockSdk>) {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

function runShape(store: ReturnType<typeof createStore>, runId: string) {
	const runSnapshot = store.runs().find((candidate) => candidate.id === runId)!;
	return runSnapshot.stages.map((stage) => ({
		id: stage.id,
		name: stage.name,
		status: stage.status,
		parentIds: [...stage.parentIds],
		replayKey: stage.replayKey,
	}));
}

test("fresh DBOS resumes an active root-child-grandchild with composed scope and exactly-once tool", async () => {
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "three-level-first" });
	const firstStore = createStore();
	const rootRunId = "round1-three-level-active";
	let toolCalls = 0;
	let leafBeforeCalls = 0;
	let leafAfterCalls = 0;
	let middleBeforeCalls = 0;
	let middleAfterCalls = 0;
	let rootBeforeCalls = 0;
	let rootAfterCalls = 0;
	let holdLeaf = true;
	let releaseLeaf = (): void => {};
	const leafGate = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	let reportLeafGated = (): void => {};
	const leafGated = new Promise<void>((resolve) => {
		reportLeafGated = resolve;
	});

	const leaf = workflow({
		name: "active-three-leaf",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const tool = await ctx.tool("leaf-side-effect", { stable: true }, async () => {
				toolCalls += 1;
				return "tool-once";
			});
			const before = await ctx.stage("leaf-before").complete("leaf-before");
			if (holdLeaf) {
				reportLeafGated();
				await leafGate;
			}
			const after = await ctx.stage("leaf-after").complete("leaf-after");
			return { value: `${tool}:${before}:${after}` };
		},
	});
	const middle = workflow({
		name: "active-three-middle",
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
		name: "active-three-root",
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
	const complete = async (text: string): Promise<string> => {
		if (text === "leaf-before") leafBeforeCalls += 1;
		if (text === "leaf-after") leafAfterCalls += 1;
		if (text === "middle-before") middleBeforeCalls += 1;
		if (text === "middle-after") middleAfterCalls += 1;
		if (text === "root-before") rootBeforeCalls += 1;
		if (text === "root-after") rootAfterCalls += 1;
		return text;
	};

	const firstController = new AbortController();
	const firstPromise = run(
		root,
		{},
		{
			runId: rootRunId,
			store: firstStore,
			durableBackend: firstBackend,
			signal: firstController.signal,
			adapters: { complete: { complete } },
		},
	);
	await leafGated;
	await firstBackend.flush();
	assert.equal(toolCalls, 1);
	assert.equal(leafBeforeCalls, 1);
	assert.equal(leafAfterCalls, 0);
	const firstRoot = firstStore.runs().find((candidate) => candidate.id === rootRunId)!;
	const firstMiddleBoundary = firstRoot.stages.find((stage) => stage.name === "workflow:active-three-middle")!;
	const firstMiddle = firstStore.runs().find((candidate) => candidate.parentStageId === firstMiddleBoundary.id)!;
	const firstLeafBoundary = firstMiddle.stages.find((stage) => stage.name === "workflow:active-three-leaf")!;
	const firstLeaf = firstStore.runs().find((candidate) => candidate.parentStageId === firstLeafBoundary.id)!;
	const firstMiddleBoundaryStatus = firstMiddleBoundary.status;
	const firstLeafBoundaryStatus = firstLeafBoundary.status;
	const firstShapes = new Map([
		[rootRunId, runShape(firstStore, rootRunId)],
		[firstMiddle.id, runShape(firstStore, firstMiddle.id)],
		[firstLeaf.id, runShape(firstStore, firstLeaf.id)],
	]);
	const physicalStages = firstBackend
		.listCheckpoints(rootRunId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
	const middleBoundaryCheckpoint = physicalStages.find(
		(checkpoint) =>
			checkpoint.topology?.boundary?.child.runId === firstMiddle.id &&
			checkpoint.topology.boundary.event === "start",
	)!;
	const leafBoundaryCheckpoint = physicalStages.find(
		(checkpoint) =>
			checkpoint.topology?.boundary?.child.runId === firstLeaf.id && checkpoint.topology.boundary.event === "start",
	)!;
	const middleScope = middleBoundaryCheckpoint.replayKey;
	assert.match(middleScope, /^workflow:workflow:active-three-middle:h[0-9a-f]{32}:1$/);
	assert.match(
		leafBoundaryCheckpoint.replayKey,
		/^workflow:workflow:active-three-middle:h[0-9a-f]{32}:1:workflow:workflow:active-three-leaf:h[0-9a-f]{32}:1$/,
	);
	const composedScope = leafBoundaryCheckpoint.replayKey;
	assert.equal(leafBoundaryCheckpoint.topology?.boundary?.replayScope, composedScope);
	assert.ok(middleBoundaryCheckpoint.topology?.boundary?.invocationFingerprint);
	assert.ok(leafBoundaryCheckpoint.topology?.boundary?.invocationFingerprint);
	const toolCheckpoint = firstBackend
		.listCheckpoints(rootRunId)
		.find((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "leaf-side-effect");
	assert.ok(toolCheckpoint?.checkpointId.startsWith(`${composedScope}:`));
	const persisted = copySdk(sdk);

	firstController.abort(new Error("old three-level process stopped"));
	releaseLeaf();
	await firstPromise;
	holdLeaf = false;

	const freshBackend = new DbosDurableBackend(persisted, { executorId: "three-level-fresh" });
	await freshBackend.hydrateWorkflow(rootRunId);
	const freshStore = createStore();
	const resumed = await run(
		root,
		{},
		{
			runId: rootRunId,
			store: freshStore,
			durableBackend: freshBackend,
			adapters: { complete: { complete } },
		},
	);
	await freshBackend.flush();
	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(toolCalls, 1, "grandchild ctx.tool must remain exactly once");
	assert.equal(leafBeforeCalls, 1);
	assert.equal(leafAfterCalls, 1);
	assert.equal(middleBeforeCalls, 1);
	assert.equal(middleAfterCalls, 1);
	assert.equal(rootBeforeCalls, 1);
	assert.equal(rootAfterCalls, 1);

	const freshRoot = freshStore.runs().find((candidate) => candidate.id === rootRunId)!;
	const freshMiddleBoundary = freshRoot.stages.find((stage) => stage.name === "workflow:active-three-middle")!;
	const freshMiddle = freshStore.runs().find((candidate) => candidate.parentStageId === freshMiddleBoundary.id)!;
	const freshLeafBoundary = freshMiddle.stages.find((stage) => stage.name === "workflow:active-three-leaf")!;
	const freshLeaf = freshStore.runs().find((candidate) => candidate.parentStageId === freshLeafBoundary.id)!;
	assert.equal(freshMiddleBoundary.id, firstMiddleBoundary.id);
	assert.equal(freshMiddle.id, firstMiddle.id);
	assert.equal(freshLeafBoundary.id, firstLeafBoundary.id);
	assert.equal(freshLeaf.id, firstLeaf.id);
	for (const [runId, priorShape] of firstShapes) {
		const resumedShape = runShape(freshStore, runId).slice(0, priorShape.length);
		const immutable = (shape: typeof priorShape) => shape.map(({ status: _status, ...stage }) => stage);
		assert.deepEqual(immutable(resumedShape), immutable(priorShape), runId);
	}
	assert.equal(firstMiddleBoundaryStatus, "running");
	assert.equal(firstLeafBoundaryStatus, "running");
	assert.equal(freshMiddleBoundary.status, "completed");
	assert.equal(freshLeafBoundary.status, "completed");
	assert.equal(freshMiddle.parentRunId, rootRunId);
	assert.equal(freshMiddle.parentStageId, freshMiddleBoundary.id);
	assert.equal(freshMiddle.rootRunId, rootRunId);
	assert.equal(freshLeaf.parentRunId, freshMiddle.id);
	assert.equal(freshLeaf.parentStageId, freshLeafBoundary.id);
	assert.equal(freshLeaf.rootRunId, rootRunId);
	const freshLeafBoundaryCheckpoint = freshBackend
		.listCheckpoints(rootRunId)
		.find((checkpoint) => checkpoint.kind === "stage" && checkpoint.topology?.boundary?.child.runId === freshLeaf.id);
	assert.equal(
		freshLeafBoundaryCheckpoint?.kind === "stage" ? freshLeafBoundaryCheckpoint.replayKey : undefined,
		composedScope,
	);
	assert.equal(
		freshLeafBoundaryCheckpoint?.kind === "stage"
			? freshLeafBoundaryCheckpoint.topology?.boundary?.replayScope
			: undefined,
		composedScope,
	);
});
