import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const QUESTION = "Keep this exact repeated question?";

afterEach(() => {
	setDurableBackend(undefined);
	workflowStore.clear();
});

function copySdk(source: ReturnType<typeof createMockSdk>): ReturnType<typeof createMockSdk> {
	const copy = createMockSdk();
	for (const [key, value] of source.state.workflows) copy.state.workflows.set(key, { ...value });
	for (const [key, value] of source.state.steps) copy.state.steps.set(key, structuredClone(value));
	return copy;
}

async function waitForPending(
	store: ReturnType<typeof createStore>,
	count: number,
	timeoutMs = 2_000,
): Promise<{ runId: string; stages: StageSnapshot[] }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stages = runSnapshot.stages.filter((stage) => stage.pendingPrompt?.kind === "confirm");
			if (stages.length === count) return { runId: runSnapshot.id, stages };
		}
		await sleep(5);
	}
	throw new Error(
		`expected ${count} pending confirms: ${JSON.stringify(
			store.runs().map((snapshot) => ({
				id: snapshot.id,
				stages: snapshot.stages.map((stage) => ({
					id: stage.id,
					status: stage.status,
					pending: stage.pendingPrompt?.kind,
				})),
			})),
		)}`,
	);
}

async function waitForPromptCount(
	backend: DbosDurableBackend,
	workflowId: string,
	expected: number,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (backend.getWorkflow(workflowId)?.pendingPrompts === expected) return;
		await sleep(5);
	}
	assert.equal(backend.getWorkflow(workflowId)?.pendingPrompts, expected);
}

function promptStages(store: ReturnType<typeof createStore>, runId: string): StageSnapshot[] {
	const child = store.runs().find((candidate) => candidate.id === runId);
	assert.ok(child, `missing child run ${runId}`);
	return child.stages.filter((stage) => stage.name === "confirm");
}

function assertDurablePromptOccurrences(
	backend: DbosDurableBackend,
	rootId: string,
	childRunId: string,
	expectedStageIds: readonly string[],
): void {
	const byOccurrence = new Map<string, { stageId: string; sourceOrder: number; replayKey: string }>();
	for (const checkpoint of backend.listCheckpoints(rootId)) {
		if (
			checkpoint.kind !== "stage" ||
			checkpoint.name !== "confirm" ||
			checkpoint.topology?.run?.runId !== childRunId ||
			checkpoint.topology.occurrenceKey === undefined ||
			checkpoint.topology.sourceOrder === undefined
		)
			continue;
		byOccurrence.set(checkpoint.topology.occurrenceKey, {
			stageId: checkpoint.topology.stageId,
			sourceOrder: checkpoint.topology.sourceOrder,
			replayKey: checkpoint.replayKey,
		});
	}
	const occurrences = [...byOccurrence.values()].sort((left, right) => left.sourceOrder - right.sourceOrder);
	assert.deepEqual(
		occurrences.map((occurrence) => occurrence.stageId),
		expectedStageIds,
	);
	assert.deepEqual(
		occurrences.map((occurrence) => occurrence.sourceOrder),
		[0, 1],
	);
	assert.equal(new Set(occurrences.map((occurrence) => occurrence.replayKey)).size, 1);
}

function reservationIds(sdk: ReturnType<typeof createMockSdk>): string[] {
	const ids = new Set<string>();
	for (const value of sdk.state.steps.values()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const event = value as Record<string, unknown>;
		if (
			event.__atomicPromptReservation === true &&
			event.operation === "reserve" &&
			typeof event.reservationId === "string"
		)
			ids.add(event.reservationId);
	}
	return [...ids];
}

