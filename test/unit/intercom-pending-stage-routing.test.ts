import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager-core.ts";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	PENDING_STAGE_ASK_REFUSAL,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { claimExternalRunRoute } from "../../packages/workflows/src/shared/external-run-routes.js";
import { workflowPendingStageRouteReady } from "../../packages/workflows/src/shared/pending-stage-route-readiness.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const CHILD_RUN_ID = "5bd82a35-c563-4f60-9a74-3546832210a8";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `workflow:${RUN_ID}/reviewer`;
const EXPENSIVE_ROUTE_ANNOUNCEMENT_MS = 10;
/** Bound on waiting for a batched route announcement; one that lands returns at once. */
const ROUTE_PUBLICATION_DEADLINE_MS = 10_000;

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

test("pending-stage fallback runs only for a valid composite unknown target and preserves ordinary unknown failures", async () => {
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
		(_target, value) => {
			writes.push(value);
			return true;
		},
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
		(_target, value) => {
			writes.push(value);
			return true;
		},
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
		(_target, value) => {
			writes.push(value);
			return true;
		},
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
		(_target, value) => {
			writes.push(value);
			return true;
		},
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

test("live workflow stage targets still deliver immediately before pending-stage fallback", async () => {
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
		(socket, value) => {
			writes.push({ socket, message: value });
			return true;
		},
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

test("pending-stage ask refusal recommends nonblocking send", async () => {
	assert.equal(PENDING_STAGE_ASK_REFUSAL.includes("Use send"), true);
});

describe("workflows-owned pending-stage delivery event bridge", () => {
	async function harness(onRoute?: (payload: Record<string, unknown>) => void) {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			toolNodes: [],
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
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
		const listeners = new Map<string, (payload: unknown) => void>();
		const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
		const pi = {
			events: {
				emit(event: string, payload: Record<string, unknown>) {
					emitted.push({ event, payload });
					// A route consumer claims the announcement synchronously by assigning
					// `completion`; every other event keeps today's plain fan-out.
					if (event === "atomic:workflow-pending-stage-route") onRoute?.(payload);
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
			live?: true,
		) => {
			const payload: {
				handled: boolean;
				live?: true;
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
				...(live === undefined ? {} : { live }),
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return { payload, result: payload.completion === undefined ? undefined : await payload.completion };
		};
		return { store, backend, emitted, pi, request, dispose };
	}

	test("announces ownership and enforces group isolation without requesting", async () => {
		const { store, emitted, request, dispose } = await harness();
		assert.equal(
			emitted.some(({ event }) => event === "atomic:workflow-pending-stage-route"),
			true,
		);
		const { payload, result } = await request("1", "other-group");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, {
			outcome: "refused",
			reason: `Target workflow run is in a different intercom group; join workflow:${RUN_ID} to send to its stages`,
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 0);
		dispose();
	});

	test("a send to a live stage on another worker host is queued for its input queue, and an ask to it is refused (#4391)", async () => {
		const { store, request, dispose } = await harness();
		const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		store.recordRunStart({
			...run,
			stages: [
				{ ...run.stages[0]!, status: "running", sessionId: "remote-session", pendingStageDeliveryAvailable: true },
			],
		});
		const asked: string[] = [];
		let elsewhere = true;
		const release = claimExternalRunRoute(store, RUN_ID, {
			notifyUndeliverable: async () => true,
			deliversQueued: (runId, stageId) => {
				asked.push(`${runId}/${stageId}`);
				return elsewhere;
			},
		});
		try {
			const queued = await request("1");
			assert.deepEqual([queued.payload.handled, queued.result], [true, { outcome: "queued", position: 1 }]);
			assert.deepEqual(
				store.pendingStageMessagesFor(RUN_ID, "reviewer").map((entry) => entry.message.id),
				["1"],
				"the send waits in the stage's queue for its owner to deliver it",
			);
			const ask = await request("2", GROUP, "reviewer", { ...message("2"), expectsReply: true });
			assert.deepEqual(ask.result, {
				outcome: "refused",
				reason:
					"Cannot ask a workflow stage that runs on another worker host: its replies cannot reach you. Use send; Atomic delivers the message through the stage's input queue.",
			});
			assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1, "a refused ask is not queued");
			assert.deepEqual(asked, [`${RUN_ID}/reviewer-id`, `${RUN_ID}/reviewer-id`]);
			// A send that asks for live delivery only is never queued for the stage's input queue.
			const liveOnly = await request("5", GROUP, "reviewer", message("5"), true);
			assert.equal(liveOnly.result?.outcome, "forward");
			assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
			assert.equal(asked.length, 2, "its owner is not asked");
			// A stage on the root's own host is forwarded live, as before.
			elsewhere = false;
			const live = await request("3");
			assert.equal(live.result?.outcome, "forward");
			assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
			// A finished stage is never asked: its send falls through to the queue for the next matching stage.
			const finished = store.runs().find((candidate) => candidate.id === RUN_ID)!;
			store.recordRunStart({ ...finished, stages: [{ ...finished.stages[0]!, status: "completed" }] });
			asked.length = 0;
			elsewhere = true;
			await request("4");
			assert.deepEqual(asked, [], "only a live stage's owner is asked");
		} finally {
			release();
			dispose();
		}
	});

	test("a send to a live stage on another worker host whose session has no Intercom is refused before anything is queued (#4391)", async () => {
		const { store, request, dispose } = await harness();
		const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		const release = claimExternalRunRoute(store, RUN_ID, {
			notifyUndeliverable: async () => true,
			deliversQueued: () => true,
		});
		try {
			for (const pendingStageDeliveryAvailable of [false, undefined]) {
				store.recordRunStart({
					...run,
					stages: [
						{ ...run.stages[0]!, status: "running", sessionId: "remote-session", pendingStageDeliveryAvailable },
					],
				});
				assert.deepEqual((await request("1")).result, {
					outcome: "refused",
					reason: `Workflow stage workflow:${RUN_ID}/reviewer runs on another worker host without Intercom access, so it cannot receive Intercom messages`,
				});
			}
			const ask = await request("2", GROUP, "reviewer", { ...message("2"), expectsReply: true });
			assert.match(
				ask.result?.outcome === "refused" ? ask.result.reason : "",
				/^Cannot ask a workflow stage that runs on another worker host/,
			);
			assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "reviewer"), [], "nothing was queued");
			assert.deepEqual(store.run(RUN_ID)?.pendingStageMessages ?? [], []);
		} finally {
			release();
			dispose();
		}
	});

	test("a direct send to a paused stage reaches the stage its replacement worker re-materializes, exactly once (#3869)", async () => {
		const { store, request, dispose } = await harness();
		const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		const paused = { ...run.stages[0]!, status: "paused" as const, replayKey: "flow:reviewer" };
		store.recordRunStart({ ...run, stages: [paused] });
		assert.deepEqual((await request("1", GROUP, "reviewer-id")).result, { outcome: "queued", position: 1 });
		const queued = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		store.recordRunStart({
			...queued,
			stages: [{ ...paused, id: "reviewer-replacement-id", status: "running" }],
		});
		const delivered: string[] = [];
		const delivery = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-replacement-id", "reviewer");
		const recipient = { sessionId: "replacement-session", receivedMessageIds: [] };
		await delivery.deliverPending((_from, received) => {
			delivered.push(received.id);
		}, recipient);
		await delivery.deliverPending((_from, received) => {
			delivered.push(received.id);
		}, recipient);
		assert.deepEqual(delivered, ["1"]);
		dispose();
	});

	test("a send to a waiting stage queues for it, even though the stage has a session to reopen, and the roster lists it (#4309)", async () => {
		const { store, emitted, request, dispose } = await harness();
		const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		store.recordRunStart({
			...run,
			stages: [
				{
					...run.stages[0]!,
					status: "suspended",
					sessionId: "released-session",
					wait: { kind: "tool", since: 1, toolCalls: [{ toolCallId: "call-1", toolName: "wait_for_ci" }] },
				},
			],
		});
		dispose.refresh();

		const { payload, result } = await request("1", GROUP, "reviewer-id");

		assert.equal(payload.handled, true);
		assert.deepEqual(result, { outcome: "queued", position: 1 });
		assert.deepEqual(
			store.pendingStageMessagesFor(RUN_ID, "reviewer-id").map((entry) => entry.message.id),
			["1"],
		);
		const roster = emitted.findLast(({ event }) => event === "atomic:workflow-pending-stage-route");
		const stages = roster?.payload.stages as readonly {
			readonly lifecycle: string;
			readonly routeEligible: boolean;
		}[];
		assert.deepEqual(
			stages.map(({ lifecycle, routeEligible }) => ({ lifecycle, routeEligible })),
			[{ lifecycle: "pending", routeEligible: true }],
		);
		dispose();
	});

	test("a session-less stage the route roster advertises as reachable is exactly the one a direct send queues for", async () => {
		const statuses: Record<StageStatus, true> = {
			pending: true,
			running: true,
			awaiting_input: true,
			paused: true,
			blocked: true,
			suspended: true,
			completed: true,
			failed: true,
			skipped: true,
		};
		for (const status of Object.keys(statuses) as StageStatus[]) {
			const { store, emitted, request, dispose } = await harness();
			const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
			store.recordRunStart({ ...run, stages: [{ ...run.stages[0]!, status }] });
			dispose.refresh();
			const roster = emitted.findLast(({ event }) => event === "atomic:workflow-pending-stage-route");
			assert.ok(roster, "the bridge announces the run's route roster");
			const advertised = (roster.payload.stages as { readonly routeEligible: boolean }[])[0]!.routeEligible;
			await request("1", GROUP, "reviewer-id");
			const queuedForStage = store.pendingStageMessagesFor(RUN_ID, "reviewer-id").length === 1;
			assert.equal(queuedForStage, advertised, `stage status ${status}`);
			dispose();
		}
	});

	test("announces discoverable pending workflow stages with canonical targets", async () => {
		const { emitted, dispose } = await harness();
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
		const { store, backend, request, dispose } = await harness();
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
		const { store, backend, request, dispose } = await harness();
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
		const { store, request, dispose } = await harness();
		const { payload, result } = await request("1", GROUP, "unknown-stage");
		assert.equal(payload.handled, true);
		assert.deepEqual(result, { outcome: "queued", position: 1, prediction: "unknown" });
		// Exact lookups stay empty: the entry is sticky and keyed by the verbatim target.
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
		const entry = store.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(entry?.sticky, true);
		assert.equal(entry?.targetPath, `workflow:${RUN_ID}/unknown-stage`);
		dispose();
	});

	test("validates the stage before refusing an ask", async () => {
		const { store, request, dispose } = await harness();
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
			toolNodes: [],
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
			toolNodes: [],
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
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
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
			toolNodes: [],
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
			toolNodes: [],
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
			toolNodes: [],
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
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "root",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
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
			toolNodes: [],
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
			toolNodes: [],
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

	// Route publication deduplication: every store invalidation used to republish every
	// run, so tool events, attachment toggles, and notices each cost a broker round trip
	// whose `listSessions()` barrier can expire on its own 5s timer.
	const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
	/**
	 * Waits until the batched announcements have published `count` routes. A batch has no fixed length: once
	 * announcing is expensive the bridge holds the next one until four times the typical wall time of recent
	 * announcements has passed, for at most 250 ms, so on a loaded runner a route change can land after more than one
	 * 25 ms window.
	 */
	const routesPublished = async (routes: { readonly length: number }, count: number): Promise<void> =>
		await vi.waitFor(() => assert.ok(routes.length >= count, `${routes.length} of ${count} routes published`), {
			timeout: ROUTE_PUBLICATION_DEADLINE_MS,
			interval: 5,
		});
	/**
	 * The idle point for "not republished": a stage asking for route readiness makes the bridge announce its pending
	 * batch now, so every store change so far has been announced or deduplicated when this returns.
	 */
	const announcePendingRoutes = (store: Store): void => {
		// Only the announcement matters; disposing the bridge later releases this readiness wait.
		void workflowPendingStageRouteReady(store, RUN_ID)?.completion.catch(() => {});
	};
	/** Observable route payload, without the acknowledgement the consumer attaches. */
	const routeData = (payload: Record<string, unknown>): Record<string, unknown> =>
		Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "completion"));
	const pendingReviewerStages = [
		{
			stageId: "reviewer-id",
			stageName: "reviewer",
			target: `workflow:${RUN_ID}/reviewer-id`,
			lifecycle: "pending",
			routeEligible: true,
			group: GROUP,
		},
	];
	const runningReviewerStages = pendingReviewerStages.map((stage) => ({ ...stage, lifecycle: "running" }));
	const toggleAttachment = (store: Store, count: number): void => {
		for (let index = 0; index < count; index += 1) {
			store.recordStageAttached(RUN_ID, "reviewer-id", index % 2 === 0);
		}
	};
	const claimingHarness = async (routes: Record<string, unknown>[], claims: PromiseWithResolvers<void>[]) =>
		await harness((payload) => {
			routes.push(payload);
			const claim = Promise.withResolvers<void>();
			claims.push(claim);
			payload.completion = claim.promise;
		});

	// Regression for #2990.
	test("an unchanged route is republished neither while its acknowledgement is pending nor after it resolves", async () => {
		const routes: Record<string, unknown>[] = [];
		const claims: PromiseWithResolvers<void>[] = [];
		const { store, dispose } = await claimingHarness(routes, claims);
		assert.equal(routes.length, 1);
		assert.deepEqual(routes[0]?.stages, pendingReviewerStages);
		// 1,000 attachment toggles leave the route projection identical. Before the fix
		// this measured 1,001 announcements — one broker directory request each.
		toggleAttachment(store, 1000);
		announcePendingRoutes(store);
		assert.equal(routes.length, 1);
		assert.deepEqual(routes[0]?.stages, pendingReviewerStages);
		claims[0]?.resolve();
		await turn();
		toggleAttachment(store, 1000);
		announcePendingRoutes(store);
		assert.equal(routes.length, 1);
		// A genuine routing change is never debounced behind the acknowledged claim.
		store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "reviewer-session" });
		await routesPublished(routes, 2);
		assert.equal(routes.length, 2);
		assert.deepEqual(routes[1]?.stages, runningReviewerStages);
		dispose();
	});

	// Regression for #2990.
	test("a rejected route publication is retried on the next unchanged invalidation", async () => {
		const routes: Record<string, unknown>[] = [];
		const claims: PromiseWithResolvers<void>[] = [];
		const { store, dispose } = await claimingHarness(routes, claims);
		assert.equal(routes.length, 1);
		claims[0]?.reject(new Error("relay failed"));
		await turn();
		toggleAttachment(store, 1);
		await routesPublished(routes, 2);
		assert.equal(routes.length, 2);
		assert.deepEqual(routeData(routes[1]!), routeData(routes[0]!));
		// The retry is claimed, so the unchanged route stops republishing again.
		toggleAttachment(store, 2);
		announcePendingRoutes(store);
		assert.equal(routes.length, 2);
		dispose();
	});

	// Regression for #2990.
	test("a stale rejection cannot evict the claim of a route republished after A -> B -> A", async () => {
		const routes: Record<string, unknown>[] = [];
		const claims: PromiseWithResolvers<void>[] = [];
		const { store, dispose } = await claimingHarness(routes, claims);
		const initialRun = structuredClone(store.runs()[0]!);
		assert.equal(routes.length, 1);
		assert.deepEqual(routes[0]?.stages, pendingReviewerStages);
		// B publishes in the next batch even though A is still unacknowledged.
		store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "reviewer-session" });
		await routesPublished(routes, 2);
		assert.equal(routes.length, 2);
		assert.deepEqual(routes[1]?.stages, runningReviewerStages);
		// A again, from the pre-session snapshot of the same run.
		store.removeRun(RUN_ID);
		store.recordRunStart(initialRun);
		await routesPublished(routes, 3);
		assert.equal(routes.length, 3);
		assert.deepEqual(routeData(routes[2]!), routeData(routes[0]!));
		claims[0]?.reject(new Error("relay failed"));
		await turn();
		toggleAttachment(store, 1);
		announcePendingRoutes(store);
		assert.equal(routes.length, 3);
		dispose();
	});

	// Regression for #2990.
	test("an unclaimed announcement republishes until a consumer acknowledges it", async () => {
		const routes: Record<string, unknown>[] = [];
		let acknowledging = false;
		const { store, dispose } = await harness((payload) => {
			routes.push(payload);
			if (acknowledging) payload.completion = Promise.resolve();
		});
		assert.equal(routes.length, 1);
		// Nobody claimed the initial emission, so it is not proof of publication.
		acknowledging = true;
		toggleAttachment(store, 1);
		await routesPublished(routes, 2);
		assert.equal(routes.length, 2);
		assert.deepEqual(routeData(routes[1]!), routeData(routes[0]!));
		assert.deepEqual(routes[1]?.stages, pendingReviewerStages);
		toggleAttachment(store, 2);
		announcePendingRoutes(store);
		assert.equal(routes.length, 2);
		dispose();
	});

	// Regression for #2990.
	test("a replacement bridge republishes once and survives the disposed bridge's late rejection", async () => {
		const routes: Record<string, unknown>[] = [];
		const claims: PromiseWithResolvers<void>[] = [];
		const { store, pi, dispose } = await claimingHarness(routes, claims);
		assert.equal(routes.length, 1);
		dispose();
		const replacement = registerPendingStageIntercomBridge(pi, store);
		assert.equal(routes.length, 2);
		assert.deepEqual(routeData(routes[1]!), routeData(routes[0]!));
		// The disposed bridge's claim was still outstanding; its rejection belongs to a
		// cache that no longer exists and must not invalidate the replacement's claim.
		claims[0]?.reject(new Error("relay failed"));
		await turn();
		toggleAttachment(store, 1);
		announcePendingRoutes(store);
		assert.equal(routes.length, 2);
		replacement();
	});

	const expensiveRouteHarness = async (routes: Record<string, unknown>[]) => {
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		return await harness((payload) => {
			routes.push(payload);
			now += EXPENSIVE_ROUTE_ANNOUNCEMENT_MS;
		});
	};

	test("once announcing is expensive, a route change waits its turn and still publishes on its own", async () => {
		const routes: Record<string, unknown>[] = [];
		const { store, dispose } = await expensiveRouteHarness(routes);
		try {
			assert.equal(routes.length, 1);
			store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "reviewer-session" });
			assert.equal(routes.length, 1, "the change must not re-announce every run synchronously");
			await routesPublished(routes, 2);
			assert.equal(routes.length, 2);
			assert.deepEqual(routes[1]?.stages, runningReviewerStages);
		} finally {
			dispose();
			vi.restoreAllMocks();
		}
	});

	/** The bridge batches the route changes of a window into one announcement; Intercom documents it as about 25 ms. */
	const ROUTE_BATCH_WINDOW_MS = 25;
	/** The longest a throttled bridge holds a route change back, however slow its announcements were. */
	const ROUTE_HOLD_CAP_MS = 250;
	const addPendingStage = (store: Store, name: string): void => {
		const run = store.runs().find((candidate) => candidate.id === RUN_ID)!;
		const added = { id: name, name, status: "pending" as const, parentIds: [], toolEvents: [] };
		store.recordRunStart({ ...run, stages: [...run.stages, { ...added, pendingStageDeliveryAvailable: true }] });
	};
	const stageNames = (route: Record<string, unknown> | undefined): string[] =>
		((route?.stages ?? []) as { stageName: string }[]).map((stage) => stage.stageName);
	/**
	 * A host whose clock moves only as the test moves it, so a throttled wait is measured exactly rather than raced.
	 * Each route announcement takes `announcementMs()` of that clock, as a synchronous announcement takes its own wall
	 * time, and `elapse` lets the batch timer fire as the clock reaches it.
	 */
	const timedRouteHarness = async (routes: Record<string, unknown>[], announcementMs: () => number) => {
		let now = 1_000;
		const startedAt = now;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const host = await harness((payload) => {
			routes.push(payload);
			now += announcementMs();
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const elapse = (ms: number): void => {
			for (let step = 0; step < ms; step += 1) {
				now += 1;
				vi.advanceTimersByTime(1);
			}
		};
		const release = (): void => {
			host.dispose();
			vi.useRealTimers();
			vi.restoreAllMocks();
		};
		return { ...host, elapse, release, elapsedMs: () => now - startedAt };
	};

	test("one slow announcement does not stretch the wait for the next route change (#4264)", async () => {
		const routes: Record<string, unknown>[] = [];
		// The announcements cost 1 ms, except the second, which a GC pause or a preempted thread stretches to 200 ms.
		const costs = [1, 200];
		const { store, elapse, release } = await timedRouteHarness(routes, () => costs.shift() ?? 1);
		try {
			addPendingStage(store, "first");
			elapse(ROUTE_BATCH_WINDOW_MS);
			assert.equal(routes.length, 2, "the first change publishes in its own batch window");
			// Four times the 200 ms outlier would hold this change back for 800 ms.
			addPendingStage(store, "second");
			elapse(ROUTE_BATCH_WINDOW_MS);
			assert.equal(routes.length, 3, "the change after the slow announcement still publishes in one batch window");
			assert.ok(stageNames(routes[2]).includes("second"), "the published route carries the change");
		} finally {
			release();
		}
	});

	test("a route change waits at most the cap, however slow the announcements before it were (#4264)", async () => {
		const routes: Record<string, unknown>[] = [];
		// Every announcement takes 200 ms, so no estimate of the typical cost can make the next change look cheap.
		const { store, elapse, release } = await timedRouteHarness(routes, () => 200);
		try {
			for (const name of ["a", "b", "c", "d"]) {
				addPendingStage(store, name);
				elapse(ROUTE_HOLD_CAP_MS);
				assert.ok(stageNames(routes.at(-1)).includes(name), `change ${name} publishes within the cap`);
			}
			assert.equal(routes.length, 5);
			// Slow announcements keep the throttle on: the next change does not publish in its first batch window...
			addPendingStage(store, "e");
			elapse(ROUTE_BATCH_WINDOW_MS);
			assert.equal(routes.length, 5, "a bridge whose announcements are slow still spaces them out");
			// ...but it is held for the cap, not for four times the 200 ms an announcement takes.
			elapse(ROUTE_HOLD_CAP_MS - ROUTE_BATCH_WINDOW_MS);
			assert.equal(routes.length, 6, "change e publishes within the cap");
			assert.ok(stageNames(routes[5]).includes("e"), "the published route carries the change");
		} finally {
			release();
		}
	});

	// Guards what the throttle is for, against the cap and the smoothed estimate that bound it.
	test("repeated expensive announcements keep announcing under about a fifth of the event loop (#4264)", async () => {
		const routes: Record<string, unknown>[] = [];
		const EXPENSIVE_MS = 40;
		const { store, elapse, release, elapsedMs } = await timedRouteHarness(routes, () => EXPENSIVE_MS);
		try {
			// A change every 5 ms for three seconds, each one a different route.
			for (let change = 0; change < 600; change += 1) {
				addPendingStage(store, `stage-${change}`);
				elapse(5);
			}
			const announcements = routes.length - 1;
			const share = (announcements * EXPENSIVE_MS) / elapsedMs();
			assert.ok(share <= 0.25, `announcing took ${(share * 100).toFixed(0)}% of the event loop`);
			assert.ok(announcements >= 10, `only ${announcements} announcements in three seconds of changes`);
		} finally {
			release();
		}
	});

	test("a stage asking for route readiness publishes a pending route change first", async () => {
		const routes: Record<string, unknown>[] = [];
		const { store, dispose } = await expensiveRouteHarness(routes);
		try {
			store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "reviewer-session" });
			assert.equal(routes.length, 1);
			workflowPendingStageRouteReady(store, RUN_ID);
			assert.equal(routes.length, 2);
			assert.deepEqual(routes[1]?.stages, runningReviewerStages);
		} finally {
			dispose();
			vi.restoreAllMocks();
		}
	});

	test("a batched announcement after its session closed stops the bridge instead of throwing from a timer", async () => {
		const routes: Record<string, unknown>[] = [];
		let closed = false;
		let closedAnnouncements = 0;
		const { store, dispose } = await harness((payload) => {
			if (closed) {
				closedAnnouncements += 1;
				throw Object.assign(new Error("SessionClosed"), { code: "SessionClosed" });
			}
			routes.push(payload);
		});
		const uncaught: unknown[] = [];
		const recordUncaught = (error: unknown) => uncaught.push(error);
		process.prependListener("uncaughtException", recordUncaught);
		try {
			closed = true;
			store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "reviewer-session" });
			// The batch's timer meets the closed session; an escaped error is recorded synchronously as it throws.
			await vi.waitFor(() => assert.equal(closedAnnouncements, 1), {
				timeout: ROUTE_PUBLICATION_DEADLINE_MS,
				interval: 5,
			});
			assert.deepEqual(uncaught, []);
			closed = false;
			store.recordStageSession(RUN_ID, "reviewer-id", { sessionId: "another-session" });
			announcePendingRoutes(store);
			assert.equal(routes.length, 1, "a bridge whose session closed publishes nothing further");
		} finally {
			process.removeListener("uncaughtException", recordUncaught);
			dispose();
		}
	});
});

