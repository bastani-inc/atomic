import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
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
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const HOLD_MESSAGE = "Hold the unrelated live sibling";

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

async function waitForInput(store: ReturnType<typeof createStore>, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stage = runSnapshot.stages.find((candidate) => candidate.pendingPrompt?.kind === "input");
			if (stage !== undefined) return { runId: runSnapshot.id, stage };
		}
		await sleep(5);
	}
	throw new Error(
		`input did not become pending: ${JSON.stringify(
			store.runs().map((snapshot) => ({
				id: snapshot.id,
				error: snapshot.error,
				stages: snapshot.stages.map((stage) => ({ name: stage.name, status: stage.status, error: stage.error })),
			})),
		)}`,
	);
}

function stageNamed(runSnapshot: RunSnapshot, name: string): StageSnapshot {
	const stage = runSnapshot.stages.find((candidate) => candidate.name === name);
	assert.ok(stage, `missing stage ${name} in ${runSnapshot.id}`);
	return stage;
}

function activeReservationIds(sdk: ReturnType<typeof createMockSdk>): string[] {
	const ids = new Set<string>();
	for (const value of sdk.state.steps.values()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		if (
			record.__atomicPromptReservation === true &&
			record.operation === "reserve" &&
			typeof record.reservationId === "string"
		)
			ids.add(record.reservationId);
	}
	return [...ids];
}

function removeDeepTerminal(sdk: ReturnType<typeof createMockSdk>): void {
	for (const [key, value] of sdk.state.steps) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const envelope = value as Record<string, WorkflowSerializableValue>;
		const topologyValue = envelope.topology;
		if (typeof topologyValue !== "object" || topologyValue === null || Array.isArray(topologyValue)) continue;
		const topology = topologyValue as Record<string, WorkflowSerializableValue>;
		const boundaryValue = topology.boundary;
		if (typeof boundaryValue !== "object" || boundaryValue === null || Array.isArray(boundaryValue)) continue;
		const boundary = boundaryValue as Record<string, WorkflowSerializableValue>;
		if (boundary.event === "terminal" && boundary.workflow === "cached-guard-twig") {
			sdk.state.steps.delete(key);
			return;
		}
	}
	throw new Error("deep terminal checkpoint not found");
}

async function prepareFixture(rootId: string) {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk, { executorId: `${rootId}-writer` });
	const store = createStore();
	const controls = createStageControlRegistry();
	const calls = new Map<string, number>();
	const count = (name: string): void => {
		calls.set(name, (calls.get(name) ?? 0) + 1);
	};
	const complete = async (text: string): Promise<string> => {
		count(`stage:${text}`);
		if (text === "handled-failure") throw new Error("handled child stage failure");
		return text;
	};
	const twig = workflow({
		name: "cached-guard-twig",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			count("twig-body");
			await ctx.stage("twig-owner").complete("twig-value");
			return { value: "twig-value" };
		},
	});
	const leaf = workflow({
		name: "cached-guard-leaf",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			count("leaf-body");
			const child = await ctx.workflow(twig, { stageName: "twig-boundary" });
			if (child.exited) throw new Error("twig exited");
			return child.outputs;
		},
	});
	const completedChild = workflow({
		name: "cached-guard-completed",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			count("completed-body");
			try {
				await ctx.stage("handled-terminal").complete("handled-failure");
			} catch {
				count("handled-catch");
			}
			await ctx.stage("after-handled").complete("after-handled");
			const child = await ctx.workflow(leaf, { stageName: "leaf-boundary" });
			if (child.exited) throw new Error("leaf exited");
			return child.outputs;
		},
	});
	const liveSibling = workflow({
		name: "cached-guard-live",
		description: "",
		inputs: {},
		outputs: { answer: Type.String() },
		run: async (ctx) => {
			count("live-body");
			return { answer: await ctx.ui.input(HOLD_MESSAGE) };
		},
	});
	const root = workflow({
		name: rootId,
		description: "",
		inputs: {},
		outputs: { answer: Type.String() },
		run: async (ctx) => {
			count("root-body");
			await ctx.workflow(completedChild, { stageName: "cached-branch" });
			const active = await ctx.workflow(liveSibling, { stageName: "live-branch" });
			if (active.exited) throw new Error("live sibling exited");
			return active.outputs;
		},
	});
	const controller = new AbortController();
	const execution = run(
		root,
		{},
		{
			runId: rootId,
			store,
			stageControlRegistry: controls,
			durableBackend: backend,
			signal: controller.signal,
			usePromptNodesForUi: true,
			adapters: { complete: { complete } },
		},
	);
	const pending = await waitForInput(store);
	await backend.flush();
	const originalRuns = store.runs().map((snapshot) => structuredClone(snapshot));
	setDurableBackend(backend);
	const quit = await quitRun(rootId, { store, stageControlRegistry: controls });
	assert.equal(quit.ok, true);
	for (const reservationId of activeReservationIds(sdk)) {
		const token = backend.pendingPromptToken(rootId, reservationId);
		if (token !== undefined) backend.releasePendingPrompt(rootId, reservationId, token);
	}
	await backend.flush();
	const persisted = copySdk(sdk);
	setDurableBackend(undefined);
	controller.abort(new Error("writer exited"));
	await execution;
	return { root, calls, pending, originalRuns, persisted };
}

