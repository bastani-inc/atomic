import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

test("fresh DBOS backend resumes an active nested child with stable identity and exactly-once work", async () => {
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "first-process" });
	const firstStore = createStore();
	const runId = "wf-active-nested-resume";
	let toolCalls = 0;
	let firstStageCalls = 0;
	let secondStageCalls = 0;
	let downstreamCalls = 0;
	let holdSecondStage = true;
	let releaseSecondStage = (): void => {};
	const secondStageGate = new Promise<void>((resolve) => {
		releaseSecondStage = resolve;
	});
	let reportSecondStageStarted = (): void => {};
	const secondStageStarted = new Promise<void>((resolve) => {
		reportSecondStageStarted = resolve;
	});

	const child = workflow({
		name: "active-resume-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const toolValue = await ctx.tool("nested-side-effect", { stable: true }, async () => {
				toolCalls += 1;
				return "tool-once";
			});
			const first = await ctx.stage("child-first").complete("first");
			const second = await ctx.stage("child-second").complete("second");
			return { value: `${toolValue}:${first}:${second}` };
		},
	});
	const parent = workflow({
		name: "active-resume-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("parent-before").complete("before");
			const nested = await ctx.workflow(child);
			if (nested.exited) throw new Error("child exited");
			await ctx.stage("parent-after").complete("after");
			downstreamCalls += 1;
			return { value: nested.outputs.value };
		},
	});
	const complete = async (text: string): Promise<string> => {
		if (text === "first") firstStageCalls += 1;
		if (text === "second") {
			secondStageCalls += 1;
			if (holdSecondStage) {
				reportSecondStageStarted();
				await secondStageGate;
			}
		}
		return text;
	};

	const firstController = new AbortController();
	const firstRunPromise = run(
		parent,
		{},
		{
			runId,
			store: firstStore,
			durableBackend: firstBackend,
			signal: firstController.signal,
			adapters: { complete: { complete } },
		},
	);
	await secondStageStarted;
	await firstBackend.flush();
	assert.equal(toolCalls, 1);
	assert.equal(firstStageCalls, 1);
	assert.equal(secondStageCalls, 1);
	assert.equal(downstreamCalls, 0);

	// Copy only committed DBOS state into a new SDK handle, modeling a process
	// crash while the child boundary and its second stage are still active.
	const persistedSdk = createMockSdk();
	for (const [key, value] of sdk.state.workflows) persistedSdk.state.workflows.set(key, { ...value });
	for (const [key, value] of sdk.state.steps) persistedSdk.state.steps.set(key, structuredClone(value));

	const firstRoot = firstStore.runs().find((candidate) => candidate.id === runId)!;
	const firstBoundary = firstRoot.stages.find((stage) => stage.name === "workflow:active-resume-child")!;
	const firstChild = firstStore.runs().find((candidate) => candidate.parentStageId === firstBoundary.id)!;
	const firstChildStage = firstChild.stages.find((stage) => stage.name === "child-first")!;

	firstController.abort(new Error("old process stopped"));
	releaseSecondStage();
	await firstRunPromise;

	holdSecondStage = false;
	const freshBackend = new DbosDurableBackend(persistedSdk, { executorId: "second-process" });
	await freshBackend.hydrateWorkflow(runId);
	const freshStore = createStore();
	const resumed = await run(
		parent,
		{},
		{
			runId,
			store: freshStore,
			durableBackend: freshBackend,
			adapters: { complete: { complete } },
		},
	);
	await freshBackend.flush();

	assert.equal(resumed.status, "completed");
	assert.equal(toolCalls, 1, "the durable nested tool side effect must not repeat");
	assert.equal(firstStageCalls, 1, "the completed child stage must be a cache hit");
	assert.equal(secondStageCalls, 2, "only the incomplete child stage resumes");
	assert.equal(downstreamCalls, 1, "downstream parent work runs exactly once");

	const resumedRoot = freshStore.runs().find((candidate) => candidate.id === runId)!;
	const resumedBoundary = resumedRoot.stages.find((stage) => stage.name === "workflow:active-resume-child")!;
	const resumedChild = freshStore.runs().find((candidate) => candidate.parentStageId === resumedBoundary.id)!;
	const resumedChildFirst = resumedChild.stages.find((stage) => stage.name === "child-first")!;
	assert.equal(resumedBoundary.id, firstBoundary.id);
	assert.equal(resumedChild.id, firstChild.id);
	assert.equal(resumedChild.parentRunId, runId);
	assert.equal(resumedChild.parentStageId, firstBoundary.id);
	assert.equal(resumedChild.rootRunId, runId);
	assert.equal(resumedChildFirst.id, firstChildStage.id);
	assert.deepEqual(resumedChildFirst.parentIds, firstChildStage.parentIds);
});

