import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { durableBackendForRun } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const ROOT_RUN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_RUN_ID = "22222222-2222-4222-8222-222222222222";

function pendingMessage(runId: string, stageKey: string, id: string): PendingStageMessage {
	return {
		id,
		runId,
		stageKey,
		stageId: `${stageKey}-id`,
		stageReplayKey: `stage:${stageKey}:1`,
		from: { id: "planner-id", name: "planner", group: `workflow:${ROOT_RUN_ID}`, cwd: "/repo" },
		message: { id, timestamp: 100, content: { text: `scope ${id}` } },
		queuedAt: "2026-08-27T17:00:00.000Z",
		admissionOrder: 1,
		status: "queued",
	};
}

afterEach(() => setDurableBackend(undefined));

test("a child run hydrates and drains only its logical pending messages through the root durable handle", async () => {
	const rootEntry = pendingMessage(ROOT_RUN_ID, "root-receiver", "root-message");
	const childEntry = pendingMessage(CHILD_RUN_ID, "receiver", "child-message");
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({
		workflowId: ROOT_RUN_ID,
		name: "root",
		inputs: {},
		createdAt: 1,
		status: "running",
		pendingStageMessages: [rootEntry, childEntry],
	});
	setDurableBackend(backend);
	const store = createStore();
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "root",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "child-boundary",
				name: "workflow:child",
				status: "running",
				parentIds: [],
				toolEvents: [],
				replayKey: "workflow:child:1",
				workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
			},
		],
		pendingStageMessages: [rootEntry],
		startedAt: 1,
	});
	const childStarted = Promise.withResolvers<void>();
	const releaseChild = Promise.withResolvers<void>();
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const receiver = ctx.stage("receiver");
			childStarted.resolve();
			await releaseChild.promise;
			return { value: await receiver.complete("task") };
		},
	});
	const runPromise = run(
		child,
		{},
		{
			runId: CHILD_RUN_ID,
			store,
			durableBackend: backend,
			durableRootBackend: backend,
			durableScope: { rootWorkflowId: ROOT_RUN_ID, scopePrefix: "workflow:child:1" },
			parentRun: { runId: ROOT_RUN_ID, stageId: "child-boundary", rootRunId: ROOT_RUN_ID },
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	await childStarted.promise;

	assert.deepEqual(
		store
			.runs()
			.find((candidate) => candidate.id === CHILD_RUN_ID)
			?.pendingStageMessages?.map((entry) => entry.id),
		[childEntry.id],
	);
	assert.deepEqual(
		store
			.runs()
			.find((candidate) => candidate.id === ROOT_RUN_ID)
			?.pendingStageMessages?.map((entry) => entry.id),
		[rootEntry.id],
	);
	const childStage = store
		.runs()
		.find((candidate) => candidate.id === CHILD_RUN_ID)
		?.stages.find((stage) => stage.name === "receiver");
	assert.ok(childStage !== undefined);
	const deliveries: Array<{ readonly id: string; readonly senderId: string; readonly cwd: string }> = [];
	const drain = async () =>
		await createWorkflowPendingStageDelivery(store, CHILD_RUN_ID, childStage.id, childStage.name).deliverPending(
			async (from, message) => {
				deliveries.push({ id: message.id, senderId: from.id, cwd: from.cwd });
			},
		);
	await drain();
	await drain();
	assert.deepEqual(deliveries, [{ id: childEntry.id, senderId: "planner-id", cwd: "/repo" }]);
	assert.deepEqual(
		backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages?.map((entry) => [entry.id, entry.status]),
		[
			[rootEntry.id, "queued"],
			[childEntry.id, "delivered"],
		],
	);
	assert.equal(backend.getWorkflow(CHILD_RUN_ID), undefined);

	releaseChild.resolve();
	assert.equal((await runPromise).status, "completed");
});