function resumeOptions(
	root: Awaited<ReturnType<typeof prepareFixture>>["root"],
	backend: DbosDurableBackend,
	jobs: ReturnType<typeof createJobTracker>,
	controls: ReturnType<typeof createStageControlRegistry>,
	cancellation: ReturnType<typeof createCancellationRegistry>,
) {
	return {
		registry: createRegistry([root]),
		durableBackend: backend,
		jobs,
		baseRunOpts: {
			store: workflowStore,
			cancellation,
			stageControlRegistry: controls,
			adapters: { complete: { complete: async (text: string) => text } },
		},
	};
}

function markHandledStageSkipped(sdk: ReturnType<typeof createMockSdk>): void {
	for (const [key, value] of sdk.state.steps) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const envelope = value as Record<string, WorkflowSerializableValue>;
		if (envelope.kind !== "stage" || envelope.name !== "handled-terminal") continue;
		const topologyValue = envelope.topology;
		if (typeof topologyValue !== "object" || topologyValue === null || Array.isArray(topologyValue)) continue;
		const topology = topologyValue as Record<string, WorkflowSerializableValue>;
		if (topology.status !== "failed") continue;
		const skipped = structuredClone(envelope);
		(skipped.topology as Record<string, WorkflowSerializableValue>).status = "skipped";
		sdk.state.steps.set(key, skipped);
		return;
	}
	throw new Error("handled failed stage checkpoint not found");
}

test.sequential("cached completed boundary republishes a child that handled a failed stage and completed downstream", async () => {
	const rootId = testRunId("cached-descendant-valid-root");
	const fixture = await prepareFixture(rootId);
	const fresh = new DbosDurableBackend(fixture.persisted, { executorId: "cached-descendant-valid-fresh" });
	await fresh.hydrateWorkflow(rootId);
	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const cancellation = createCancellationRegistry();
	const resumed = await resumeDurableWorkflow(
		rootId,
		resumeOptions(fixture.root, fresh, jobs, controls, cancellation),
	);
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const freshPending = await waitForInput(workflowStore);
	assert.equal(freshPending.runId, fixture.pending.runId);
	const originalById = new Map(fixture.originalRuns.map((snapshot) => [snapshot.id, snapshot]));
	for (const original of fixture.originalRuns) {
		const copies = workflowStore.runs().filter((candidate) => candidate.id === original.id);
		assert.equal(copies.length, 1, `${original.name} must be published exactly once`);
		const restored = copies[0]!;
		assert.equal(restored.parentRunId, original.parentRunId);
		assert.equal(restored.parentStageId, original.parentStageId);
		assert.deepEqual(
			restored.stages.map((stage) => stage.id),
			original.stages.map((stage) => stage.id),
		);
		assert.deepEqual(
			restored.stages.map((stage) => stage.parentIds),
			original.stages.map((stage) => stage.parentIds),
		);
		if (original.name !== rootId && original.name !== "cached-guard-live") {
			assert.deepEqual(
				restored.stages.map((stage) => stage.status),
				original.stages.map((stage) => stage.status),
			);
			assert.ok(restored.stages.every((stage) => stage.endedAt !== undefined));
			assert.ok(original.stages.every((stage) => stage.endedAt !== undefined));
		}
	}
	const twig = workflowStore.runs().find((candidate) => candidate.name === "cached-guard-twig")!;
	const twigOwner = stageNamed(twig, "twig-owner");
	const target = resolveStageTarget(rootId, `${twig.id}:${twigOwner.id}`);
	assert.deepEqual(target, { ok: true, runId: twig.id, stageId: twigOwner.id });
	assert.equal(Object.getPrototypeOf(target), Object.prototype);
	const handledRun = workflowStore.runs().find((candidate) => candidate.name === "cached-guard-completed")!;
	const handled = stageNamed(handledRun, "handled-terminal");
	const afterHandled = stageNamed(handledRun, "after-handled");
	assert.equal(handled.status, "failed");
	assert.ok(handled.endedAt !== undefined);
	assert.equal(afterHandled.status, "completed");
	assert.deepEqual(afterHandled.parentIds, [handled.id]);
	const handledTarget = resolveStageTarget(rootId, `${handledRun.id}:${handled.id}`);
	assert.deepEqual(handledTarget, { ok: true, runId: handledRun.id, stageId: handled.id });
	assert.equal(Object.getPrototypeOf(handledTarget), Object.prototype);
	assert.equal(originalById.size, 5);
	assert.equal(fixture.calls.get("completed-body"), 1);
	assert.equal(fixture.calls.get("leaf-body"), 1);
	assert.equal(fixture.calls.get("twig-body"), 1);
	assert.equal(fixture.calls.get("stage:handled-failure"), 1);
	assert.equal(fixture.calls.get("stage:after-handled"), 1);
	assert.equal(fixture.calls.get("live-body"), 2, "the unrelated active sibling has only its live replay owner");
	const answer = await workflowSendAction({
		runId: rootId,
		stageId: `${freshPending.runId}:${freshPending.stage.id}`,
		promptId: freshPending.stage.pendingPrompt!.id,
		response: "done",
		delivery: "answer",
	});
	assert.equal(answer.status, "ok");
	await jobs.get(rootId)!.promise;
	await fresh.flush();
	assert.equal(workflowStore.runs().filter((candidate) => candidate.id === fixture.pending.runId).length, 1);
});

