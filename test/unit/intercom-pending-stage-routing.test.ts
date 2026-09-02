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
const CHILD_RUN_ID = "5bd82a35-c563-4f60-9a74-3546832210a8";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `workflow:${RUN_ID}/reviewer`;

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
	const route = (input: { readonly target: string }): boolean => {
		routed.push(input.target);
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

	handleBrokerSend(
		socket,
		{ type: "send", to: `${RUN_ID}:reviewer`, message: message("legacy") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
		undefined,
		undefined,
		() => TARGET,
	);
	assert.deepEqual(writes.at(-1), {
		type: "delivery_failed",
		messageId: "legacy",
		reason:
			"Legacy workflow-stage targets in the `<runId>:<stageKey>` form are no longer supported. Use the canonical `workflow:<rootRunId>/<segment>` path form. Use `workflow:4ac72924-c452-4e5f-9e63-2435722109f7/reviewer` for this stage.",
	});
	// Slice 3 (D3): pattern targets route to the pending-stage bridge like unresolved
	// exact targets; the broker no longer refuses them at parse time.
	handleBrokerSend(
		socket,
		{ type: "send", to: `workflow:${RUN_ID}/reviewer-*`, message: message("pattern") },
		"sender-id",
		sessions,
		new DeliveredMessageCache(),
		(_target, value) => writes.push(value),
		undefined,
		undefined,
		route,
	);
	assert.deepEqual(routed, [TARGET, `workflow:${RUN_ID}/reviewer-*`]);
	// No delivery failure is written for the pattern target; the route owns the answer.
	assert.equal(writes.length, 2);
	assert.equal(writes.at(-1)?.type, "delivery_failed");
	assert.equal((writes.at(-1) as { messageId?: string }).messageId, "legacy");
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
				target: string;
				message: Message;
			} = {
				handled: false,
				requestId: `request-${id}`,
				from: { ...sender({} as net.Socket).info, group },
				runId: RUN_ID,
				target: `workflow:${RUN_ID}/${stageKey}`,
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

	test("announces discoverable pending workflow stages with canonical targets", () => {
		const { emitted, dispose } = harness();
		const route = emitted.find(({ event }) => event === "atomic:workflow-pending-stage-route");
		// Regression: #2784
		assert.deepEqual(route?.payload.stages, [
			{
				stageId: "reviewer-id",
				stageName: "reviewer",
				target: `workflow:${RUN_ID}/reviewer-id`,
				lifecycle: "pending",
				routeEligible: true,
				group: `workflow:${RUN_ID}`,
			},
		]);
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
			reason: `Pending stage message queue is full (limit 50) for workflow:${RUN_ID}/reviewer-id`,
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
				reason: `Intercom message ID 'stable' was already queued for workflow:${RUN_ID}/reviewer-id with a different target, sender, or payload`,
			},
		);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
		assert.equal(backend.getWorkflow(RUN_ID)?.pendingStageMessages?.length, 1);
		dispose();
	});

	test("accepts an unknown stage key speculatively as a sticky entry (slice 3, D3/D4)", async () => {
		const { store, request, dispose } = harness();
		const { payload, result } = await request("1", GROUP, "unknown-stage");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, { outcome: "queued", position: 1, notInKnownSet: true });
		// Exact lookups stay empty: the entry is sticky and keyed by the verbatim target.
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
		const entry = store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.sticky, true);
		assert.equal(entry?.targetPath, `workflow:${RUN_ID}/unknown-stage`);
		dispose();
	});

	test("validates the stage before refusing an ask", async () => {
		const { store, request, dispose } = harness();
		const ask = { ...message("ask"), expectsReply: true };
		// A future-stage target refuses the ask through the sticky flow (slice 3).
		const unknown = await request("ask", GROUP, "unknown-stage", ask);
		assert.equal(unknown.payload.handled, true);
		assert.deepEqual(unknown.result, { outcome: "refused", reason: PENDING_STAGE_ASK_REFUSAL });
		assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
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
			target: string;
			message: Message;
		} = {
			handled: false,
			from: sender({} as net.Socket).info,
			runId: childRunId,
			target: `workflow:${RUN_ID}/${childRunId}/reviewer`,
			message: nestedMessage,
		};

		listeners.get("atomic:workflow-pending-stage-message")?.(payload);

		assert.equal(payload.handled, true);
		assert.deepEqual(await payload.completion, { outcome: "queued", position: 1 });
		const boundaryPayload: typeof payload = {
			handled: false,
			from: sender({} as net.Socket).info,
			runId: RUN_ID,
			target: `workflow:${RUN_ID}/workflow:child/reviewer`,
			message: nestedMessage,
		};
		listeners.get("atomic:workflow-pending-stage-message")?.(boundaryPayload);
		assert.equal(boundaryPayload.handled, true);
		assert.deepEqual(await boundaryPayload.completion, { outcome: "queued", position: 1 });
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
	test("round-trips the advertised depth-faithful grandchild target through the root durable owner", async () => {
		// Regression: review round 2, D8 clarification — the advertised target for a depth-2
		// stage carries one boundary segment per ancestor hop (boundary-stage name, else the
		// materialized child-run id). The advertised string must resolve, and the flat
		// run-id shortcut stays an accepted input.
		const childRunId = "331b6cd2-6f86-4a58-9b8f-0f4b39e0a111";
		const grandchildRunId = "44c2d7e3-7a97-4b69-ac9a-1a5c4af1b222";
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
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
					id: "grandchild-boundary",
					name: "workflow:grandchild",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:grandchild:1",
					workflowChildRun: { alias: "grandchild", workflow: "grandchild", runId: grandchildRunId },
				},
			],
			startedAt: 2,
		});
		store.recordRunStart({
			id: grandchildRunId,
			name: "grandchild",
			inputs: {},
			status: "running",
			parentRunId: childRunId,
			parentStageId: "grandchild-boundary",
			rootRunId: RUN_ID,
			stages: [
				{
					id: "grandchild-reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:reviewer:1",
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 3,
		});
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: RUN_ID, name: "root", inputs: {}, status: "running", createdAt: 1 });
		setDurableBackend(backend);
		const routeAnnouncements: Array<{ runId: string; stages: Array<{ stageId: string; target: string }> }> = [];
		const listeners = new Map<string, (payload: unknown) => void>();
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event: string, payload: Record<string, unknown>) {
						if (event === "atomic:workflow-pending-stage-route") {
							routeAnnouncements.push(
								payload as { runId: string; stages: Array<{ stageId: string; target: string }> },
							);
						}
					},
					on(event: string, listener: (payload: unknown) => void) {
						listeners.set(event, listener);
						return () => listeners.delete(event);
					},
				},
			},
			store,
		);
		const grandchildAnnouncement = routeAnnouncements.find((announcement) => announcement.runId === grandchildRunId);
		assert.ok(grandchildAnnouncement, "the grandchild run announces its route");
		const advertisedTarget = grandchildAnnouncement.stages.find(
			(stage) => stage.stageId === "grandchild-reviewer-id",
		)?.target;
		assert.equal(advertisedTarget, `workflow:${RUN_ID}/workflow:child/workflow:grandchild/grandchild-reviewer-id`);
		// The child run's only stage is its own boundary (not delivery-eligible), so its
		// announcement carries no stage rows; the grandchild's is the advertised one above.
		const deliver = async (target: string, runId: string, messageId: string, position: number): Promise<void> => {
			const payload: {
				handled: boolean;
				completion?: Promise<{ readonly outcome: "queued"; readonly position: number }>;
				from: SessionInfo;
				runId: string;
				target: string;
				message: Message;
			} = {
				handled: false,
				from: sender({} as net.Socket).info,
				runId,
				target,
				message: message(messageId, 200),
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			assert.equal(payload.handled, true, target);
			assert.deepEqual(await payload.completion, { outcome: "queued", position }, target);
		};
		// Round-trip: the exact advertised string resolves.
		await deliver(advertisedTarget!, RUN_ID, "gc-advertised", 1);
		// The flat run-id shortcut stays an accepted resolver input.
		await deliver(`workflow:${RUN_ID}/${grandchildRunId}/grandchild-reviewer-id`, grandchildRunId, "gc-flat", 2);
		// The fully-spelled form through every materialized run segment.
		await deliver(
			`workflow:${RUN_ID}/${childRunId}/${grandchildRunId}/grandchild-reviewer-id`,
			grandchildRunId,
			"gc-spelled",
			3,
		);
		assert.deepEqual(
			store.pendingStageMessagesFor(grandchildRunId, "grandchild-reviewer-id").map((entry) => entry.message.id),
			["gc-advertised", "gc-flat", "gc-spelled"],
		);
		dispose();
	});
	test("forwards live nested stages through the depth-faithful alias the broker registered", async () => {
		// Regression: review round 3 — the bridge answers a boundary-form send at a live
		// nested stage with outcome "forward" and a canonical target. That target must be
		// the depth-faithful id-form alias the broker registered from the roster; the flat
		// run-id shortcut is no longer a registered alias, so it resolves to nothing.
		const childRunId = "55e6f7a8-192a-4b3c-be4d-6f7a8b9c0d1e";
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
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
					id: "live-reviewer-id",
					name: "reviewer",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:reviewer:1",
					pendingStageDeliveryAvailable: true,
					sessionId: "live-reviewer-session",
				},
			],
			startedAt: 2,
		});
		const listeners = new Map<string, (payload: unknown) => void>();
		const routeAnnouncements: Array<{ runId: string; stages: Array<{ stageId: string; target: string }> }> = [];
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event: string, payload: Record<string, unknown>) {
						if (event === "atomic:workflow-pending-stage-route") {
							routeAnnouncements.push(
								payload as { runId: string; stages: Array<{ stageId: string; target: string }> },
							);
						}
					},
					on(event: string, listener: (payload: unknown) => void) {
						listeners.set(event, listener);
						return () => listeners.delete(event);
					},
				},
			},
			store,
		);
		const childAnnouncement = routeAnnouncements.find((announcement) => announcement.runId === childRunId);
		const advertisedTarget = childAnnouncement?.stages.find((stage) => stage.stageId === "live-reviewer-id")?.target;
		assert.equal(advertisedTarget, `workflow:${RUN_ID}/workflow:child/live-reviewer-id`);
		const payload: {
			handled: boolean;
			completion?: Promise<{ readonly outcome: "forward"; readonly target: string }>;
			from: SessionInfo;
			runId: string;
			target: string;
			message: Message;
		} = {
			handled: false,
			from: sender({} as net.Socket).info,
			runId: RUN_ID,
			target: `workflow:${RUN_ID}/workflow:child/reviewer`,
			message: message("live-boundary", 200),
		};
		listeners.get("atomic:workflow-pending-stage-message")?.(payload);
		assert.equal(payload.handled, true);
		assert.ok(payload.completion, "the live boundary-form send must settle");
		const completion = await payload.completion;
		assert.equal(completion.outcome, "forward");
		assert.equal(completion.target, advertisedTarget);
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

