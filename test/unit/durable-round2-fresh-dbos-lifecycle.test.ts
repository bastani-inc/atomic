import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	durableNestedRunSnapshots,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function copySdk(source: ReturnType<typeof createMockSdk>): ReturnType<typeof createMockSdk> {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

function terminals(backend: DbosDurableBackend, runId: string): DurableStageCheckpoint[] {
	return backend
		.listCheckpoints(runId)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.topology?.boundary?.event === "terminal",
		);
}

test("failed, skipped, and exited child lifecycle survives fresh DBOS catalog hydration exactly once", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "round2-lifecycle-writer" });
	const completedRootId = testRunId("round2-lifecycle-completed");
	const skippedRootId = testRunId("round2-lifecycle-skipped");
	let stageStarts = 0;
	let stageEnds = 0;

	const failing = workflow({
		name: "round2-lifecycle-failing",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("failed-child-stage").complete("fail-child") }),
	});
	const exited = workflow({
		name: "round2-lifecycle-exited",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("exited-child-stage").complete("exited-before");
			return ctx.exit({ status: "skipped", reason: "intentional child exit", outputs: { value: "partial" } });
		},
	});
	const parent = workflow({
		name: "round2-lifecycle-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			try {
				await ctx.workflow(failing);
			} catch {
				/* handled failed child */
			}
			const child = await ctx.workflow(exited);
			await ctx.stage("parent-after-lifecycle").complete("parent-after");
			return { value: child.outputs.value ?? "partial" };
		},
	});
	const skippedChild = workflow({
		name: "round2-lifecycle-never",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => ({ value: await ctx.stage("must-not-attach").complete("never") }),
	});
	const skippedParent = workflow({
		name: "round2-lifecycle-skip-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await Promise.all([
				ctx.workflow(skippedChild),
				Promise.resolve().then(() =>
					ctx.exit({ status: "skipped", reason: "stop", outputs: { value: "skipped" } }),
				),
			]);
			return { value: "unreachable" };
		},
	});
	const complete = async (text: string): Promise<string> => {
		if (text === "fail-child") throw new Error("expected child failure");
		return text;
	};
	const callbacks = {
		onStageStart: () => {
			stageStarts += 1;
		},
		onStageEnd: () => {
			stageEnds += 1;
		},
	};

	const completed = await run(
		parent,
		{},
		{
			runId: completedRootId,
			store: createStore(),
			durableBackend: writer,
			adapters: { complete: { complete } },
			...callbacks,
		},
	);
	const skipped = await run(
		skippedParent,
		{},
		{
			runId: skippedRootId,
			store: createStore(),
			durableBackend: writer,
			adapters: { complete: { complete } },
			...callbacks,
		},
	);
	await writer.flush();
	assert.equal(completed.status, "completed");
	assert.equal(skipped.status, "skipped");
	assert.deepEqual(
		terminals(writer, completedRootId).map((checkpoint) => checkpoint.topology!.status),
		["failed", "completed"],
	);
	assert.deepEqual(
		terminals(writer, skippedRootId).map((checkpoint) => checkpoint.topology!.status),
		["skipped"],
	);
	const callbackCounts = { stageStarts, stageEnds };
	const persisted = copySdk(sdk);
	const persistedStepCount = persisted.state.steps.size;

	const fresh = new DbosDurableBackend(persisted, { executorId: "round2-lifecycle-fresh" });
	await fresh.hydrateWorkflow(completedRootId);
	await fresh.hydrateWorkflow(skippedRootId);
	const catalog = await fresh.prepareWorkflowCatalog();
	assert.deepEqual(catalog.completed.map((entry) => entry.workflowId).sort(), [completedRootId, skippedRootId].sort());
	assert.deepEqual(
		listOpenableCompletedWorkflows(fresh)
			.map((entry) => entry.workflowId)
			.sort(),
		[completedRootId, skippedRootId].sort(),
	);
	assert.equal(
		catalog.resumable.some((entry) => entry.workflowId === skippedRootId),
		false,
	);
	const entry = catalog.completed.find((candidate) => candidate.workflowId === completedRootId)!;
	const reconstructed = completedWorkflowRunSnapshots(fresh, entry);
	const completedRoot = reconstructed.find((candidate) => candidate.id === completedRootId)!;
	const failedBoundary = completedRoot.stages.find((stage) => stage.name === "workflow:round2-lifecycle-failing")!;
	const exitedBoundary = completedRoot.stages.find((stage) => stage.name === "workflow:round2-lifecycle-exited")!;
	assert.equal(failedBoundary.status, "failed");
	assert.equal(failedBoundary.workflowChild, undefined);
	assert.equal(failedBoundary.workflowChildRun, undefined);
	assert.equal(exitedBoundary.status, "completed");
	assert.equal(exitedBoundary.workflowChild?.status, "skipped");
	assert.equal(exitedBoundary.workflowChild?.exited, true);
	const exitedRun = reconstructed.find((candidate) => candidate.id === exitedBoundary.workflowChild?.runId)!;
	assert.equal(exitedRun.status, "skipped");
	assert.equal(exitedRun.parentRunId, completedRootId);
	assert.equal(exitedRun.parentStageId, exitedBoundary.id);
	assert.equal(exitedRun.rootRunId, completedRootId);
	assert.equal(
		reconstructed.some((candidate) => candidate.name === "round2-lifecycle-failing"),
		false,
	);

	const freshStore = createStore();
	const registry = createStageControlRegistry();
	const opened = openCompletedDurableWorkflow(
		completedRootId,
		{
			durableBackend: fresh,
			store: freshStore,
			stageControlRegistry: registry,
		},
		catalog.completed,
	);
	assert.equal(opened.ok, true);
	const graph = expandWorkflowGraph(freshStore.snapshot(), completedRootId);
	assert.deepEqual(
		graph.stages.map((stage) => [stage.name, stage.status]),
		[
			["workflow:round2-lifecycle-failing", "failed"],
			["exited-child-stage", "completed"],
			["parent-after-lifecycle", "completed"],
		],
	);
	assert.equal(new Set(graph.stages.map((stage) => stage.id)).size, graph.stages.length);
	assert.deepEqual(freshStore.notices(), []);
	const skippedStore = createStore();
	const openedSkipped = openCompletedDurableWorkflow(
		skippedRootId,
		{
			durableBackend: fresh,
			store: skippedStore,
			stageControlRegistry: registry,
		},
		catalog.completed,
	);
	assert.equal(openedSkipped.ok, true);
	const reconstructedSkippedRoot = skippedStore.runs().find((candidate) => candidate.id === skippedRootId)!;
	assert.equal(reconstructedSkippedRoot.stages.length, 1);
	assert.equal(reconstructedSkippedRoot.stages[0]!.status, "skipped");
	assert.equal(reconstructedSkippedRoot.stages[0]!.workflowChild, undefined);
	assert.equal(
		skippedStore.runs().some((candidate) => candidate.parentRunId === skippedRootId),
		false,
	);
	assert.deepEqual(durableNestedRunSnapshots(fresh, skippedRootId), []);
	const freshSkippedTerminal = terminals(fresh, skippedRootId);
	assert.equal(freshSkippedTerminal.length, 1);
	assert.equal(freshSkippedTerminal[0]!.topology!.status, "skipped");
	assert.equal(freshSkippedTerminal[0]!.output, undefined);

	assert.deepEqual(
		{ stageStarts, stageEnds },
		callbackCounts,
		"fresh hydration emits no historical lifecycle callbacks",
	);
	assert.equal(
		persisted.state.steps.size,
		persistedStepCount,
		"catalog/open hydration must not write lifecycle records",
	);
	assert.equal(terminals(fresh, completedRootId).length, 2);
	assert.equal(terminals(fresh, skippedRootId).length, 1);
	registry.clear();
});
