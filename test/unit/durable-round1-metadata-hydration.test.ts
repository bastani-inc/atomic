import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

async function waitForPendingPrompt(store: ReturnType<typeof createStore>) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stage = runSnapshot.stages.find((candidate) => candidate.pendingPrompt !== undefined);
			if (stage?.pendingPrompt !== undefined) {
				return { runId: runSnapshot.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
			}
		}
		await sleep(5);
	}
	throw new Error("pending prompt did not appear");
}

function copySdk(source: ReturnType<typeof createMockSdk>) {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

test("fresh DBOS completed inspection retains handled failed stage ancestry into a child descendant", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk);
	const store = createStore();
	const runId = "round1-handled-failed-stage";
	const child = workflow({
		name: "handled-failure-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("descendant").complete("descendant") }),
	});
	const parent = workflow({
		name: "handled-failure-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			try {
				await ctx.stage("handled-failure").complete("fail-now");
			} catch {
				// The workflow intentionally handles this stage failure and continues.
			}
			const nested = await ctx.workflow(child);
			if (nested.exited) throw new Error("child exited");
			return { value: nested.outputs.value };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: {
				complete: {
					complete: async (text) => {
						if (text === "fail-now") throw new Error("handled failure");
						return text;
					},
				},
			},
		},
	);
	await backend.flush();
	assert.equal(result.status, "completed");
	const liveGraph = expandWorkflowGraph(store.snapshot(), runId);
	const liveRoot = store.runs().find((candidate) => candidate.id === runId)!;
	assert.equal(liveRoot.stages[0]?.status, "failed");

	const fresh = new DbosDurableBackend(copySdk(sdk), { executorId: "handled-failure-fresh" });
	await fresh.hydrateWorkflow(runId);
	const entry = fresh.listCompletedWorkflows()[0]!;
	const hydratedRuns = completedWorkflowRunSnapshots(fresh, entry);
	const hydratedGraph = expandWorkflowGraph({ runs: hydratedRuns, notices: [], version: 1 }, runId);
	const shape = (graph: typeof liveGraph) =>
		graph.stages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			status: stage.status,
			parentIds: [...stage.parentIds],
			target: { ...stage.workflowGraphTarget },
		}));
	assert.deepEqual(shape(hydratedGraph), shape(liveGraph));
	assert.deepEqual(
		hydratedGraph.stages.map((stage) => stage.name),
		["handled-failure", "descendant"],
	);
	assert.equal(hydratedGraph.stages[0]?.status, "failed");
	assert.deepEqual(hydratedGraph.stages[1]?.parentIds, [hydratedGraph.stages[0]?.id]);
});