test("actual nested orchestration reloads a child queue from root metadata and delivers it once", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "nested-pending-writer" });
	let stageStarted = Promise.withResolvers<void>();
	let releaseStage = Promise.withResolvers<void>();
	const child = workflow({
		name: "restart-child",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const receiver = ctx.stage("receiver");
			stageStarted.resolve();
			await releaseStage.promise;
			return { value: await receiver.complete("task") };
		},
	});
	const parent = workflow({
		name: "restart-root",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const result = await ctx.workflow(child);
			if (result.exited) throw new Error("child exited");
			return result.outputs;
		},
	});
	const adapters = { complete: { complete: async (text: string) => text } };
	const firstStore = createStore();
	const firstController = new AbortController();
	const firstRun = run(
		parent,
		{},
		{
			runId: ROOT_RUN_ID,
			store: firstStore,
			durableBackend: writer,
			signal: firstController.signal,
			adapters,
		},
	);
	await stageStarted.promise;
	const firstChild = firstStore.runs().find((candidate) => candidate.parentRunId === ROOT_RUN_ID);
	assert.ok(firstChild !== undefined);
	const firstStage = firstChild.stages.find((stage) => stage.name === "receiver");
	assert.ok(firstStage !== undefined);
	const childBackend = durableBackendForRun(writer, firstStore.runs(), firstChild.id);
	assert.ok(childBackend !== undefined);
	const group = `workflow:${ROOT_RUN_ID}`;
	const queued = await firstStore.queueStageMessage(
		{
			runId: firstChild.id,
			stageKey: "receiver",
			from: { id: "planner-id", name: "planner", group, cwd: "/repo" },
			message: { id: "restart-child-message", timestamp: 200, content: { text: "persist across process" } },
			queuedAt: "2026-08-27T17:10:00.000Z",
		},
		group,
		group,
		childBackend,
	);
	assert.equal(queued?.ok, true);
	await writer.flush();
	const persistedSdk = createMockSdk();
	for (const [key, value] of sdk.state.workflows) persistedSdk.state.workflows.set(key, { ...value });
	for (const [key, value] of sdk.state.steps) persistedSdk.state.steps.set(key, structuredClone(value));

	firstController.abort(new Error("old process stopped"));
	releaseStage.resolve();
	await firstRun;

	stageStarted = Promise.withResolvers<void>();
	releaseStage = Promise.withResolvers<void>();
	const reader = new DbosDurableBackend(persistedSdk, { executorId: "nested-pending-reader" });
	await reader.hydrateWorkflow(ROOT_RUN_ID);
	setDurableBackend(reader);
	const resumedStore = createStore();
	const resumedRun = run(
		parent,
		{},
		{
			runId: ROOT_RUN_ID,
			store: resumedStore,
			durableBackend: reader,
			adapters,
		},
	);
	await stageStarted.promise;
	const resumedRoot = resumedStore.runs().find((candidate) => candidate.id === ROOT_RUN_ID);
	const resumedChild = resumedStore.runs().find((candidate) => candidate.parentRunId === ROOT_RUN_ID);
	assert.ok(resumedRoot !== undefined);
	assert.ok(resumedChild !== undefined);
	assert.equal(resumedChild.id, firstChild.id);
	assert.deepEqual(resumedRoot.pendingStageMessages, []);
	assert.deepEqual(
		resumedChild.pendingStageMessages?.map((entry) => entry.message.id),
		["restart-child-message"],
	);
	const resumedStage = resumedChild.stages.find((stage) => stage.name === "receiver");
	assert.ok(resumedStage !== undefined);
	assert.deepEqual(
		await resumedStore.validateLiveStageMessage({
			runId: resumedChild.id,
			stageKey: resumedStage.id,
			from: { id: "planner-id", name: "planner", group, cwd: "/repo" },
			message: { id: "restart-child-message", timestamp: 200, content: { text: "persist across process" } },
			queuedAt: "later",
		}),
		{ outcome: "queued", position: 1 },
	);
	assert.deepEqual(
		await resumedStore.validateLiveStageMessage({
			runId: resumedChild.id,
			stageKey: resumedStage.id,
			from: { id: "planner-id", name: "planner", group, cwd: "/repo" },
			message: { id: "restart-child-message", timestamp: 200, content: { text: "conflict" } },
			queuedAt: "later",
		}),
		{ outcome: "message_id_conflict", messageId: "restart-child-message" },
	);
	const deliveries: Array<{ readonly id: string; readonly from: string }> = [];
	const pending = createWorkflowPendingStageDelivery(
		resumedStore,
		resumedChild.id,
		resumedStage.id,
		resumedStage.name,
	);
	await pending.deliverPending(async (from, message) => {
		deliveries.push({ id: message.id, from: from.id });
	});
	await pending.deliverPending(async (from, message) => {
		deliveries.push({ id: message.id, from: from.id });
	});
	assert.deepEqual(deliveries, [{ id: "restart-child-message", from: "planner-id" }]);
	assert.deepEqual(
		await resumedStore.validateLiveStageMessage({
			runId: resumedChild.id,
			stageKey: resumedStage.id,
			from: { id: "planner-id", name: "planner", group, cwd: "/repo" },
			message: { id: "restart-child-message", timestamp: 200, content: { text: "persist across process" } },
			queuedAt: "later",
		}),
		{ outcome: "delivered" },
	);

	releaseStage.resolve();
	assert.equal((await resumedRun).status, "completed");
	await reader.flush();
	const reloaded = new DbosDurableBackend(persistedSdk, { executorId: "nested-pending-verifier" });
	await reloaded.hydrateWorkflow(ROOT_RUN_ID);
	const persisted = reloaded.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0]?.runId, firstChild.id);
	assert.equal(persisted[0]?.status, "delivered");
	assert.equal(reloaded.getWorkflow(firstChild.id), undefined);
});

