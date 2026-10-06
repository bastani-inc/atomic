import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => setDurableBackend(undefined));

test("transport confirmation heals committed context receipt accounting after a read failure (#3467)", async () => {
	const runId = testRunId("sticky-confirmation-accounting");
	const stageId = "recipient-stage";
	const sessionId = "recipient-session";
	const messageId = "confirmation-accounting";
	const target = `workflow:${runId}/**`;
	const group = `workflow:${runId}`;
	const sdk = createMockSdk();
	let failReceiptRead = false;
	const backend = new DbosDurableBackend({
		...sdk,
		readStepRecord: async (workflowId, stepName) => {
			const record = (await sdk.listStepRecords(workflowId)).find((candidate) => candidate.stepName === stepName);
			if (failReceiptRead && stepName.startsWith("__atomic_pending_delivery_receipt:") && record !== undefined) {
				failReceiptRead = false;
				throw new Error("post-write receipt read fault");
			}
			return record;
		},
	});
	backend.registerWorkflow({ workflowId: runId, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await backend.flush();
	setDurableBackend(backend);
	const store = createStore();
	const stage = {
		id: stageId,
		name: "recipient",
		status: "failed" as const,
		parentIds: [],
		toolEvents: [],
		pendingStageDeliveryAvailable: true,
		sessionId,
	};
	store.recordRunStart({ id: runId, name: "flow", inputs: {}, status: "running", stages: [stage], startedAt: 1 });
	const queued = await store.queueStickyStageMessage(
		{
			runId,
			stageKey: target,
			targetPath: target,
			from: { id: "sender-session", name: "sender", group },
			message: { id: messageId, timestamp: 1, content: { text: "sticky instruction" } },
			queuedAt: "2026-09-01T00:00:00.000Z",
		},
		group,
		group,
		backend,
	);
	assert.equal(queued?.ok, true);
	let callbacks = 0;
	failReceiptRead = true;
	await assert.rejects(
		createWorkflowPendingStageDelivery(store, runId, stageId, stage.name).deliverPending(
			() => {
				callbacks += 1;
			},
			{ sessionId, receivedMessageIds: [] },
		),
		/post-write receipt read fault/,
	);
	assert.equal(callbacks, 1);
	assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 0);
	assert.equal(backend.getPendingStageMessageDeliveryCount(runId, messageId), 0);
	store.recordStageEnd(runId, { ...stage, status: "running" });
	const listeners = new Map<string, (payload: unknown) => void>();
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit() {},
				on(event: string, listener: (payload: unknown) => void) {
					listeners.set(event, listener);
					return () => listeners.delete(event);
				},
			},
		},
		store,
	);
	let invalidations = 0;
	const unsubscribe = store.subscribeInvalidation(() => {
		invalidations += 1;
	});
	const version = store.snapshot().version;
	try {
		const confirmation: {
			handled: boolean;
			completion?: Promise<boolean>;
			runId: string;
			messageId: string;
			target: string;
			deliveredTargets: string[];
		} = { handled: false, runId, messageId, target, deliveredTargets: [`workflow:${runId}/${stageId}`] };
		listeners.get("atomic:workflow-sticky-live-delivered")?.(confirmation);
		assert.equal(confirmation.handled, true);
		assert.ok(confirmation.completion);
		assert.equal(await confirmation.completion, false);
		assert.equal(callbacks, 1);
		assert.equal(backend.getPendingStageMessageDeliveryCount(runId, messageId), 1);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.deliveryCount, 1);
		assert.equal(store.snapshot().version, version + 1);
		assert.equal(invalidations, 1);
	} finally {
		unsubscribe();
		dispose();
	}
});