async function pauseAndCopy(input: {
	rootId: string;
	sdk: ReturnType<typeof createMockSdk>;
	backend: DbosDurableBackend;
	store: ReturnType<typeof createStore>;
	controls: ReturnType<typeof createStageControlRegistry>;
	controller: AbortController;
	execution: Promise<unknown>;
	pendingCount: number;
}): Promise<ReturnType<typeof createMockSdk>> {
	setDurableBackend(input.backend);
	const quit = await quitRun(input.rootId, { store: input.store, stageControlRegistry: input.controls });
	assert.equal(quit.ok, true);
	assert.equal(input.backend.getWorkflow(input.rootId)?.status, "paused");
	assert.equal(input.backend.getWorkflow(input.rootId)?.pendingPrompts, input.pendingCount);
	const active = reservationIds(input.sdk).flatMap((reservationId) => {
		const token = input.backend.pendingPromptToken(input.rootId, reservationId);
		return token === undefined ? [] : [{ reservationId, token }];
	});
	assert.equal(active.length, input.pendingCount);
	if (active.length > 1) {
		input.backend.releasePendingPrompt(input.rootId, active[1]!.reservationId, active[0]!.token);
		assert.equal(
			input.backend.getWorkflow(input.rootId)?.pendingPrompts,
			input.pendingCount,
			"a reservation must reject another prompt occurrence's owner token",
		);
	}
	for (const entry of active) input.backend.releasePendingPrompt(input.rootId, entry.reservationId, entry.token);
	await input.backend.flush();
	assert.equal(input.backend.getWorkflow(input.rootId)?.pendingPrompts, 0);
	const persisted = copySdk(input.sdk);
	setDurableBackend(undefined);
	input.controller.abort(new Error("writer process exited"));
	await input.execution;
	return persisted;
}

function resumeDeps(
	root: WorkflowDefinition,
	backend: DbosDurableBackend,
	jobs: ReturnType<typeof createJobTracker>,
	controls: ReturnType<typeof createStageControlRegistry>,
) {
	return {
		registry: createRegistry([root]),
		durableBackend: backend,
		jobs,
		baseRunOpts: {
			store: workflowStore,
			cancellation: createCancellationRegistry(),
			stageControlRegistry: controls,
		},
	};
}

async function answerFresh(rootId: string, childRunId: string, stage: StageSnapshot, response: boolean) {
	const promptId = stage.pendingPrompt!.id;
	const result = await workflowSendAction({
		runId: rootId,
		stageId: `${childRunId}:${stage.id}`,
		promptId,
		response,
		delivery: "answer",
	});
	assert.equal(result.status, "ok");
	const duplicate = await workflowSendAction({
		runId: rootId,
		stageId: `${childRunId}:${stage.id}`,
		promptId,
		response,
		delivery: "answer",
	});
	assert.equal(duplicate.status, "noop");
}

