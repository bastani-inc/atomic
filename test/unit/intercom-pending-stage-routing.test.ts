import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager-core.ts";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	PENDING_STAGE_ASK_REFUSAL,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `${RUN_ID}:reviewer`;

const tempDirs: string[] = [];

function sender(socket: net.Socket): BrokerConnectedSession {
	return {
		socket,
		info: {
			id: "sender-id",
			name: "planner",
			cwd: "/repo",
			model: "test-model",
			pid: 10,
			startedAt: 11,
			lastActivity: 12,
			group: GROUP,
		},
	};
}

function message(id: string, timestamp = 100): Message {
	return { id, timestamp, content: { text: `scope ${id}` } };
}

afterEach(() => {
	setDurableBackend(undefined);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("pending-stage fallback runs only for a valid composite unknown target and preserves ordinary unknown failures", () => {
	const socket = {} as net.Socket;
	const sessions = new Map([["sender-id", sender(socket)]]);
	const writes: BrokerMessage[] = [];
	const routed: string[] = [];
	const route = (input: { readonly runId: string; readonly stageKey: string }): boolean => {
		routed.push(`${input.runId}:${input.stageKey}`);
		return true;
	};
	handleBrokerSend(
		socket,
		{ type: "send", to: TARGET, message: message("queued") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
	);
	assert.deepEqual(routed, [TARGET]);
	assert.equal(writes.length, 0);

	handleBrokerSend(
		socket,
		{ type: "send", to: "ordinary-missing", message: message("missing") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
	);
	assert.deepEqual(routed, [TARGET]);
	assert.deepEqual(writes.at(-1), {
		type: "delivery_failed",
		messageId: "missing",
		attemptId: undefined,
		reason: "Session not found",
	});
});

test("live workflow stage targets still deliver immediately before pending-stage fallback", () => {
	const senderSocket = {} as net.Socket;
	const targetSocket = {} as net.Socket;
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender-id", sender(senderSocket)],
		[
			TARGET,
			{
				socket: targetSocket,
				info: { ...sender(targetSocket).info, id: TARGET, name: "reviewer" },
			},
		],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	let deferredRouteCalled = false;
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: TARGET, message: message("live") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(socket, value) => writes.push({ socket, message: value }),
		undefined,
		undefined,
		() => {
			deferredRouteCalled = true;
			return true;
		},
	);
	assert.equal(deferredRouteCalled, false);
	assert.deepEqual(writes, [
		{ socket: targetSocket, message: { type: "message", from: sender(senderSocket).info, message: message("live") } },
		{ socket: senderSocket, message: { type: "delivered", messageId: "live", attemptId: undefined } },
	]);
});

test("pending-stage ask refusal recommends nonblocking send", () => {
	assert.equal(PENDING_STAGE_ASK_REFUSAL.includes("Use send"), true);
});

describe("workflows-owned pending-stage delivery event bridge", () => {
	function harness() {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const listeners = new Map<string, (payload: unknown) => void>();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const pi = {
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					emitted.push({ event, payload });
					listeners.get(event)?.(payload);
				},
				on(event: string, listener: (payload: unknown) => void) {
					listeners.set(event, listener);
					return () => listeners.delete(event);
				},
			},
		};
		const dispose = registerPendingStageIntercomBridge(pi, store);
		const request = async (
			id: string,
			group = GROUP,
			stageKey = "reviewer",
			messageOverride: Message = message(id, 1_725_000_000_000 + Number(id)),
		) => {
			const payload: {
				handled: boolean;
				completion?: Promise<
					| { readonly outcome: "queued"; readonly position: number }
					| { readonly outcome: "delivered" }
					| { readonly outcome: "refused"; readonly reason: string }
				>;
				requestId: string;
				from: SessionInfo;
				runId: string;
				stageKey: string;
				message: Message;
			} = {
				handled: false,
				requestId: `request-${id}`,
				from: { ...sender({} as net.Socket).info, group },
				runId: RUN_ID,
				stageKey,
				message: messageOverride,
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return { payload, result: payload.completion === undefined ? undefined : await payload.completion };
		};
		return { store, backend, emitted, request, dispose };
	}

	test("announces ownership and enforces group isolation without requesting", async () => {
		const { store, emitted, request, dispose } = harness();
		assert.equal(
			emitted.some(({ event }) => event === "atomic:workflow-pending-stage-route"),
			true,
		);
		const { payload, result } = await request("1", "other-group");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, {
			outcome: "refused",
			reason: "Target workflow run is in a different intercom group",
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 0);
		dispose();
	});

	test("enforces one exact 50-message cap across stage id and name aliases", async () => {
		const { store, backend, request, dispose } = harness();
		for (let index = 1; index <= 50; index += 1) {
			const stageKey = index % 2 === 0 ? "reviewer-id" : "reviewer";
			assert.deepEqual((await request(String(index), GROUP, stageKey)).result, {
				outcome: "queued",
				position: index,
			});
		}
		assert.deepEqual((await request("51", GROUP, "reviewer-id")).result, {
			outcome: "refused",
			reason: `Pending stage message queue is full (limit 50) for ${RUN_ID}:reviewer-id`,
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 50);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer-id").length, 50);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 50);
		dispose();
	});

	test("deduplicates identical alias replays and rejects conflicting message-id reuse", async () => {
		const { store, backend, request, dispose } = harness();
		const original = message("stable", 100);
		assert.deepEqual((await request("stable", GROUP, "reviewer", original)).result, {
			outcome: "queued",
			position: 1,
		});
		assert.deepEqual((await request("stable", GROUP, "reviewer-id", original)).result, {
			outcome: "queued",
			position: 1,
		});
		assert.deepEqual(
			(
				await request("stable", GROUP, "reviewer-id", {
					...original,
					content: { text: "conflicting payload" },
				})
			).result,
			{
				outcome: "refused",
				reason: `Intercom message ID 'stable' was already queued for ${RUN_ID}:reviewer-id with a different target, sender, or payload`,
			},
		);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 1);
		dispose();
	});

	test("refuses an unknown stage key under a known run without queueing", async () => {
		const { store, request, dispose } = harness();
		const { payload, result } = await request("1", GROUP, "unknown-stage");
		assert.equal(payload.handled, false);
		assert.equal(result, undefined);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
		dispose();
	});

	test("validates the stage before refusing an ask", async () => {
		const { store, request, dispose } = harness();
		const ask = { ...message("ask"), expectsReply: true };
		const unknown = await request("ask", GROUP, "unknown-stage", ask);
		assert.equal(unknown.payload.handled, false);
		assert.equal(unknown.result, undefined);
		const pending = await request("ask", GROUP, "reviewer", ask);
		assert.equal(pending.payload.handled, true);
		assert.deepEqual(pending.result, {
			outcome: "refused",
			reason: PENDING_STAGE_ASK_REFUSAL,
		});
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "reviewer"), []);
		dispose();
	});
	test("queues a known nested child stage through its root durable owner", async () => {
		const childRunId = "22222222-2222-4222-8222-222222222222";
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "root-reviewer-id",
					name: "root-reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:root-reviewer:1",
					pendingStageDeliveryAvailable: true,
				},
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child", runId: childRunId },
				},
			],
			startedAt: 1,
		});
		store.recordRunStart({
			id: childRunId,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: RUN_ID,
			parentStageId: "child-boundary",
			rootRunId: RUN_ID,
			stages: [
				{
					id: "child-reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:reviewer:1",
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 2,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const rootMessage = message("root-existing", 100);
		assert.equal(
			(
				await store.queueStageMessage(
					{
						runId: RUN_ID,
						stageKey: "root-reviewer",
						from: sender({} as net.Socket).info,
						message: rootMessage,
						queuedAt: "2026-08-27T17:00:00.000Z",
					},
					GROUP,
					GROUP,
					backend,
				)
			)?.ok,
			true,
		);
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
		const nestedMessage = message("nested-child", 200);
		const payload: {
			handled: boolean;
			completion?: Promise<{ readonly outcome: "queued"; readonly position: number }>;
			from: SessionInfo;
			runId: string;
			stageKey: string;
			message: Message;
		} = {
			handled: false,
			from: sender({} as net.Socket).info,
			runId: childRunId,
			stageKey: "reviewer",
			message: nestedMessage,
		};

		listeners.get("atomic:workflow-pending-stage-message")?.(payload);

		assert.equal(payload.handled, true);
		assert.deepEqual(await payload.completion, { outcome: "queued", position: 1 });
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "root-reviewer")[0]?.message.id, rootMessage.id);
		assert.equal(store.pendingStageMessagesFor(childRunId, "reviewer")[0]?.message.id, nestedMessage.id);
		assert.equal(backend.getWorkflow(childRunId), undefined);
		assert.deepEqual(
			backend.getWorkflow(RUN_ID)?.pendingStageMessages?.map((entry) => [entry.runId, entry.message.id]),
			[
				[RUN_ID, rootMessage.id],
				[childRunId, nestedMessage.id],
			],
		);
		const deliveries: Array<{ readonly id: string; readonly senderId: string; readonly senderName?: string }> = [];
		const drain = async () =>
			await createWorkflowPendingStageDelivery(store, childRunId, "child-reviewer-id", "reviewer").deliverPending(
				async (from, entryMessage) => {
					deliveries.push({ id: entryMessage.id, senderId: from.id, senderName: from.name });
				},
			);
		await drain();
		await drain();
		assert.deepEqual(deliveries, [{ id: nestedMessage.id, senderId: "sender-id", senderName: "planner" }]);
		assert.deepEqual(
			backend.getWorkflow(RUN_ID)?.pendingStageMessages?.map((entry) => [entry.runId, entry.status]),
			[
				[RUN_ID, "queued"],
				[childRunId, "delivered"],
			],
		);
		dispose();
	});
});