test("answered prompt-node topology survives fresh DBOS active-child resume without asking again", async () => {
	const sdkState = createMockSdk();
	let holdPromptWrite = true;
	let releasePromptWrite = (): void => {};
	const promptWriteGate = new Promise<void>((resolve) => {
		releasePromptWrite = resolve;
	});
	let reportPromptWrite = (): void => {};
	const promptWriteStarted = new Promise<void>((resolve) => {
		reportPromptWrite = resolve;
	});
	const recordStepOutput = sdkState.recordStepOutput.bind(sdkState);
	const sdk: ReturnType<typeof createMockSdk> = {
		...sdkState,
		state: sdkState.state,
		async recordStepOutput(workflowId, stepName, output) {
			const envelope =
				typeof output === "object" && output !== null && !Array.isArray(output)
					? (output as Record<string, WorkflowSerializableValue>)
					: undefined;
			const topology =
				typeof envelope?.topology === "object" && envelope.topology !== null
					? (envelope.topology as Record<string, WorkflowSerializableValue>)
					: undefined;
			if (
				holdPromptWrite &&
				envelope?.kind === "stage" &&
				envelope.name === "input" &&
				topology?.status === "completed"
			) {
				reportPromptWrite();
				await promptWriteGate;
			}
			await recordStepOutput(workflowId, stepName, output);
		},
	};
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "prompt-first" });
	const firstStore = createStore();
	const runId = "round1-prompt-active-child";
	let childStageCalls = 0;
	let holdChild = true;
	let releaseChild = (): void => {};
	const childGate = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});
	let reportChildStarted = (): void => {};
	const childStarted = new Promise<void>((resolve) => {
		reportChildStarted = resolve;
	});
	const child = workflow({
		name: "prompt-active-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("child-active").complete("child-active") }),
	});
	const parent = workflow({
		name: "prompt-active-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const answer = await ctx.ui.input("Durable answer?");
			const nested = await ctx.workflow(child);
			if (nested.exited) throw new Error("child exited");
			return { value: `${answer}:${nested.outputs.value}` };
		},
	});
	const complete = async (text: string): Promise<string> => {
		if (text === "child-active") {
			childStageCalls += 1;
			if (holdChild) {
				reportChildStarted();
				await childGate;
			}
		}
		return text;
	};
	const firstController = new AbortController();
	const firstPromise = run(
		parent,
		{},
		{
			runId,
			store: firstStore,
			durableBackend: firstBackend,
			signal: firstController.signal,
			usePromptNodesForUi: true,
			adapters: { complete: { complete } },
		},
	);
	const pending = await waitForPendingPrompt(firstStore);
	assert.equal(firstStore.resolveStagePendingPrompt(runId, pending.stageId, pending.promptId, "answer"), true);
	await promptWriteStarted;
	await Promise.resolve();
	assert.equal(childStageCalls, 0, "child dispatch waits for durable prompt-node finalization");
	holdPromptWrite = false;
	releasePromptWrite();
	await childStarted;
	await firstBackend.flush();
	const originalRoot = firstStore.runs().find((candidate) => candidate.id === runId)!;
	const originalPrompt = originalRoot.stages.find((stage) => stage.name === "input")!;
	const originalBoundary = originalRoot.stages.find((stage) => stage.name === "workflow:prompt-active-child")!;
	const originalChild = firstStore.runs().find((candidate) => candidate.parentStageId === originalBoundary.id)!;
	assert.equal(originalPrompt.status, "completed");
	assert.deepEqual(originalBoundary.parentIds, [originalPrompt.id]);
	const promptCheckpoints = firstBackend
		.listCheckpoints(runId)
		.filter(
			(checkpoint) =>
				checkpoint.kind === "stage" &&
				checkpoint.name === "input" &&
				checkpoint.topology?.stageId === originalPrompt.id,
		);
	assert.ok(promptCheckpoints.length > 0);
	assert.ok(promptCheckpoints.every((checkpoint) => checkpoint.kind === "stage" && checkpoint.output === undefined));
	const persisted = copySdk(sdk);

	firstController.abort(new Error("old prompt process stopped"));
	releaseChild();
	await firstPromise;
	holdChild = false;

	const freshBackend = new DbosDurableBackend(persisted, { executorId: "prompt-fresh" });
	await freshBackend.hydrateWorkflow(runId);
	const freshStore = createStore();
	const resumed = await run(
		parent,
		{},
		{
			runId,
			store: freshStore,
			durableBackend: freshBackend,
			usePromptNodesForUi: true,
			adapters: { complete: { complete } },
		},
	);
	await freshBackend.flush();
	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(resumed.result?.value, "answer:child-active");
	assert.equal(childStageCalls, 2, "only the interrupted child stage reruns");
	const freshRoot = freshStore.runs().find((candidate) => candidate.id === runId)!;
	const freshPrompt = freshRoot.stages.find((stage) => stage.name === "input")!;
	const freshBoundary = freshRoot.stages.find((stage) => stage.name === "workflow:prompt-active-child")!;
	const freshChild = freshStore.runs().find((candidate) => candidate.parentStageId === freshBoundary.id)!;
	assert.equal(freshPrompt.id, originalPrompt.id);
	assert.equal(freshPrompt.status, "completed");
	assert.deepEqual(freshPrompt.parentIds, originalPrompt.parentIds);
	assert.equal(freshPrompt.pendingPrompt, undefined, "the answered UI must not be asked again");
	assert.equal(freshBoundary.id, originalBoundary.id);
	assert.deepEqual(freshBoundary.parentIds, [freshPrompt.id]);
	assert.equal(freshChild.id, originalChild.id);
	assert.equal(freshChild.parentRunId, runId);
	assert.equal(freshChild.parentStageId, freshBoundary.id);
	assert.equal(freshChild.rootRunId, runId);
});