test.sequential("fresh nested resume keeps sequential identical same-callsite prompt occurrences distinct", async () => {
	const rootId = testRunId("repeated-sequential-root");
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "repeated-sequential-writer" });
	const writerStore = createStore();
	const writerControls = createStageControlRegistry();
	let afterPrompts = 0;
	const child = workflow({
		name: "repeated-sequential-child",
		description: "",
		inputs: {},
		outputs: { first: Type.Boolean(), second: Type.Boolean() },
		run: async (ctx) => {
			const askSame = () => ctx.ui.confirm(QUESTION);
			const answers: boolean[] = [];
			for (const _iteration of [0, 1]) answers.push(await askSame());
			const [first, second] = answers as [boolean, boolean];
			await ctx.tool("after-prompts", { first, second }, async () => {
				afterPrompts += 1;
				return { ok: true };
			});
			return { first, second };
		},
	});
	const root = workflow({
		name: "repeated-sequential-root",
		description: "",
		inputs: {},
		outputs: { first: Type.Boolean(), second: Type.Boolean() },
		run: async (ctx) => {
			const result = await ctx.workflow(child, { stageName: "sequential-child" });
			if (result.exited) throw new Error("child exited");
			return result.outputs;
		},
	});
	const controller = new AbortController();
	const execution = run(
		root,
		{},
		{
			runId: rootId,
			store: writerStore,
			stageControlRegistry: writerControls,
			durableBackend: writer,
			signal: controller.signal,
			usePromptNodesForUi: true,
		},
	);
	const firstPending = await waitForPending(writerStore, 1);
	assert.equal(firstPending.stages[0]!.pendingPrompt!.message, QUESTION);
	writerStore.resolveStagePendingPrompt(
		firstPending.runId,
		firstPending.stages[0]!.id,
		firstPending.stages[0]!.pendingPrompt!.id,
		true,
	);
	let secondPending = await waitForPending(writerStore, 1);
	while (secondPending.stages[0]!.id === firstPending.stages[0]!.id) {
		await sleep(5);
		secondPending = await waitForPending(writerStore, 1);
	}
	await writer.flush();
	const original = promptStages(writerStore, firstPending.runId);
	assert.equal(original.length, 2);
	assert.notEqual(original[0]!.id, original[1]!.id);
	assert.deepEqual(
		original.map((stage) => stage.parentIds),
		[[], [original[0]!.id]],
	);
	assert.equal(new Set(original.map((stage) => stage.replayKey)).size, 1);

	const persisted = await pauseAndCopy({
		rootId,
		sdk,
		backend: writer,
		store: writerStore,
		controls: writerControls,
		controller,
		execution,
		pendingCount: 1,
	});
	const fresh = new DbosDurableBackend(persisted, { executorId: "repeated-sequential-fresh" });
	await fresh.hydrateWorkflow(rootId);
	assertDurablePromptOccurrences(
		fresh,
		rootId,
		firstPending.runId,
		original.map((stage) => stage.id),
	);
	assert.equal(fresh.getWorkflow(rootId)?.pendingPrompts, 0);
	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const resumed = await resumeDurableWorkflow(rootId, resumeDeps(root, fresh, jobs, controls));
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const freshPending = await waitForPending(workflowStore, 1);
	assert.equal(freshPending.runId, firstPending.runId);
	const restored = promptStages(workflowStore, firstPending.runId);
	assert.deepEqual(
		restored.map((stage) => stage.id),
		original.map((stage) => stage.id),
	);
	assert.deepEqual(
		restored.map((stage) => stage.parentIds),
		original.map((stage) => stage.parentIds),
	);
	assert.deepEqual(
		restored.map((stage) => stage.promptFootprint?.message),
		[QUESTION, QUESTION],
	);
	assert.deepEqual(
		restored.map((stage) => stage.status),
		["completed", "awaiting_input"],
	);
	for (const stage of restored) {
		const target = resolveStageTarget(rootId, `${firstPending.runId}:${stage.id}`);
		assert.deepEqual(target, { ok: true, runId: firstPending.runId, stageId: stage.id });
		assert.equal(Object.getPrototypeOf(target), Object.prototype);
	}
	await answerFresh(rootId, firstPending.runId, restored[1]!, false);
	await jobs.get(rootId)!.promise;
	await fresh.flush();
	assert.equal(afterPrompts, 1);
	const catalogBackend = new DbosDurableBackend(copySdk(persisted), { executorId: "repeated-sequential-catalog" });
	await catalogBackend.hydrateWorkflow(rootId);
	const openable = listOpenableCompletedWorkflows(catalogBackend);
	assert.deepEqual(
		openable.map((entry) => entry.workflowId),
		[rootId],
	);
	const catalogRuns = completedWorkflowRunSnapshots(catalogBackend, openable[0]!);
	const inspected = catalogRuns.find((candidate) => candidate.id === firstPending.runId)!;
	const inspectedPrompts = inspected.stages.filter((stage) => stage.name === "confirm");
	assert.deepEqual(
		inspectedPrompts.map((stage) => stage.id),
		original.map((stage) => stage.id),
	);
	assert.deepEqual(
		inspectedPrompts.map((stage) => stage.parentIds),
		original.map((stage) => stage.parentIds),
	);
});