test.sequential("colliding child-local stage IDs and names require an exact virtual target", () => {
	const rootId = "collision-root";
	const firstRunId = "collision-child-first";
	const secondRunId = "collision-child-second";
	workflowStore.recordRunStart({
		id: rootId,
		name: "root",
		inputs: {},
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		stages: [
			{
				id: "boundary-first",
				name: "workflow:child",
				status: "completed",
				parentIds: [],
				startedAt: 1,
				endedAt: 2,
				toolEvents: [],
				attachable: false,
				workflowChild: { alias: "child", workflow: "child", runId: firstRunId, status: "completed", outputs: {} },
			},
			{
				id: "boundary-second",
				name: "workflow:child",
				status: "completed",
				parentIds: [],
				startedAt: 1,
				endedAt: 2,
				toolEvents: [],
				attachable: false,
				workflowChild: { alias: "child", workflow: "child", runId: secondRunId, status: "completed", outputs: {} },
			},
		],
	});
	for (const childRunId of [firstRunId, secondRunId]) {
		workflowStore.recordRunStart({
			id: childRunId,
			name: "child",
			inputs: {},
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			parentRunId: rootId,
			parentStageId: childRunId === firstRunId ? "boundary-first" : "boundary-second",
			rootRunId: rootId,
			stages: [
				{
					id: "shared-local-id",
					name: "shared-name",
					status: "completed",
					parentIds: [],
					startedAt: 1,
					endedAt: 2,
					toolEvents: [],
					attachable: false,
				},
			],
		});
	}

	const localId = resolveStageTarget(rootId, "shared-local-id");
	assert.equal(localId.ok, false);
	if (!localId.ok) assert.match(localId.message, /Ambiguous stage identifier/);
	const localName = resolveStageTarget(rootId, "shared-name");
	assert.equal(localName.ok, false);
	const exact = resolveStageTarget(rootId, `${firstRunId}:shared-local-id`);
	assert.deepEqual(exact, { ok: true, runId: firstRunId, stageId: "shared-local-id" });

	workflowStore.removeRun(firstRunId);
	workflowStore.removeRun(secondRunId);
	workflowStore.removeRun(rootId);
});