test("root, siblings, and arbitrarily nested children isolate dedupe, capacity, and status", async () => {
	const siblingRunId = "33333333-3333-4333-8333-333333333333";
	const grandchildRunId = "44444444-4444-4444-8444-444444444444";
	const stage = (id: string, name = id) => ({
		id,
		name,
		status: "pending" as const,
		parentIds: [] as string[],
		toolEvents: [],
		replayKey: `stage:${name}:1`,
	});
	const store = createStore();
	store.recordRunStart({
		id: ROOT_RUN_ID,
		name: "root",
		inputs: {},
		status: "running",
		stages: [
			stage("shared-stage", "shared"),
			{
				...stage("child-boundary", "workflow:child"),
				status: "running",
				replayKey: "workflow:child:1",
				workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
			},
			{
				...stage("sibling-boundary", "workflow:sibling"),
				status: "running",
				replayKey: "workflow:sibling:1",
				workflowChildRun: { alias: "sibling", workflow: "sibling", runId: siblingRunId },
			},
		],
		startedAt: 1,
	});
	store.recordRunStart({
		id: CHILD_RUN_ID,
		name: "child",
		inputs: {},
		status: "running",
		parentRunId: ROOT_RUN_ID,
		parentStageId: "child-boundary",
		rootRunId: ROOT_RUN_ID,
		stages: [
			stage("shared-stage", "shared"),
			{
				...stage("grandchild-boundary", "workflow:grandchild"),
				status: "running",
				replayKey: "workflow:grandchild:1",
				workflowChildRun: { alias: "grandchild", workflow: "grandchild", runId: grandchildRunId },
			},
		],
		startedAt: 2,
	});
	store.recordRunStart({
		id: siblingRunId,
		name: "sibling",
		inputs: {},
		status: "running",
		parentRunId: ROOT_RUN_ID,
		parentStageId: "sibling-boundary",
		rootRunId: ROOT_RUN_ID,
		stages: [stage("shared-stage", "shared")],
		startedAt: 3,
	});
	store.recordRunStart({
		id: grandchildRunId,
		name: "grandchild",
		inputs: {},
		status: "running",
		parentRunId: CHILD_RUN_ID,
		parentStageId: "grandchild-boundary",
		rootRunId: ROOT_RUN_ID,
		stages: [stage("shared-stage", "shared")],
		startedAt: 4,
	});
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: ROOT_RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
	const group = `workflow:${ROOT_RUN_ID}`;
	const sender = { id: "planner-id", name: "planner", group };
	const views = new Map(
		[ROOT_RUN_ID, CHILD_RUN_ID, siblingRunId, grandchildRunId].map((runId) => {
			const view = durableBackendForRun(backend, store.runs(), runId);
			assert.ok(view !== undefined);
			return [runId, view] as const;
		}),
	);
	const queue = async (runId: string, id: string, text = `scope ${id}`) =>
		await store.queueStageMessage(
			{
				runId,
				stageKey: "shared",
				from: sender,
				message: { id, timestamp: 100, content: { text } },
				queuedAt: "2026-08-27T17:20:00.000Z",
			},
			group,
			group,
			views.get(runId)!,
		);
	for (const runId of [ROOT_RUN_ID, CHILD_RUN_ID, siblingRunId, grandchildRunId]) {
		assert.equal((await queue(runId, "same-logical-id"))?.ok, true);
	}
	const duplicate = await queue(grandchildRunId, "same-logical-id");
	assert.equal(duplicate?.ok, true);
	assert.equal(duplicate?.ok === true ? duplicate.deduplicated : undefined, true);
	const conflict = await queue(grandchildRunId, "same-logical-id", "different");
	assert.equal(conflict?.ok, false);
	assert.equal(conflict?.ok === false ? conflict.reason : undefined, "message_id_conflict");
	for (let index = 2; index <= 50; index += 1) {
		assert.equal((await queue(siblingRunId, `sibling-${index}`))?.ok, true);
	}
	const full = await queue(siblingRunId, "sibling-51");
	assert.equal(full?.ok, false);
	assert.equal(full?.ok === false ? full.reason : undefined, "capacity");
	assert.equal(store.pendingStageMessagesFor(CHILD_RUN_ID, "shared").length, 1);
	assert.equal(store.pendingStageMessagesFor(grandchildRunId, "shared").length, 1);
	assert.equal(
		await store.markPendingStageMessageDelivered(
			grandchildRunId,
			"shared",
			"same-logical-id",
			"2026-08-27T17:30:00.000Z",
			views.get(grandchildRunId)!,
		),
		true,
	);
	const durable = backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
	assert.equal(durable.filter((entry) => entry.runId === siblingRunId && entry.status === "queued").length, 50);
	assert.equal(durable.find((entry) => entry.runId === grandchildRunId)?.status, "delivered");
	assert.equal(durable.find((entry) => entry.runId === CHILD_RUN_ID)?.status, "queued");
	assert.equal(durable.find((entry) => entry.runId === ROOT_RUN_ID)?.status, "queued");
	assert.equal(backend.getWorkflow(CHILD_RUN_ID), undefined);
	assert.equal(backend.getWorkflow(siblingRunId), undefined);
	const offlineRunId = "55555555-5555-4555-8555-555555555555";
	store.recordRunStart({
		id: offlineRunId,
		name: "offline",
		inputs: {},
		status: "running",
		rootRunId: ROOT_RUN_ID,
		stages: [stage("shared-stage", "shared")],
		startedAt: 5,
	});
	assert.equal(durableBackendForRun(backend, store.runs(), offlineRunId), undefined);
	assert.equal(backend.getWorkflow(grandchildRunId), undefined);
});