test("reloads and drains aliases by durable deposit order rather than sender timestamp exactly once", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "fifo-writer" });
	writer.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [{ id: "stage-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	setDurableBackend(writer);
	const from = sender({} as net.Socket).info;
	await store.queueStageMessage(
		{ runId: RUN_ID, stageKey: "reviewer", from, message: message("deposit-a", 200), queuedAt: "2026-01-02" },
		GROUP,
		GROUP,
		writer,
	);
	await store.queueStageMessage(
		{ runId: RUN_ID, stageKey: "stage-id", from, message: message("deposit-b", 100), queuedAt: "2026-01-01" },
		GROUP,
		GROUP,
		writer,
	);
	const reader = new DbosDurableBackend(sdk, { executorId: "fifo-reader" });
	await reader.hydrateWorkflow(RUN_ID);
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [{ id: "stage-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(reader);
	const delivered: Array<{ id: string; name?: string; cwd: string; timestamp: number }> = [];
	const firstAttempt = createWorkflowPendingStageDelivery(reloadedStore, RUN_ID, "stage-id", "reviewer");
	await firstAttempt.deliverPending((entryFrom, entryMessage) => {
		delivered.push({
			id: entryMessage.id,
			name: entryFrom.name,
			cwd: entryFrom.cwd,
			timestamp: entryMessage.timestamp,
		});
	});
	await firstAttempt.ready();
	assert.deepEqual(
		delivered.map((entry) => entry.id),
		["deposit-a", "deposit-b"],
	);
	assert.equal(delivered[0]?.name, "planner");
	assert.equal(delivered[0]?.cwd, "/repo");
	assert.equal(delivered[0]?.timestamp, 200);

	const restartedAttempt = createWorkflowPendingStageDelivery(reloadedStore, RUN_ID, "stage-id", "reviewer");
	await restartedAttempt.deliverPending((entryFrom, entryMessage) => {
		delivered.push({
			id: entryMessage.id,
			name: entryFrom.name,
			cwd: entryFrom.cwd,
			timestamp: entryMessage.timestamp,
		});
	});
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		reader.getWorkflow(RUN_ID)?.pendingStageMessages?.map(({ status }) => status),
		["delivered", "delivered"],
	);
});

test("concurrent stage drains claim one queued message exactly once", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	await store.queueStageMessage(
		{
			runId: RUN_ID,
			stageKey: "reviewer",
			from: sender({} as net.Socket).info,
			message: message("concurrent-drain"),
			queuedAt: "2026-08-27T12:00:00.000Z",
		},
		GROUP,
		GROUP,
		backend,
	);
	const deliveryStarted = Promise.withResolvers<void>();
	const releaseDelivery = Promise.withResolvers<void>();
	let deliveries = 0;
	const first = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer").deliverPending(
		async () => {
			deliveries++;
			deliveryStarted.resolve();
			await releaseDelivery.promise;
		},
	);
	await deliveryStarted.promise;
	await createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer").deliverPending(async () => {
		deliveries++;
	});
	assert.equal(deliveries, 1);
	releaseDelivery.resolve();
	await first;
	assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "delivered");
});