describe("possible future stage rows in the route announcement (D7)", () => {
	function rowHarness(
		options: {
			readonly possibleStages?: readonly string[];
			readonly extraStages?: readonly {
				readonly id: string;
				readonly name: string;
				readonly status?: "pending" | "running";
			}[];
			readonly childRun?: boolean;
		} = {},
	) {
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
				...(options.extraStages ?? []).map((stage) => ({
					id: stage.id,
					name: stage.name,
					status: stage.status ?? ("pending" as const),
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				})),
				...(options.childRun
					? [
							{
								id: "boundary-id",
								name: "child-boundary",
								status: "running" as const,
								parentIds: [],
								toolEvents: [],
								pendingStageDeliveryAvailable: true,
								replayKey: "workflow:child:1",
								workflowChildRun: { alias: "child", workflow: "child", runId: CHILD_RUN_ID },
							},
						]
					: []),
			],
			startedAt: 1,
			...(options.possibleStages === undefined ? {} : { possibleStages: options.possibleStages }),
		});
		if (options.childRun) {
			store.recordRunStart({
				id: CHILD_RUN_ID,
				name: "child",
				inputs: {},
				status: "running",
				parentRunId: RUN_ID,
				parentStageId: "boundary-id",
				rootRunId: RUN_ID,
				stages: [
					{
						id: "child-stage-id",
						name: "child-stage",
						status: "pending",
						parentIds: [],
						toolEvents: [],
						pendingStageDeliveryAvailable: true,
					},
				],
				startedAt: 2,
			});
		}
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
		const queueSticky = async (id: string, target: string) => {
			const payload: {
				handled: boolean;
				completion?: unknown;
			} & Record<string, unknown> = {
				handled: false,
				requestId: `request-${id}`,
				from: { ...sender({} as net.Socket).info, group: GROUP },
				runId: RUN_ID,
				target,
				message: message(id, 1_725_000_000_000 + Number(id.replace(/\D/g, "") || 0)),
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return payload.completion === undefined ? undefined : await payload.completion;
		};
		const routePayload = () => {
			const routes = emitted.filter(({ event }) => event === "atomic:workflow-pending-stage-route");
			return routes.at(-1)?.payload;
		};
		return { store, emitted, queueSticky, routePayload, dispose };
	}

	test("announces scan rows with canonical path targets, suppresses materialized literals, and appends the broadcast row", () => {
		const { routePayload, dispose } = rowHarness({
			possibleStages: ["setup", "orchestrator-*", "reviewer", "child-boundary/inner-stage"],
		});
		// "reviewer" is a glob-free entry whose stage is route-eligible materialized: it is
		// announced as a materialized roster row and must not be double-listed as future.
		assert.deepEqual(routePayload()?.possibleStages, [
			{ target: `workflow:${RUN_ID}/setup`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/orchestrator-*`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/child-boundary/inner-stage`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/**`, queuedCount: 0 },
		]);
		dispose();
	});

	test("pattern entries stay listed while a matching stage is materialized", () => {
		const { routePayload, dispose } = rowHarness({
			possibleStages: ["orchestrator-*"],
			extraStages: [{ id: "orch-1-id", name: "orchestrator-1", status: "running" }],
		});
		const rows = (routePayload()?.possibleStages ?? []) as { target: string; queuedCount: number }[];
		assert.deepEqual(
			rows.filter((row) => row.target.endsWith("/**")),
			[{ target: `workflow:${RUN_ID}/**`, queuedCount: 0 }],
		);
		assert.equal(
			rows.some((row) => row.target === `workflow:${RUN_ID}/orchestrator-*`),
			true,
		);
		dispose();
	});

	test("queued sticky messages raise the matching row counts and the broadcast count", async () => {
		const { routePayload, queueSticky, dispose } = rowHarness({
			possibleStages: ["orchestrator-*", "setup"],
		});
		assert.deepEqual(await queueSticky("s1", `workflow:${RUN_ID}/orchestrator-*`), {
			outcome: "queued",
			position: 1,
		});
		assert.deepEqual(await queueSticky("s2", `workflow:${RUN_ID}/orchestrator-3`), {
			outcome: "queued",
			position: 1,
		});
		assert.deepEqual(await queueSticky("s3", `workflow:${RUN_ID}/**`), {
			outcome: "queued",
			position: 1,
		});
		assert.deepEqual(routePayload()?.possibleStages, [
			{ target: `workflow:${RUN_ID}/orchestrator-*`, queuedCount: 2 },
			{ target: `workflow:${RUN_ID}/setup`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/**`, queuedCount: 1 },
		]);
		dispose();
	});

	test("rows disappear when the owning run reaches a terminal status", async () => {
		const { store, routePayload, dispose } = rowHarness({ possibleStages: ["setup"] });
		assert.equal(((routePayload()?.possibleStages ?? []) as unknown[]).length, 2);
		store.recordRunEnd(RUN_ID, "completed");
		assert.deepEqual(routePayload()?.possibleStages, []);
		dispose();
	});

	test("only the root run's announcement carries the possible-stage rows", () => {
		const { emitted, dispose } = rowHarness({ possibleStages: ["setup"], childRun: true });
		const rootRoute = emitted.find(({ payload }) => payload.runId === RUN_ID && payload.possibleStages !== undefined);
		const childRoute = emitted.find(({ payload }) => payload.runId === CHILD_RUN_ID);
		assert.ok(rootRoute);
		assert.ok(childRoute);
		assert.equal("possibleStages" in childRoute.payload, false);
		dispose();
	});
});