test.sequential("cached completed boundary accepts a fully timed skipped child stage without rerunning", async () => {
	const rootId = testRunId("cached-descendant-skipped-root");
	const fixture = await prepareFixture(rootId);
	markHandledStageSkipped(fixture.persisted);
	const fresh = new DbosDurableBackend(fixture.persisted, { executorId: "cached-descendant-skipped-fresh" });
	await fresh.hydrateWorkflow(rootId);
	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const resumed = await resumeDurableWorkflow(
		rootId,
		resumeOptions(fixture.root, fresh, jobs, controls, createCancellationRegistry()),
	);
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const freshPending = await waitForInput(workflowStore);
	const child = workflowStore.runs().find((candidate) => candidate.name === "cached-guard-completed")!;
	const skipped = stageNamed(child, "handled-terminal");
	const downstream = stageNamed(child, "after-handled");
	assert.equal(child.status, "completed");
	assert.equal(skipped.status, "skipped");
	assert.ok(skipped.endedAt !== undefined);
	assert.equal(downstream.status, "completed");
	assert.deepEqual(downstream.parentIds, [skipped.id]);
	const target = resolveStageTarget(rootId, `${child.id}:${skipped.id}`);
	assert.deepEqual(target, { ok: true, runId: child.id, stageId: skipped.id });
	assert.equal(Object.getPrototypeOf(target), Object.prototype);
	assert.equal(fixture.calls.get("completed-body"), 1);
	assert.equal(fixture.calls.get("stage:handled-failure"), 1);
	assert.equal(fixture.calls.get("stage:after-handled"), 1);
	const answer = await workflowSendAction({
		runId: rootId,
		stageId: `${freshPending.runId}:${freshPending.stage.id}`,
		promptId: freshPending.stage.pendingPrompt!.id,
		response: "done",
		delivery: "answer",
	});
	assert.equal(answer.status, "ok");
	await jobs.get(rootId)!.promise;
	await fresh.flush();
});

test.sequential("cached completed boundary rejects an active descendant before publication or later dispatch", async () => {
	const rootId = testRunId("cached-descendant-malformed-root");
	const fixture = await prepareFixture(rootId);
	const malformed = copySdk(fixture.persisted);
	removeDeepTerminal(malformed);
	const fresh = new DbosDurableBackend(malformed, { executorId: "cached-descendant-malformed-fresh" });
	await fresh.hydrateWorkflow(rootId);
	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const cancellation = createCancellationRegistry();
	const resumed = await resumeDurableWorkflow(
		rootId,
		resumeOptions(fixture.root, fresh, jobs, controls, cancellation),
	);
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const job = jobs.get(rootId)?.promise;
	assert.ok(job);
	const outcome = await Promise.race([
		job.then(() => ({ kind: "result" as const })),
		sleep(250).then(() => ({ kind: "timeout" as const })),
	]);
	if (outcome.kind === "timeout") {
		await quitRun(rootId, { store: workflowStore, stageControlRegistry: controls });
	}
	assert.equal(outcome.kind, "result", "malformed cached descendants must fail before reaching the live sibling");
	const failedRoot = workflowStore.runs().find((candidate) => candidate.id === rootId);
	assert.equal(failedRoot?.status, "failed");
	assert.match(failedRoot?.error ?? "", /cached completed child subtree is incomplete or inconsistent/);
	assert.deepEqual(
		workflowStore.runs().filter((candidate) => candidate.id !== rootId),
		[],
		"no cached descendant may enter the fresh live store",
	);
	assert.equal(fixture.calls.get("completed-body"), 1, "cached child code must not rerun");
	assert.equal(fixture.calls.get("leaf-body"), 1);
	assert.equal(fixture.calls.get("twig-body"), 1);
	assert.equal(fixture.calls.get("live-body"), 1, "later unrelated live code must not dispatch after malformed cache");
});