test("rejected inbound delivery remains queued and retries after durable reload", async () => {
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "pending-delivery-writer" });
	writer.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	await store.queueStageMessage(
		{
			runId: RUN_ID,
			stageKey: "reviewer",
			from: sender({} as net.Socket).info,
			message: message("retry-after-rejection"),
			queuedAt: "2026-08-27T12:00:00.000Z",
		},
		GROUP,
		GROUP,
		writer,
	);

	const firstAttempt = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
	const ready = firstAttempt.ready();
	assert.ok(ready !== undefined);
	await assert.rejects(
		Promise.all([
			firstAttempt.deliverPending(async () => {
				throw new Error("inbound admission rejected");
			}),
			ready,
		]),
		/inbound admission rejected/,
	);

	const fresh = new DbosDurableBackend(sdk, { executorId: "pending-delivery-reader" });
	await fresh.hydrateWorkflow(RUN_ID);
	assert.equal(fresh.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "queued");
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
		pendingStageMessages: [...(fresh.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(fresh);
	let retries = 0;
	await createWorkflowPendingStageDelivery(reloadedStore, RUN_ID, "reviewer-id", "reviewer").deliverPending(
		async () => {
			retries++;
		},
	);
	assert.equal(retries, 1);
	assert.equal(fresh.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "delivered");
});