test("fresh DBOS completed inspection preserves repeated parallel multi-level topology", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk);
	const liveStore = createStore();
	const runId = "wf-multilevel-topology";
	const complete = { complete: async (text: string): Promise<string> => text };

	const leaf = workflow({
		name: "topology-leaf",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("leaf-stage").complete("leaf") }),
	});
	const middle = workflow({
		name: "topology-middle",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("middle-before").complete("middle-before");
			const sequential = await ctx.workflow(leaf, { stageName: "leaf-sequential" });
			const parallel = await Promise.all([
				ctx.workflow(leaf, { stageName: "leaf-parallel-a" }),
				ctx.workflow(leaf, { stageName: "leaf-parallel-b" }),
			]);
			await ctx.stage("middle-after").complete("middle-after");
			if (sequential.exited || parallel.some((result) => result.exited)) throw new Error("leaf exited");
			return { value: "middle" };
		},
	});
	const sibling = workflow({
		name: "topology-sibling",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("sibling-stage").complete("sibling") }),
	});
	const parent = workflow({
		name: "topology-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("parent-before").complete("parent-before");
			const [nested, beside] = await Promise.all([ctx.workflow(middle), ctx.workflow(sibling)]);
			await ctx.stage("parent-after").complete("parent-after");
			if (nested.exited || beside.exited) throw new Error("child exited");
			return { value: `${nested.outputs.value}:${beside.outputs.value}` };
		},
	});

	const result = await run(
		parent,
		{},
		{
			runId,
			store: liveStore,
			durableBackend: backend,
			adapters: { complete },
		},
	);
	await backend.flush();
	assert.equal(result.status, "completed");
	assert.equal(sdk.state.workflows.size, 1, "only the root is a durable catalog row");
	const liveGraph = expandWorkflowGraph(liveStore.snapshot(), runId);

	const fresh = new DbosDurableBackend(sdk);
	await fresh.hydrateWorkflow(runId);
	const completedEntries = fresh.listCompletedWorkflows();
	assert.deepEqual(
		completedEntries.map((entry) => entry.workflowId),
		[runId],
	);
	const runs = completedWorkflowRunSnapshots(fresh, completedEntries[0]!);
	const hydratedGraph = expandWorkflowGraph({ runs, notices: [], version: 1 }, runId);

	const graphShape = (graph: typeof liveGraph) =>
		graph.stages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			parentIds: [...stage.parentIds],
			target: { ...stage.workflowGraphTarget },
		}));
	assert.deepEqual(graphShape(hydratedGraph), graphShape(liveGraph));
	assert.deepEqual(
		hydratedGraph.stages.map((stage) => stage.name),
		[
			"parent-before",
			"middle-before",
			"leaf-stage",
			"leaf-stage",
			"leaf-stage",
			"middle-after",
			"sibling-stage",
			"parent-after",
		],
	);
	for (const target of hydratedGraph.targets.values()) {
		assert.equal(typeof target.runId, "string");
		assert.equal(typeof target.stageId, "string");
	}
});

test("fresh DBOS replay caches a completed child before downstream parent work", async () => {
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk);
	const firstStore = createStore();
	const runId = "wf-completed-child-downstream";
	let childCalls = 0;
	let downstreamCalls = 0;
	let holdAfterChild = true;
	let reportChildComplete = (): void => {};
	const childComplete = new Promise<void>((resolve) => {
		reportChildComplete = resolve;
	});
	let releaseParent = (): void => {};
	const parentGate = new Promise<void>((resolve) => {
		releaseParent = resolve;
	});

	const child = workflow({
		name: "cached-before-downstream-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			childCalls += 1;
			return { value: await ctx.stage("child-done").complete("child-done") };
		},
	});
	const parent = workflow({
		name: "cached-before-downstream-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const nested = await ctx.workflow(child);
			if (nested.exited) throw new Error("child exited");
			if (holdAfterChild) {
				reportChildComplete();
				await parentGate;
			}
			await ctx.stage("parent-downstream").complete("parent-downstream");
			downstreamCalls += 1;
			return { value: nested.outputs.value };
		},
	});
	const firstController = new AbortController();
	const firstPromise = run(
		parent,
		{},
		{
			runId,
			store: firstStore,
			durableBackend: firstBackend,
			signal: firstController.signal,
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	await childComplete;
	await firstBackend.flush();
	const firstBoundary = firstStore.runs().find((candidate) => candidate.id === runId)!.stages[0]!;
	const persistedSdk = createMockSdk();
	for (const [key, value] of sdk.state.workflows) persistedSdk.state.workflows.set(key, { ...value });
	for (const [key, value] of sdk.state.steps) persistedSdk.state.steps.set(key, structuredClone(value));
	firstController.abort(new Error("old process stopped"));
	releaseParent();
	await firstPromise;

	holdAfterChild = false;
	const fresh = new DbosDurableBackend(persistedSdk);
	await fresh.hydrateWorkflow(runId);
	const freshStore = createStore();
	const resumed = await run(
		parent,
		{},
		{
			runId,
			store: freshStore,
			durableBackend: fresh,
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	await fresh.flush();
	assert.equal(resumed.status, "completed");
	assert.equal(childCalls, 1);
	assert.equal(downstreamCalls, 1);
	assert.equal(freshStore.runs().find((candidate) => candidate.id === runId)?.stages[0]?.id, firstBoundary.id);
	const boundaryTerminals = fresh
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.checkpointId.includes("boundary-terminal:"));
	assert.equal(boundaryTerminals.length, 1);
});

test("durable boundary records preserve failed and exited child lifecycle without stale links", async () => {
	const backend = new DbosDurableBackend(createMockSdk());
	const runId = "wf-boundary-statuses";
	const failing = workflow({
		name: "status-failing-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("child-fails").complete("fail-child") }),
	});
	const exited = workflow({
		name: "status-exited-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ctx.exit({ status: "skipped", reason: "intentional", outputs: { value: "partial" } }),
	});
	const parent = workflow({
		name: "status-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			try {
				await ctx.workflow(failing);
			} catch {
				// A handled failed child remains visible as a failed boundary.
			}
			const child = await ctx.workflow(exited);
			return { value: child.outputs.value ?? "partial" };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: backend,
			adapters: {
				complete: {
					complete: async (text) => {
						if (text === "fail-child") throw new Error("expected child failure");
						return text;
					},
				},
			},
		},
	);
	await backend.flush();
	assert.equal(result.status, "completed");
	const terminals = backend
		.listCheckpoints(runId)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal",
		);
	assert.deepEqual(
		terminals.map((checkpoint) => checkpoint.topology!.status),
		["failed", "completed"],
	);
	const exitedOutput = terminals[1]?.output;
	const exitedRecord =
		typeof exitedOutput === "object" && exitedOutput !== null && !Array.isArray(exitedOutput)
			? (exitedOutput as Readonly<
					Record<string, import("../../packages/workflows/src/shared/types.js").WorkflowSerializableValue>
				>)
			: undefined;
	assert.equal(exitedRecord?.status, "skipped");
	assert.equal(terminals[0]?.kind === "stage" ? terminals[0].output : undefined, undefined);
});

