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
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const ROOT_ID = testRunId("pending-nested-ui-root");

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

async function waitForPendingInput(
	store: ReturnType<typeof createStore>,
	timeoutMs = 2_000,
): Promise<{ runId: string; stage: StageSnapshot }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stage = runSnapshot.stages.find((candidate) => candidate.pendingPrompt?.kind === "input");
			if (stage !== undefined) return { runId: runSnapshot.id, stage };
		}
		await sleep(5);
	}
	const shape = store.runs().map((runSnapshot) => ({
		id: runSnapshot.id,
		name: runSnapshot.name,
		parentRunId: runSnapshot.parentRunId,
		stages: runSnapshot.stages.map((stage) => ({ id: stage.id, name: stage.name, status: stage.status })),
	}));
	throw new Error(`pending input did not appear: ${JSON.stringify(shape)}`);
}

function graphShape(snapshot: ReturnType<typeof workflowStore.snapshot>, rootRunId: string) {
	return expandWorkflowGraph(snapshot, rootRunId).stages.map((stage) => ({
		id: stage.id,
		name: stage.name,
		status: stage.status,
		parentIds: [...stage.parentIds],
		target: { ...stage.workflowGraphTarget },
	}));
}

function stageByName(run: { readonly stages: readonly StageSnapshot[] }, name: string): StageSnapshot {
	const stage = run.stages.find((candidate) => candidate.name === name);
	assert.ok(stage, `missing stage ${name}`);
	return stage;
}