test.sequential("fresh nested resume restores and independently answers two concurrent identical prompts", async () => {
	const rootId = testRunId("repeated-concurrent-root");
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "repeated-concurrent-writer" });
	const writerStore = createStore();
	const writerControls = createStageControlRegistry();
	const child = workflow({
		name: "repeated-concurrent-child",
		description: "",
		inputs: {},
		outputs: { answers: Type.Array(Type.Boolean()) },
		run: async (ctx) => {
			const askSame = () => ctx.ui.confirm(QUESTION);
			return { answers: await Promise.all([0, 1].map(() => askSame())) };
		},
	});
	const root = workflow({
		name: "repeated-concurrent-root",
		description: "",
		inputs: {},
		outputs: { answers: Type.Array(Type.Boolean()) },
		run: async (ctx) => {
			const result = await ctx.workflow(child, { stageName: "concurrent-child" });
			if (result.exited) throw new Error("child exited");
			return result.outputs;
		},
	});
	const controller = new AbortController();
	const execution = run(
		root,
		{},
		{
			runId: rootId,
			store: writerStore,
			stageControlRegistry: writerControls,
			durableBackend: writer,
			signal: controller.signal,
			usePromptNodesForUi: true,
		},
	);
	const originalPending = await waitForPending(writerStore, 2);
	await writer.flush();
	assert.equal(writer.getWorkflow(rootId)?.pendingPrompts, 2);
	const original = promptStages(writerStore, originalPending.runId);
	assert.equal(new Set(original.map((stage) => stage.id)).size, 2);
	assert.equal(new Set(original.map((stage) => stage.replayKey)).size, 1);
	assert.deepEqual(
		original.map((stage) => stage.parentIds),
		[[], []],
	);
	const persisted = await pauseAndCopy({
		rootId,
		sdk,
		backend: writer,
		store: writerStore,
		controls: writerControls,
		controller,
		execution,
		pendingCount: 2,
	});

	const fresh = new DbosDurableBackend(persisted, { executorId: "repeated-concurrent-fresh" });
	await fresh.hydrateWorkflow(rootId);
	assert.equal(fresh.getWorkflow(rootId)?.pendingPrompts, 0, "stale prompt owners are not adopted");
	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const resumed = await resumeDurableWorkflow(rootId, resumeDeps(root, fresh, jobs, controls));
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const freshPending = await waitForPending(workflowStore, 2);
	assertDurablePromptOccurrences(
		fresh,
		rootId,
		originalPending.runId,
		original.map((stage) => stage.id),
	);
	assert.equal(freshPending.runId, originalPending.runId);
	const restored = promptStages(workflowStore, originalPending.runId);
	assert.deepEqual(
		restored.map((stage) => stage.id),
		original.map((stage) => stage.id),
	);
	assert.deepEqual(
		restored.map((stage) => stage.parentIds),
		[[], []],
	);
	assert.deepEqual(
		restored.map((stage) => stage.promptFootprint?.message),
		[QUESTION, QUESTION],
	);
	assert.equal(fresh.getWorkflow(rootId)?.pendingPrompts, 2);
	for (const stage of restored) {
		const target = resolveStageTarget(rootId, `${originalPending.runId}:${stage.id}`);
		assert.deepEqual(target, { ok: true, runId: originalPending.runId, stageId: stage.id });
		assert.equal(Object.getPrototypeOf(target), Object.prototype);
	}
	await answerFresh(rootId, originalPending.runId, restored[0]!, true);
	await waitForPromptCount(fresh, rootId, 1);
	await answerFresh(rootId, originalPending.runId, restored[1]!, false);
	await jobs.get(rootId)!.promise;
	await fresh.flush();
	assert.deepEqual(workflowStore.runs().find((candidate) => candidate.id === rootId)?.result, {
		answers: [true, false],
	});
	assert.equal(fresh.getWorkflow(rootId)?.pendingPrompts, 0);
	const catalogBackend = new DbosDurableBackend(copySdk(persisted), { executorId: "repeated-concurrent-catalog" });
	await catalogBackend.hydrateWorkflow(rootId);
	const openable = listOpenableCompletedWorkflows(catalogBackend);
	assert.deepEqual(
		openable.map((entry) => entry.workflowId),
		[rootId],
	);
	const catalogRuns = completedWorkflowRunSnapshots(catalogBackend, openable[0]!);
	const inspected = catalogRuns.find((candidate) => candidate.id === originalPending.runId)!;
	assert.deepEqual(
		inspected.stages.filter((stage) => stage.name === "confirm").map((stage) => stage.id),
		original.map((stage) => stage.id),
	);
});