test("workflow exit persists one skipped child boundary without a child attachment", async () => {
	const backend = new DbosDurableBackend(createMockSdk());
	const child = workflow({
		name: "status-skipped-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("never-runs").complete("never") }),
	});
	const parent = workflow({
		name: "status-skipped-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await Promise.all([
				ctx.workflow(child),
				Promise.resolve().then(() =>
					ctx.exit({ status: "skipped", reason: "stop", outputs: { value: "skipped" } }),
				),
			]);
			return { value: "unreachable" };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId: "wf-skipped-boundary",
			store: createStore(),
			durableBackend: backend,
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	await backend.flush();
	assert.equal(result.status, "skipped");
	const terminals = backend
		.listCheckpoints("wf-skipped-boundary")
		.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal");
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0]?.kind === "stage" ? terminals[0].topology?.status : undefined, "skipped");
	assert.equal(terminals[0]?.kind === "stage" ? terminals[0].output : undefined, undefined);
});

test("fresh DBOS replay rejects stale nonreciprocal boundary ownership before child code", async () => {
	const sdk = createMockSdk();
	const runId = "wf-stale-boundary";
	const replayKey = "workflow:workflow:stale-child:1";
	seedMockWorkflow(sdk, { workflowId: runId, name: "stale-parent", status: "PENDING" });
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-start:${replayKey}`,
		name: "workflow:stale-child",
		replayKey,
		completedAt: 1,
		topology: {
			version: 1,
			stageId: "stable-boundary",
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: { runId, runName: "stale-parent" },
			boundary: {
				version: 1,
				event: "start",
				replayScope: replayKey,
				alias: "stale-child",
				workflow: "stale-child",
				status: "running",
				child: {
					runId: "stale-child-run",
					runName: "stale-child",
					parentRunId: runId,
					parentStageId: "unrelated-boundary",
					rootRunId: runId,
				},
			},
		},
	});
	const backend = new DbosDurableBackend(sdk);
	await backend.hydrateWorkflow(runId);
	let childCalls = 0;
	const child = workflow({
		name: "stale-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async () => {
			childCalls += 1;
			return { value: "unsafe" };
		},
	});
	const parent = workflow({
		name: "stale-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const nested = await ctx.workflow(child);
			return { value: nested.outputs.value ?? "unsafe" };
		},
	});
	const result = await run(parent, {}, { runId, store: createStore(), durableBackend: backend });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /malformed or stale boundary-start ownership/);
	assert.equal(childCalls, 0);
});
