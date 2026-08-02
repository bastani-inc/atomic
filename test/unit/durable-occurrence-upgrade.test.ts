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
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

const ROOT_ID = testRunId("prompt-occurrence-upgrade-root");
const SELECT_MESSAGE = "  Preserve this prompt exactly?\nSecond line.  ";
const SELECT_OPTIONS = [" first ", "second\nvalue", "third  "] as const;
const SELECT_RESPONSE = SELECT_OPTIONS[1];
const HOLD_MESSAGE = "  Finish upgrade replay?  ";
const HOLD_RESPONSE = "  raw response\nkept  ";

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

async function waitForPrompt(
	store: ReturnType<typeof createStore>,
	kind: "select" | "input",
	timeoutMs = 2_000,
): Promise<{ runId: string; stage: StageSnapshot }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const snapshot of store.runs()) {
			const stage = snapshot.stages.find((candidate) => candidate.pendingPrompt?.kind === kind);
			if (stage !== undefined) return { runId: snapshot.id, stage };
		}
		await sleep(5);
	}
	throw new Error(`pending ${kind} prompt did not appear`);
}

function reservationIds(sdk: ReturnType<typeof createMockSdk>): string[] {
	const ids = new Set<string>();
	for (const value of sdk.state.steps.values()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const event = value as Record<string, WorkflowSerializableValue>;
		if (
			event.__atomicPromptReservation === true &&
			event.operation === "reserve" &&
			typeof event.reservationId === "string"
		)
			ids.add(event.reservationId);
	}
	return [...ids];
}

interface LegacyPromptRecord {
	readonly key: string;
	readonly envelope: WorkflowSerializableValue;
	readonly checkpointId: string;
	readonly stageId: string;
	readonly replayKey: string;
}

function makeAuthenticLegacyPromptShape(sdk: ReturnType<typeof createMockSdk>): LegacyPromptRecord {
	let stripped: LegacyPromptRecord | undefined;
	let removedActive = 0;
	for (const [key, value] of [...sdk.state.steps]) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const envelope = value as Record<string, WorkflowSerializableValue>;
		if (envelope.kind !== "stage" || envelope.name !== "select") continue;
		const topologyValue = envelope.topology;
		if (typeof topologyValue !== "object" || topologyValue === null || Array.isArray(topologyValue)) continue;
		const topology = topologyValue as Record<string, WorkflowSerializableValue>;
		if (topology.status === "running") {
			sdk.state.steps.delete(key);
			removedActive += 1;
			continue;
		}
		if (topology.status !== "completed") continue;
		const legacy = structuredClone(envelope);
		const legacyTopology = legacy.topology as Record<string, WorkflowSerializableValue>;
		delete legacyTopology.occurrenceKey;
		sdk.state.steps.set(key, legacy);
		assert.equal(typeof legacy.checkpointId, "string");
		assert.equal(typeof legacy.replayKey, "string");
		assert.equal(typeof legacyTopology.stageId, "string");
		stripped = {
			key,
			envelope: structuredClone(legacy),
			checkpointId: legacy.checkpointId as string,
			replayKey: legacy.replayKey as string,
			stageId: legacyTopology.stageId as string,
		};
	}
	assert.ok(stripped, "one completed select prompt record must be downgraded");
	assert.equal(removedActive, 1, "the pre-repair format had no active prompt-start record");
	return stripped;
}

async function releasePromptOwners(sdk: ReturnType<typeof createMockSdk>, backend: DbosDurableBackend): Promise<void> {
	for (const reservationId of reservationIds(sdk)) {
		const token = backend.pendingPromptToken(ROOT_ID, reservationId);
		if (token !== undefined) backend.releasePendingPrompt(ROOT_ID, reservationId, token);
	}
	await backend.flush();
}