test("durable acknowledgement failure replays through the recipient idempotency key without duplicate visibility", async () => {
	const persistedSdk = createMockSdk();
	let failNextMetadataWrite = false;
	const sdk = {
		...persistedSdk,
		async recordStepOutput(...args: Parameters<typeof persistedSdk.recordStepOutput>) {
			if (failNextMetadataWrite) {
				failNextMetadataWrite = false;
				throw new Error("simulated durable delivery acknowledgement failure");
			}
			await persistedSdk.recordStepOutput(...args);
		},
	};
	const writer = new DbosDurableBackend(sdk, { executorId: "pending-delivery-ack-writer" });
	writer.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({ id: RUN_ID, name: "flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
	await store.queueStageMessage(
		{
			runId: RUN_ID,
			stageKey: "reviewer",
			from: sender({} as net.Socket).info,
			message: message("retry-after-ack-failure"),
			queuedAt: "2026-08-27T12:00:00.000Z",
		},
		GROUP,
		GROUP,
		writer,
	);

	let senderVisibleDeliveries = 0;
	const recipientSessionDir = mkdtempSync(join(tmpdir(), "pending-stage-recipient-"));
	tempDirs.push(recipientSessionDir);
	let recipientSession = SessionManager.create("/repo", recipientSessionDir);
	const firstRecipient = WorkflowStageAdmissionBoundary.restore(recipientSession.getBranch());
	const deliverThroughRecipient = (recipient: WorkflowStageAdmissionBoundary) => {
		const pending = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
		const ready = pending.ready();
		assert.ok(ready !== undefined);
		return Promise.all([
			pending.deliverPending(async (_from, entryMessage) => {
				await recipient.admit(
					`intercom:${entryMessage.id}`,
					() => {
						senderVisibleDeliveries++;
						recipientSession.appendCustomMessageEntry(
							"intercom_message",
							entryMessage.content.text,
							true,
							undefined,
							undefined,
							undefined,
							`intercom:${entryMessage.id}`,
						);
						recipientSession.flush();
					},
					() => {
						throw new Error("unexpected late route");
					},
				).completion;
			}),
			ready,
		]).then(() => undefined);
	};
	failNextMetadataWrite = true;
	await assert.rejects(deliverThroughRecipient(firstRecipient), /simulated durable delivery acknowledgement failure/);
	assert.equal(senderVisibleDeliveries, 1);

	const reader = new DbosDurableBackend(sdk, { executorId: "pending-delivery-ack-reader" });
	await reader.hydrateWorkflow(RUN_ID);
	assert.equal(reader.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "queued");
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	setDurableBackend(reader);
	assert.deepEqual(
		recipientSession.getBranch().map((entry) => ("stageAdmissionKey" in entry ? entry.stageAdmissionKey : undefined)),
		["intercom:retry-after-ack-failure"],
	);
	const recipientSessionFile = recipientSession.getSessionFile();
	assert.ok(recipientSessionFile !== undefined);
	recipientSession = SessionManager.open(recipientSessionFile, recipientSessionDir, "/repo");
	const reloadedRecipient = WorkflowStageAdmissionBoundary.restore(recipientSession.getBranch());
	assert.deepEqual(
		recipientSession.getBranch().map((entry) => ("stageAdmissionKey" in entry ? entry.stageAdmissionKey : undefined)),
		["intercom:retry-after-ack-failure"],
	);
	await createWorkflowPendingStageDelivery(reloadedStore, RUN_ID, "reviewer-id", "reviewer").deliverPending(
		async (_from, entryMessage) => {
			await reloadedRecipient.admit(
				`intercom:${entryMessage.id}`,
				() => {
					senderVisibleDeliveries++;
				},
				() => {
					throw new Error("unexpected late route");
				},
			).completion;
		},
	);
	assert.equal(senderVisibleDeliveries, 1);
	assert.equal(reader.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "delivered");
});