test("reloads and drains aliases by durable deposit order rather than sender timestamp exactly once", async () => {
	const writer = await JournalTestBackend.create();
	await writer.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [{ id: "stage-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
	});
	bindStoreDurableBackend(store, writer);
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
	const reader = await writer.reopen();
	await reader.hydrateWorkflow(RUN_ID);
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [{ id: "stage-id", name: "reviewer", status: "pending", parentIds: [], toolEvents: [] }],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	bindStoreDurableBackend(reloadedStore, reader);
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
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	bindStoreDurableBackend(store, backend);
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
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
	const writer = await JournalTestBackend.create();
	await writer.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
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

	const fresh = await writer.reopen();
	await fresh.hydrateWorkflow(RUN_ID);
	assert.equal(fresh.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "queued");
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		pendingStageMessages: [...(fresh.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	bindStoreDurableBackend(reloadedStore, fresh);
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
	let failNextMetadataWrite = false;
	const writer = await JournalTestBackend.create();
	const persist = writer.persistPendingStageMessages.bind(writer);
	writer.persistPendingStageMessages = async (...args) => {
		if (failNextMetadataWrite) {
			failNextMetadataWrite = false;
			throw new StorageUnavailableError(
				{ adapter: "node-sqlite", location: writer.databasePath },
				new Error("delivery acknowledgement failed"),
			);
		}
		return persist(...args);
	};
	await writer.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
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
	let recipientSession = await SessionManager.create("/repo", recipientSessionDir);
	const firstRecipient = WorkflowStageAdmissionBoundary.restore(recipientSession.getBranch());
	const deliverThroughRecipient = (recipient: WorkflowStageAdmissionBoundary) => {
		const pending = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
		const ready = pending.ready();
		assert.ok(ready !== undefined);
		return Promise.all([
			pending.deliverPending(async (_from, entryMessage) => {
				await recipient.admit(
					`intercom:${entryMessage.id}`,
					async () => {
						senderVisibleDeliveries++;
						await recipientSession.appendCustomMessageEntry(
							"intercom_message",
							entryMessage.content.text,
							true,
							undefined,
							undefined,
							undefined,
							`intercom:${entryMessage.id}`,
						);
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
	await assert.rejects(deliverThroughRecipient(firstRecipient), StorageUnavailableError);
	assert.equal(senderVisibleDeliveries, 1);

	const reader = await writer.reopen();
	await reader.hydrateWorkflow(RUN_ID);
	assert.equal(reader.getWorkflow(RUN_ID)?.pendingStageMessages?.[0]?.status, "queued");
	const reloadedStore = createStore();
	reloadedStore.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		pendingStageMessages: [...(reader.getWorkflow(RUN_ID)?.pendingStageMessages ?? [])],
	});
	bindStoreDurableBackend(reloadedStore, reader);
	assert.deepEqual(
		recipientSession.getBranch().map((entry) => ("stageAdmissionKey" in entry ? entry.stageAdmissionKey : undefined)),
		["intercom:retry-after-ack-failure"],
	);
	const recipientSessionFile = recipientSession.getSessionFile();
	assert.ok(recipientSessionFile !== undefined);
	recipientSession = await SessionManager.open(recipientSessionFile, recipientSessionDir, "/repo");
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
	async function rowHarness(
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
			toolNodes: [],
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
				toolNodes: [],
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
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
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
		const routePayload = async () => {
			// The bridge's flush announces the pending batch and waits for its sweep, rather than outwaiting its timer.
			await dispose.flush();
			const routes = emitted.filter(({ event }) => event === "atomic:workflow-pending-stage-route");
			return routes.at(-1)?.payload;
		};
		return { store, emitted, queueSticky, routePayload, dispose };
	}

	test("announces scan rows with canonical path targets, suppresses materialized literals, and appends the broadcast row", async () => {
		const { routePayload, dispose } = await rowHarness({
			possibleStages: ["setup", "orchestrator-*", "reviewer", "child-boundary/inner-stage"],
		});
		// "reviewer" is a glob-free entry whose stage is route-eligible materialized: it is
		// announced as a materialized roster row and must not be double-listed as future.
		assert.deepEqual((await routePayload())?.possibleStages, [
			{ target: `workflow:${RUN_ID}/setup`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/orchestrator-*`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/child-boundary/inner-stage`, queuedCount: 0 },
			{ target: `workflow:${RUN_ID}/**`, queuedCount: 0 },
		]);
		dispose();
	});

	test("pattern entries stay listed while a matching stage is materialized", async () => {
		const { routePayload, dispose } = await rowHarness({
			possibleStages: ["orchestrator-*"],
			extraStages: [{ id: "orch-1-id", name: "orchestrator-1", status: "running" }],
		});
		const rows = ((await routePayload())?.possibleStages ?? []) as { target: string; queuedCount: number }[];
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

	test("queued sticky messages expose row counts and per-stage delivery state (#3406)", async () => {
		const { routePayload, queueSticky, dispose } = await rowHarness({
			possibleStages: ["orchestrator-*", "setup"],
		});
		assert.deepEqual(await queueSticky("s1", `workflow:${RUN_ID}/orchestrator-*`), {
			outcome: "queued",
			position: 1,
			prediction: "known",
		});
		assert.deepEqual(await queueSticky("s2", `workflow:${RUN_ID}/orchestrator-3`), {
			outcome: "queued",
			position: 1,
			prediction: "known",
		});
		assert.deepEqual(await queueSticky("s3", `workflow:${RUN_ID}/**`), {
			outcome: "queued",
			position: 1,
			prediction: "known",
		});
		assert.deepEqual((await routePayload())?.possibleStages, [
			{ target: `workflow:${RUN_ID}/orchestrator-*`, queuedCount: 2 },
			{ target: `workflow:${RUN_ID}/setup`, queuedCount: 0 },
			{
				target: `workflow:${RUN_ID}/**`,
				queuedCount: 1,
				deliveryStates: [
					{
						messageId: "s3",
						runId: RUN_ID,
						stageId: "reviewer-id",
						state: "queued",
						reason: "No delivery receipt; stage startup must drain before its first turn",
					},
				],
				deliveryStateCounts: { queued: 1 },
			},
		]);
		dispose();
	});

	test("listing retains sticky delivery states outside the scan and after exact materialization (#3406)", async () => {
		const { requireStoreDurableBackend } = await import("../../packages/workflows/src/durable/store-backend.js");
		const { store, queueSticky, routePayload, dispose } = await rowHarness({ possibleStages: ["later"] });
		try {
			await queueSticky("outside-3406", `workflow:${RUN_ID}/dynamic-*`);
			await queueSticky("exact-3406", `workflow:${RUN_ID}/later`);
			for (const name of ["dynamic-worker", "later"]) {
				store.recordStageStart(RUN_ID, {
					id: `${name}-id`,
					name,
					status: "running",
					sessionId: `${name}-session`,
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				});
			}
			const rows = (await routePayload())?.possibleStages as {
				target: string;
				deliveryOnly?: true;
				deliveryStates?: { messageId: string; state: string }[];
			}[];
			assert.deepEqual(
				["dynamic-*", "later"].map((target) => {
					const row = rows.find((candidate) => candidate.target === `workflow:${RUN_ID}/${target}`);
					return {
						target,
						deliveryOnly: row?.deliveryOnly,
						states: row?.deliveryStates?.map(({ messageId, state }) => ({ messageId, state })),
					};
				}),
				[
					{ target: "dynamic-*", deliveryOnly: true, states: [{ messageId: "outside-3406", state: "queued" }] },
					{ target: "later", deliveryOnly: true, states: [{ messageId: "exact-3406", state: "queued" }] },
				],
			);
			for (const [messageId, stageName] of [
				["outside-3406", "dynamic-worker"],
				["exact-3406", "later"],
			] as const) {
				await store.recordPendingStageMessageDeliveries(
					RUN_ID,
					messageId,
					[
						{
							runId: RUN_ID,
							stageId: `${stageName}-id`,
							sessionId: `${stageName}-session`,
							admission: "context",
						},
					],
					"2026-10-03T00:00:00Z",
					requireStoreDurableBackend(store),
				);
			}
			const deliveredRows = (await routePayload())?.possibleStages as {
				deliveryOnly?: true;
				queuedCount: number;
				deliveryStates?: { state: string }[];
			}[];
			assert.deepEqual(
				deliveredRows
					.filter((row) => row.deliveryOnly)
					.map((row) => ({
						queuedCount: row.queuedCount,
						states: row.deliveryStates?.map(({ state }) => state),
					})),
				[
					{ queuedCount: 1, states: ["delivered"] },
					{ queuedCount: 1, states: ["delivered"] },
				],
			);
			assert.ok(
				store.runs()[0]!.pendingStageMessages?.every((entry) => entry.status === "queued" && entry.sticky === true),
			);
		} finally {
			dispose();
		}
	});

	test("terminal sticky stages give terminal guidance unless context receipt is confirmed (#3406)", async () => {
		const { requireStoreDurableBackend } = await import("../../packages/workflows/src/durable/store-backend.js");
		const { inspectRun } = await import("../../packages/workflows/src/runs/background/run-inspect.js");
		const { stickyStageDeliveryStatuses } = await import(
			"../../packages/workflows/src/shared/sticky-stage-delivery-status.js"
		);
		const { store, queueSticky, dispose } = await rowHarness({});
		try {
			await queueSticky("terminal-3406", `workflow:${RUN_ID}/**`);
			const actual: { stageId: string; state?: string; actionable: boolean }[] = [];
			const expected: typeof actual = [];
			for (const status of ["completed", "failed", "skipped"] as const) {
				for (const admission of ["transport", "context", "none"] as const) {
					const stageId = `${status}-${admission}`;
					store.recordStageStart(RUN_ID, {
						id: stageId,
						name: stageId,
						status,
						sessionId: `${stageId}-session`,
						parentIds: [],
						toolEvents: [],
						pendingStageDeliveryAvailable: false,
						...(status === "failed" ? { error: "Stage failed" } : {}),
					});
					if (admission !== "none") {
						await store.recordPendingStageMessageDeliveries(
							RUN_ID,
							"terminal-3406",
							[{ runId: RUN_ID, stageId, sessionId: `${stageId}-session`, admission }],
							"2026-10-03T00:00:00Z",
							requireStoreDurableBackend(store),
						);
					}
					// Inspection lists a bounded set of exemplar states, so the stage's state comes from the full
					// computation; the inspected counts must cover every state.
					const detail = inspectRun(RUN_ID, { store });
					assert.ok(detail.ok);
					const all = stickyStageDeliveryStatuses(store.runs(), RUN_ID, requireStoreDurableBackend(store));
					assert.equal(
						Object.values(detail.detail.deliveryStateCounts ?? {}).reduce((total, count) => total + count, 0),
						all.length,
					);
					const state = all.find((delivery) => delivery.stageId === stageId);
					actual.push({
						stageId,
						state: state?.state,
						actionable: /steer a live stage or start a new stage/.test(state?.reason ?? ""),
					});
					expected.push({
						stageId,
						state: admission === "context" ? "delivered" : "stage-terminal",
						actionable: admission !== "context",
					});
				}
			}
			assert.deepEqual(actual, expected);
		} finally {
			dispose();
		}
	});

	test("workflow status distinguishes acknowledged sessions and actionable sticky skips (#3406)", async () => {
		const { requireStoreDurableBackend } = await import("../../packages/workflows/src/durable/store-backend.js");
		const { inspectRun } = await import("../../packages/workflows/src/runs/background/run-inspect.js");
		const { summarizeRunSnapshot } = await import(
			"../../packages/workflows/src/extension/workflow-status-summary.js"
		);
		const { store, queueSticky, dispose } = await rowHarness({ childRun: true });
		try {
			await queueSticky("status-3406", `workflow:${RUN_ID}/**`);
			const reviewer = store.runs()[0]!.stages[0]!;
			Object.assign(reviewer, { status: "running", sessionId: "current-session" });
			store.recordStageStart(RUN_ID, reviewer);
			for (const stage of [
				{
					id: "unavailable",
					name: "unavailable",
					status: "pending" as const,
					pendingStageDeliveryAvailable: false,
				},
				{
					id: "ended",
					name: "ended",
					status: "failed" as const,
					pendingStageDeliveryAvailable: true,
					error: "Intercom session retired before pending-stage delivery; message remains queued",
				},
				{ id: "tool", name: "tool", status: "pending" as const, nodeKind: "tool" as const },
				{ id: "prompt", name: "prompt", status: "pending" as const, replayKey: "prompt:input:1" },
			])
				store.recordStageStart(RUN_ID, { ...stage, parentIds: [], toolEvents: [] });
			const states = () => {
				const detail = inspectRun(RUN_ID, { store });
				assert.ok(detail.ok);
				assert.deepEqual(
					summarizeRunSnapshot(store.runs()[0]!, Date.now(), {
						allRuns: store.runs(),
						durableBackend: requireStoreDurableBackend(store),
					}).deliveryStates,
					detail.detail.deliveryStates,
				);
				return detail.detail.deliveryStates ?? [];
			};
			assert.equal(states().find((delivery) => delivery.stageId === reviewer.id)?.state, "queued");
			assert.equal(states().find((delivery) => delivery.stageId === "unavailable")?.state, "delivery-unavailable");
			assert.equal(
				states().find((delivery) => delivery.stageId === "ended")?.reason,
				"Intercom session retired before pending-stage delivery; message remains queued; Stage ended without confirmed context admission; steer a live stage or start a new stage",
			);
			assert.equal(
				states().some((delivery) => ["tool", "prompt", "boundary-id"].includes(delivery.stageId)),
				false,
			);
			await store.recordPendingStageMessageDeliveries(
				RUN_ID,
				"status-3406",
				[{ runId: RUN_ID, stageId: reviewer.id }],
				"2026-10-02T00:00:00Z",
				requireStoreDurableBackend(store),
			);
			assert.equal(states().find((delivery) => delivery.stageId === reviewer.id)?.state, "receipt-unverified");
			await store.recordPendingStageMessageDeliveries(
				RUN_ID,
				"status-3406",
				[{ runId: RUN_ID, stageId: reviewer.id, sessionId: "current-session", admission: "context" }],
				"2026-10-02T00:00:01Z",
				requireStoreDurableBackend(store),
			);
			assert.equal(states().find((delivery) => delivery.stageId === reviewer.id)?.state, "delivered");
			reviewer.sessionId = "replacement-session";
			store.recordStageStart(RUN_ID, reviewer);
			assert.equal(states().find((delivery) => delivery.stageId === reviewer.id)?.state, "receipt-unverified");
			const boundary = store.runs()[0]!.stages.find((stage) => stage.id === "boundary-id")!;
			delete boundary.workflowChildRun;
			store.recordStageStart(RUN_ID, boundary);
			assert.equal(states().find((delivery) => delivery.runId === CHILD_RUN_ID)?.state, "root-unresolved");
		} finally {
			dispose();
		}
	});

	test("rows disappear when the owning run reaches a terminal status", async () => {
		const { store, routePayload, dispose } = await rowHarness({ possibleStages: ["setup"] });
		assert.equal((((await routePayload())?.possibleStages ?? []) as unknown[]).length, 2);
		store.recordRunEnd(RUN_ID, "completed");
		assert.deepEqual((await routePayload())?.possibleStages, []);
		dispose();
	});

	test("only the root run's announcement carries the possible-stage rows", async () => {
		const { emitted, dispose } = await rowHarness({ possibleStages: ["setup"], childRun: true });
		const rootRoute = emitted.find(({ payload }) => payload.runId === RUN_ID && payload.possibleStages !== undefined);
		const childRoute = emitted.find(({ payload }) => payload.runId === CHILD_RUN_ID);
		assert.ok(rootRoute);
		assert.ok(childRoute);
		assert.equal("possibleStages" in childRoute.payload, false);
		dispose();
	});
});