test.sequential("fresh DBOS replay coalesces an omitted occurrenceKey prompt with current metadata", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "prompt-upgrade-writer" });
	const writerStore = createStore();
	const writerControls = createStageControlRegistry();
	let workflowCalls = 0;
	const root = workflow({
		name: ROOT_ID,
		description: "",
		inputs: {},
		outputs: { choice: Type.String(), response: Type.String() },
		run: async (ctx) => {
			workflowCalls += 1;
			const choice = await ctx.ui.select(SELECT_MESSAGE, SELECT_OPTIONS);
			const response = await ctx.ui.input(HOLD_MESSAGE);
			return { choice, response };
		},
	});

	const controller = new AbortController();
	const firstExecution = run(
		root,
		{},
		{
			runId: ROOT_ID,
			store: writerStore,
			stageControlRegistry: writerControls,
			durableBackend: writer,
			signal: controller.signal,
			usePromptNodesForUi: true,
		},
	);
	const originalSelect = await waitForPrompt(writerStore, "select");
	assert.equal(originalSelect.stage.pendingPrompt?.message, SELECT_MESSAGE);
	assert.deepEqual(originalSelect.stage.pendingPrompt?.choices, SELECT_OPTIONS);
	assert.equal(
		writerStore.resolveStagePendingPrompt(
			originalSelect.runId,
			originalSelect.stage.id,
			originalSelect.stage.pendingPrompt!.id,
			SELECT_RESPONSE,
		),
		true,
	);
	await waitForPrompt(writerStore, "input");
	await writer.flush();

	setDurableBackend(writer);
	const quit = await quitRun(ROOT_ID, { store: writerStore, stageControlRegistry: writerControls });
	assert.equal(quit.ok, true);
	await releasePromptOwners(sdk, writer);
	const persisted = copySdk(sdk);
	const legacy = makeAuthenticLegacyPromptShape(persisted);
	setDurableBackend(undefined);
	controller.abort(new Error("legacy writer process exited"));
	await firstExecution;

	const fresh = new DbosDurableBackend(persisted, { executorId: "prompt-upgrade-fresh" });
	await fresh.hydrateWorkflow(ROOT_ID);
	const decodedLegacy = fresh
		.listCheckpoints(ROOT_ID)
		.find((checkpoint) => checkpoint.kind === "stage" && checkpoint.checkpointId === legacy.checkpointId);
	assert.equal(decodedLegacy?.kind, "stage");
	assert.equal(decodedLegacy?.kind === "stage" ? decodedLegacy.topology?.occurrenceKey : "unexpected", undefined);

	const jobs = createJobTracker();
	const controls = createStageControlRegistry();
	const resumed = await resumeDurableWorkflow(ROOT_ID, {
		registry: createRegistry([root]),
		durableBackend: fresh,
		jobs,
		baseRunOpts: {
			store: workflowStore,
			cancellation: createCancellationRegistry(),
			stageControlRegistry: controls,
		},
	});
	assert.equal(resumed.ok, true, JSON.stringify(resumed));
	const freshInput = await waitForPrompt(workflowStore, "input");
	const freshRoot = workflowStore.runs().find((candidate) => candidate.id === ROOT_ID)!;
	const freshSelects = freshRoot.stages.filter((stage) => stage.name === "select");
	assert.equal(freshSelects.length, 1, "the cached response creates one replayed prompt node");
	const freshSelect = freshSelects[0]!;
	assert.equal(freshSelect.id, legacy.stageId);
	assert.equal(freshSelect.status, "completed");
	assert.equal(freshSelect.replayed, true);
	assert.equal(freshSelect.pendingPrompt, undefined, "the select response is a durable cache hit");
	assert.equal(freshSelect.promptFootprint?.message, SELECT_MESSAGE);
	assert.deepEqual(freshSelect.promptFootprint?.choices, SELECT_OPTIONS);
	const target = resolveStageTarget(ROOT_ID, freshSelect.id);
	assert.deepEqual(target, { ok: true, runId: ROOT_ID, stageId: legacy.stageId });
	assert.equal(Object.getPrototypeOf(target), Object.prototype);

	const answer = await workflowSendAction({
		runId: ROOT_ID,
		stageId: freshInput.stage.id,
		promptId: freshInput.stage.pendingPrompt!.id,
		response: HOLD_RESPONSE,
		delivery: "answer",
	});
	assert.equal(answer.status, "ok");
	await jobs.get(ROOT_ID)!.promise;
	await fresh.flush();
	assert.equal(workflowCalls, 2);
	assert.deepEqual(workflowStore.runs().find((candidate) => candidate.id === ROOT_ID)?.result, {
		choice: SELECT_RESPONSE,
		response: HOLD_RESPONSE,
	});
	assert.deepEqual(persisted.state.steps.get(legacy.key), legacy.envelope, "the omitted legacy record stays verbatim");

	const selectRecords = fresh
		.listCheckpoints(ROOT_ID)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.name === "select" && checkpoint.topology?.status === "completed",
		);
	assert.equal(selectRecords.length, 2);
	assert.deepEqual(new Set(selectRecords.map((checkpoint) => checkpoint.replayKey)), new Set([legacy.replayKey]));
	assert.deepEqual(
		new Set(selectRecords.map((checkpoint) => checkpoint.topology?.stageId)),
		new Set([legacy.stageId]),
	);
	assert.deepEqual(
		new Set(selectRecords.map((checkpoint) => checkpoint.topology?.occurrenceKey)),
		new Set([undefined, legacy.stageId]),
	);

	const catalogBackend = new DbosDurableBackend(copySdk(persisted), { executorId: "prompt-upgrade-catalog" });
	await catalogBackend.hydrateWorkflow(ROOT_ID);
	const openable = listOpenableCompletedWorkflows(catalogBackend);
	assert.deepEqual(
		openable.map((entry) => entry.workflowId),
		[ROOT_ID],
	);
	const inspectedRuns = completedWorkflowRunSnapshots(catalogBackend, openable[0]!);
	assert.deepEqual(
		inspectedRuns.map((snapshot) => snapshot.id),
		[ROOT_ID],
	);
	const inspectedSelects = inspectedRuns[0]!.stages.filter((stage) => stage.name === "select");
	assert.equal(inspectedSelects.length, 1);
	assert.equal(inspectedSelects[0]!.id, legacy.stageId);
	assert.equal(inspectedSelects[0]!.status, "completed");
});