test.sequential("fresh root resume republishes and answers a pending depth-2 durable ctx.ui node", async () => {
	workflowStore.clear();
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "pending-ui-writer" });
	const writerStore = createStore();
	const writerControls = createStageControlRegistry();
	const calls = new Map<string, number>();
	const count = (name: string): number => {
		const next = (calls.get(name) ?? 0) + 1;
		calls.set(name, next);
		return next;
	};
	const complete = async (text: string): Promise<string> => {
		count(`stage:${text}`);
		return text;
	};

	const sibling = workflow({
		name: "pending-ui-sibling",
		description: "",
		inputs: { branch: Type.String() },
		outputs: { branch: Type.String() },
		run: async (ctx) => {
			const branch = String(ctx.inputs.branch);
			count(`sibling:${branch}`);
			await ctx.stage("sibling-owner").complete(`sibling-${branch}`);
			return { branch };
		},
	});
	const grandchild = workflow({
		name: "pending-ui-grandchild",
		description: "",
		inputs: {},
		outputs: { answer: Type.String() },
		run: async (ctx) => {
			count("grandchild-body");
			await ctx.stage("grandchild-owner").complete("grandchild-owner");
			await ctx.tool("grandchild-once", { durable: true }, async () => {
				count("grandchild-once");
				return { durable: true };
			});
			const answer = await ctx.ui.input("Type PROCEED to continue");
			if (answer !== "PROCEED") throw new Error(`unexpected answer: ${answer}`);
			await ctx.tool("grandchild-post-gate", { answer }, async () => {
				count("grandchild-post-gate");
				return { continued: true };
			});
			return { answer };
		},
	});
	const activeChild = workflow({
		name: "pending-ui-active-child",
		description: "",
		inputs: {},
		outputs: { answer: Type.String() },
		run: async (ctx) => {
			count("active-body");
			const nested = await ctx.workflow(grandchild, { stageName: "grandchild-boundary" });
			if (nested.exited) throw new Error("grandchild exited");
			await ctx.tool("active-downstream", { answer: nested.outputs.answer }, async () => {
				count("active-downstream");
				return { continued: true };
			});
			return { answer: nested.outputs.answer };
		},
	});
	const root = workflow({
		name: "pending-ui-root",
		description: "",
		inputs: {},
		outputs: { answer: Type.String() },
		run: async (ctx) => {
			count("root-body");
			await ctx.tool("root-before", { durable: true }, async () => {
				count("root-before");
				return { durable: true };
			});
			await ctx.workflow(sibling, { stageName: "alpha-boundary", inputs: { branch: "alpha" } });
			await ctx.workflow(sibling, { stageName: "beta-boundary", inputs: { branch: "beta" } });
			const nested = await ctx.workflow(activeChild, { stageName: "active-boundary" });
			if (nested.exited) throw new Error("active child exited");
			await ctx.tool("root-downstream", { answer: nested.outputs.answer }, async () => {
				count("root-downstream");
				return { continued: true };
			});
			return { answer: nested.outputs.answer };
		},
	});

	const writerController = new AbortController();
	const firstExecution = run(
		root,
		{},
		{
			runId: ROOT_ID,
			store: writerStore,
			stageControlRegistry: writerControls,
			durableBackend: writer,
			signal: writerController.signal,
			usePromptNodesForUi: true,
			adapters: { complete: { complete } },
		},
	);
	const originalPending = await waitForPendingInput(writerStore);
	await writer.flush();

	const originalRoot = writerStore.runs().find((candidate) => candidate.id === ROOT_ID)!;
	const alphaBoundary = stageByName(originalRoot, "alpha-boundary");
	const betaBoundary = stageByName(originalRoot, "beta-boundary");
	const activeBoundary = stageByName(originalRoot, "active-boundary");
	const activeRun = writerStore.runs().find((candidate) => candidate.id === activeBoundary.workflowChildRun?.runId)!;
	const grandchildBoundary = stageByName(activeRun, "grandchild-boundary");
	const grandchildRun = writerStore
		.runs()
		.find((candidate) => candidate.id === grandchildBoundary.workflowChildRun?.runId)!;
	const ownerStage = stageByName(grandchildRun, "grandchild-owner");
	assert.equal(originalPending.runId, grandchildRun.id);
	assert.deepEqual(
		expandWorkflowGraph(writerStore.snapshot(), ROOT_ID).stages.map((stage) => stage.name),
		["sibling-owner", "sibling-owner", "grandchild-owner", "input"],
	);
	assert.deepEqual(
		[...calls],
		[
			["root-body", 1],
			["root-before", 1],
			["sibling:alpha", 1],
			["stage:sibling-alpha", 1],
			["sibling:beta", 1],
			["stage:sibling-beta", 1],
			["active-body", 1],
			["grandchild-body", 1],
			["stage:grandchild-owner", 1],
			["grandchild-once", 1],
		],
	);
	assert.equal(writer.getWorkflow(ROOT_ID)?.pendingPrompts, 1);

	setDurableBackend(writer);
	const quit = await quitRun(ROOT_ID, { store: writerStore, stageControlRegistry: writerControls });
	assert.equal(quit.ok, true);
	assert.equal(writer.getWorkflow(ROOT_ID)?.status, "paused");
	assert.equal(writer.getWorkflow(ROOT_ID)?.pendingPrompts, 1);
	const reservationEvent = [...sdk.state.steps.values()].find((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const event = value as Record<string, unknown>;
		return event.__atomicPromptReservation === true && event.operation === "reserve";
	});
	assert.ok(reservationEvent && typeof reservationEvent === "object" && !Array.isArray(reservationEvent));
	const reservationId = (reservationEvent as Record<string, unknown>).reservationId;
	assert.equal(typeof reservationId, "string");
	const oldOwnerToken = writer.pendingPromptToken(ROOT_ID, reservationId as string);
	assert.ok(oldOwnerToken);
	writer.releasePendingPrompt(ROOT_ID, reservationId as string, oldOwnerToken);
	await writer.flush();
	assert.equal(writer.getWorkflow(ROOT_ID)?.status, "paused");
	assert.equal(writer.getWorkflow(ROOT_ID)?.pendingPrompts, 0, "the exited owner releases its reservation");
	const persisted = copySdk(sdk);

	setDurableBackend(undefined);
	writerController.abort(new Error("writer process exited after durable quit"));
	await firstExecution;

	const terminalBoundariesBeforeResume = [...persisted.state.steps.keys()].filter(
		(key) => key.includes("boundary-terminal:") && key.endsWith(":completed"),
	).length;
	const fresh = new DbosDurableBackend(persisted, { executorId: "pending-ui-fresh" });
	await fresh.hydrateWorkflow(ROOT_ID);
	assert.equal(fresh.getWorkflow(ROOT_ID)?.pendingPrompts, 0, "no stale owner reservation is adopted");
	const jobs = createJobTracker();
	const cancellation = createCancellationRegistry();
	const freshControls = createStageControlRegistry();
	let rootTerminalCallbacks = 0;
	const resumeDeps = {
		registry: createRegistry([root]),
		durableBackend: fresh,
		jobs,
		baseRunOpts: {
			store: workflowStore,
			cancellation,
			stageControlRegistry: freshControls,
			adapters: { complete: { complete } },
			onRunEnd: () => {
				rootTerminalCallbacks += 1;
			},
		},
	};
	const resume = await resumeDurableWorkflow(ROOT_ID, resumeDeps);
	assert.equal(resume.ok, true, JSON.stringify(resume));
	const freshPending = await waitForPendingInput(workflowStore);
	await fresh.flush();
	assert.equal(fresh.getWorkflow(ROOT_ID)?.pendingPrompts, 1, "the fresh owner reserves the same unanswered prompt");
	assert.deepEqual(
		expandWorkflowGraph(workflowStore.snapshot(), ROOT_ID).stages.map((stage) => stage.name),
		["sibling-owner", "sibling-owner", "grandchild-owner", "input"],
		"the fresh expanded graph must republish the live grandchild and its pending prompt",
	);
	const duplicateResume = await resumeDurableWorkflow(ROOT_ID, resumeDeps);
	assert.equal(duplicateResume.ok, false);
	assert.equal(duplicateResume.reason, "not_resumable");
	assert.match(duplicateResume.message, /already running/);

	assert.equal(workflowStore.runs().filter((candidate) => candidate.id === ROOT_ID).length, 1);
	assert.equal(workflowStore.runs().filter((candidate) => candidate.id === activeRun.id).length, 1);
	assert.equal(workflowStore.runs().filter((candidate) => candidate.id === grandchildRun.id).length, 1);
	const freshRoot = workflowStore.runs().find((candidate) => candidate.id === ROOT_ID)!;
	const freshActiveBoundary = stageByName(freshRoot, "active-boundary");
	const freshActiveRun = workflowStore.runs().find((candidate) => candidate.id === activeRun.id)!;
	const freshGrandchildBoundary = stageByName(freshActiveRun, "grandchild-boundary");
	const freshGrandchildRun = workflowStore.runs().find((candidate) => candidate.id === grandchildRun.id)!;
	const freshOwner = stageByName(freshGrandchildRun, "grandchild-owner");
	const freshInput = stageByName(freshGrandchildRun, "input");
	assert.equal(freshActiveBoundary.id, activeBoundary.id);
	assert.equal(freshGrandchildBoundary.id, grandchildBoundary.id);
	assert.equal(freshOwner.id, ownerStage.id);
	assert.equal(freshInput.id, originalPending.stage.id);
	assert.equal(freshActiveBoundary.workflowChildRun?.runId, activeRun.id);
	assert.equal(freshActiveRun.parentRunId, ROOT_ID);
	assert.equal(freshActiveRun.parentStageId, activeBoundary.id);
	assert.equal(freshGrandchildBoundary.workflowChildRun?.runId, grandchildRun.id);
	assert.equal(freshGrandchildRun.parentRunId, activeRun.id);
	assert.equal(freshGrandchildRun.parentStageId, grandchildBoundary.id);
	assert.equal(freshPending.runId, grandchildRun.id);

	const graph = expandWorkflowGraph(workflowStore.snapshot(), ROOT_ID);
	assert.deepEqual(
		graph.stages.map((stage) => stage.name),
		["sibling-owner", "sibling-owner", "grandchild-owner", "input"],
	);
	const ownerTarget = resolveStageTarget(ROOT_ID, `${grandchildRun.id}:${ownerStage.id}`);
	const inputTarget = resolveStageTarget(ROOT_ID, `${grandchildRun.id}:${originalPending.stage.id}`);
	assert.deepEqual(ownerTarget, { ok: true, runId: grandchildRun.id, stageId: ownerStage.id });
	assert.deepEqual(inputTarget, { ok: true, runId: grandchildRun.id, stageId: originalPending.stage.id });
	assert.equal(Object.getPrototypeOf(ownerTarget), Object.prototype);
	assert.equal(Object.getPrototypeOf(inputTarget), Object.prototype);
	assert.equal(calls.get("sibling:alpha"), 1);
	assert.equal(calls.get("sibling:beta"), 1);
	assert.equal(calls.get("grandchild-once"), 1);
	assert.equal(calls.get("grandchild-post-gate"), undefined);

	const resumedJob = jobs.get(ROOT_ID)?.promise;
	assert.ok(resumedJob, "the resumed root must still be waiting on its HIL node");
	const freshPromptId = freshInput.pendingPrompt!.id;
	const answer = await workflowSendAction({
		runId: ROOT_ID,
		stageId: `${grandchildRun.id}:${originalPending.stage.id}`,
		promptId: freshPromptId,
		response: "PROCEED",
		delivery: "answer",
	});
	assert.equal(answer.status, "ok");
	assert.equal(answer.delivery, "answer");
	const duplicate = await workflowSendAction({
		runId: ROOT_ID,
		stageId: `${grandchildRun.id}:${originalPending.stage.id}`,
		promptId: freshPromptId,
		response: "PROCEED",
		delivery: "answer",
	});
	assert.equal(duplicate.status, "noop");
	await resumedJob;
	await fresh.flush();

	const completedRoot = workflowStore.runs().find((candidate) => candidate.id === ROOT_ID)!;
	assert.equal(completedRoot.status, "completed");
	assert.deepEqual(completedRoot.result, { answer: "PROCEED" });
	assert.equal(rootTerminalCallbacks, 1);
	assert.equal(workflowStore.notices().filter((notice) => notice.runId === ROOT_ID).length, 0);
	assert.equal(calls.get("sibling:alpha"), 1);
	assert.equal(calls.get("sibling:beta"), 1);
	assert.equal(calls.get("grandchild-once"), 1);
	assert.equal(calls.get("grandchild-post-gate"), 1);
	assert.equal(calls.get("active-downstream"), 1);
	assert.equal(calls.get("root-downstream"), 1);
	assert.equal(fresh.getWorkflow(ROOT_ID)?.pendingPrompts, 0);
	const terminalBoundariesAfterResume = [...persisted.state.steps.keys()].filter(
		(key) => key.includes("boundary-terminal:") && key.endsWith(":completed"),
	).length;
	assert.equal(terminalBoundariesAfterResume - terminalBoundariesBeforeResume, 2);

	const terminalGraph = graphShape(workflowStore.snapshot(), ROOT_ID);
	const catalogBackend = new DbosDurableBackend(copySdk(persisted), { executorId: "pending-ui-catalog" });
	await catalogBackend.hydrateWorkflow(ROOT_ID);
	const catalog = listOpenableCompletedWorkflows(catalogBackend);
	assert.deepEqual(
		catalog.map((entry) => entry.workflowId),
		[ROOT_ID],
	);
	const catalogRuns = completedWorkflowRunSnapshots(catalogBackend, catalog[0]!);
	assert.equal(catalogRuns.length, 5);
	assert.deepEqual(graphShape({ runs: catalogRuns, notices: [], version: 1 }, ROOT_ID), terminalGraph);
	assert.equal(stageByName(freshRoot, "alpha-boundary").id, alphaBoundary.id);
	assert.equal(stageByName(freshRoot, "beta-boundary").id, betaBoundary.id);
});