test("fresh DBOS active root rejects an occurrence bound to different replay keys before prompt replay", async () => {
	const rootId = testRunId("prompt-occurrence-active-poison");
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: rootId, name: rootId, status: "PENDING", createdAt: 1 });
	for (const [index, replayKey] of ["prompt:input:first", "prompt:input:SECOND-DIFFERENT"].entries()) {
		seedMockCheckpoint(sdk, rootId, {
			kind: "stage",
			workflowId: rootId,
			checkpointId: `active-prompt-poison-${index}`,
			name: "input",
			replayKey,
			completedAt: 2 + index,
			startedAt: 1,
			endedAt: 2 + index,
			topology: {
				version: 1,
				stageId: "active-poison-stage",
				parentIds: [],
				sourceOrder: 0,
				occurrenceKey: "active-shared-occurrence",
				status: "completed",
				run: { runId: rootId, runName: rootId },
			},
		});
	}
	const backend = new DbosDurableBackend(sdk, { executorId: "prompt-occurrence-active-fresh" });
	await backend.hydrateWorkflow(rootId);
	const store = createStore();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("poison was not rejected")), 250);
	const root = workflow({
		name: rootId,
		description: "",
		inputs: {},
		outputs: { response: Type.String() },
		run: async (ctx) => ({ response: await ctx.ui.input("must never become pending") }),
	});
	try {
		const result = await run(
			root,
			{},
			{
				runId: rootId,
				store,
				durableBackend: backend,
				signal: controller.signal,
				usePromptNodesForUi: true,
			},
		);
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /prompt occurrence is bound to multiple replay keys/);
		assert.deepEqual(store.runs().find((snapshot) => snapshot.id === rootId)?.stages, []);
	} finally {
		clearTimeout(timeout);
	}
});
