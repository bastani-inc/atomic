import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { AgentWakeDispatcher, type ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	LOCAL_RETRY_LOOKUP_BOUND_MS,
	MULTI_NODE_OUTCOME_POLL_INTERVAL_MS,
	MultiNodeRouter,
	type MultiNodeRouterOptions,
	PRESENCE_REGISTRATION_BOUND_MS,
	type ReservationOptions,
	SESSION_ID_CLAIM_BOUND_MS,
	SESSION_ID_OWNER_SAFE_MS,
	type SessionIdClaim,
	type SessionIdGrant,
	type UnansweredSessionIdClaim,
} from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_RENEW_INTERVAL_MS,
	BROKER_LEASE_STALE_AFTER_MS,
	type HeldSendRequest,
	type IntercomBrokerStateStore,
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type RecipientPresenceSubject,
	reservationKeyFor,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	RESTORING_RECIPIENT_HOLD_MS,
	restoringRecipientRetryReason,
} from "../../packages/intercom/broker/restoring-recipients.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	type RemoteSendRequest,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { WakeUpBus, WakeUpHint } from "../../packages/intercom/broker/wake-up-bus.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import {
	handleReleasedChildWakes,
	subagentWakeKey,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { databaseAnswer, STALL_PAST_BOUND_MS, stallEventLoop } from "../helpers/event-loop-stall.js";
import {
	openMemoryHeldSendFixture,
	openMemoryKnownSessionFixture,
	openMemoryLeaseStoreFixture,
	openMemoryOutboxFixture,
	openMemoryPendingAskFixture,
	openMemoryReleasedAskFixture,
	openMemoryRestoringReservationFixture,
	openMemorySentMessageFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[] };

const CREW = normalizeGroup("crew");

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

function session(name: string, group: string = CREW): BrokerConnectedSession {
	const info: SessionInfo = {
		id: randomUUID(),
		name,
		cwd: "/work",
		model: "test/model",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
		group,
		groups: [group],
	};
	return {
		socket: fakeSocket(),
		info,
		registrationGroup: group,
		registrationName: name,
		registrationReturnAddress: randomUUID(),
		acknowledgesReceipt: true,
	};
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const framesOf = (target: BrokerConnectedSession): BrokerOutboundFrame[] => (target.socket as FakeSocket).frames;

const wakeFramesOf = (target: BrokerConnectedSession): BrokerOutboundFrame[] =>
	framesOf(target).filter((frame) => frame.type === "restoring_recipient_wake");

interface Cluster {
	connectState(): Promise<IntercomBrokerStateStore>;
	connectBus(): Promise<WakeUpBus>;
}

interface Spied {
	readonly requestWakeCalls: string[];
	readonly takeWakeCalls: string[];
	heldListCalls: number;
}

interface Node {
	readonly router: MultiNodeRouter;
	readonly sessions: Map<string, BrokerConnectedSession>;
	readonly state: IntercomBrokerStateStore;
	readonly published: WakeUpHint[];
	readonly spied: Spied;
	/** The held sends this broker routed again as their sender. */
	readonly dispatched: string[];
	/** #5607: the sessions disconnected here because another registration owns their id. */
	readonly fenced: BrokerConnectedSession[];
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function cluster(): Promise<Cluster> {
	const leases = await openMemoryLeaseStoreFixture();
	const bus = await openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
	// #5607: the hint an enqueue for an offline recipient sends, as the SQL outbox writes it with the row.
	const wakes = await bus.connect();
	const outbox = await openMemoryOutboxFixture(leases.presenceHolder, (brokerId, version) =>
		wakes.publish({ brokerId, reason: "outbox", version }),
	);
	const heldSends = await openMemoryHeldSendFixture();
	const reservations = await openMemoryRestoringReservationFixture();
	const pendingAsks = await openMemoryPendingAskFixture();
	const releasedAsks = await openMemoryReleasedAskFixture();
	const sentMessages = await openMemorySentMessageFixture();
	const knownSessions = await openMemoryKnownSessionFixture(leases.returnAddressHolders);
	return {
		async connectState() {
			return {
				leases: await leases.connect(),
				outbox: await outbox.connect(),
				heldSends: await heldSends.connect(),
				reservations: await reservations.connect(),
				pendingAsks: await pendingAsks.connect(),
				releasedAsks: await releasedAsks.connect(),
				sentMessages: await sentMessages.connect(),
				knownSessions: await knownSessions.connect(),
				close: async () => {},
			};
		},
		connectBus: () => bus.connect(),
	};
}

async function startNode(
	shared: Cluster,
	options: {
		readonly requestWakeStatus?: "not-wakeable";
		readonly takeInvalid?: boolean;
		/** Reservation renewals are lost on the way to the database: the broker keeps its mirrors, the rows age. */
		readonly loseReservationRenewals?: boolean;
		/** Held-send listings wait until this settles. */
		readonly heldListGate?: Promise<void>;
		readonly heldListInvalid?: boolean;
		readonly undeliveredListInvalid?: boolean;
		/** Presence lease acquisitions wait until this settles, as when the database is slow to answer. */
		readonly presenceAcquireGate?: Promise<void>;
		/** Outbox claims are handed back only once this settles, as when the database is slow to answer. */
		readonly releaseClaimGate?: Promise<void>;
		/** Outbox claims reach the database only once this settles, as when the database is slow to answer. */
		readonly claimGate?: Promise<void>;
		/** Presence leases are released only once this settles, as when the database is slow to answer. */
		readonly presenceReleaseGate?: Promise<void>;
		/** Held sends are written only once this settles, as when the database is slow to answer. */
		readonly holdGate?: Promise<void>;
		/** Outbox rows are written only once this settles, as when the database is slow to answer. */
		readonly enqueueGate?: Promise<void>;
		/** The first reservation consumes fail, as on a transient database error. */
		readonly consumeFailures?: number;
		/** #5607: sessions registered on this broker before its routing across nodes turned on. */
		readonly registeredBefore?: readonly BrokerConnectedSession[];
		/** #5607: the broker's host and process, as its membership records them. */
		readonly process?: Pick<MultiNodeRouterOptions, "hostIdentity" | "instanceKey" | "pid" | "isProcessAlive">;
	} = {},
): Promise<Node> {
	const inner = await shared.connectState();
	const spied: Spied = { requestWakeCalls: [], takeWakeCalls: [], heldListCalls: 0 };
	let consumeFailures = options.consumeFailures ?? 0;
	const state: IntercomBrokerStateStore = {
		...inner,
		leases: {
			...inner.leases,
			acquire: async (subject, holderId, staleAfterMs) => {
				if (subject.kind === "presence") await options.presenceAcquireGate;
				return inner.leases.acquire(subject, holderId, staleAfterMs);
			},
			release: async (lease) => {
				if (lease.key.kind === "presence") await options.presenceReleaseGate;
				return inner.leases.release(lease);
			},
		},
		heldSends: {
			...inner.heldSends,
			hold: async (send) => {
				await options.holdGate;
				return inner.heldSends.hold(send);
			},
			list: async (key) => {
				spied.heldListCalls++;
				await options.heldListGate;
				if (options.heldListInvalid === true) return { status: "invalid", reason: "empty-reservation-key" };
				return inner.heldSends.list(key);
			},
		},
		outbox: {
			...inner.outbox,
			enqueue: async (row) => {
				await options.enqueueGate;
				return inner.outbox.enqueue(row);
			},
			claim: async (request) => {
				await options.claimGate;
				return inner.outbox.claim(request);
			},
			releaseClaim: async (claim, releaseOptions) => {
				await options.releaseClaimGate;
				return inner.outbox.releaseClaim(claim, releaseOptions);
			},
			listUndelivered: async (identity) =>
				options.undeliveredListInvalid === true
					? { status: "invalid", reason: "empty-target-identity" }
					: inner.outbox.listUndelivered(identity),
		},
		reservations: {
			...inner.reservations,
			requestWake: async (key, claim) => {
				spied.requestWakeCalls.push(key);
				if (options.requestWakeStatus !== undefined) return { status: options.requestWakeStatus };
				return inner.reservations.requestWake(key, claim);
			},
			takeWakeRequests: async (brokerId) => {
				spied.takeWakeCalls.push(brokerId);
				if (options.takeInvalid === true) return { status: "invalid", reason: "empty-broker-id" };
				return inner.reservations.takeWakeRequests(brokerId);
			},
			renew: async (lease) =>
				options.loseReservationRenewals === true ? { status: "renewed" } : inner.reservations.renew(lease),
			consume: async (key, registered) => {
				if (consumeFailures-- > 0) throw new Error("consume failed: shared database is busy");
				return inner.reservations.consume(key, registered);
			},
		},
	};
	const innerBus = await shared.connectBus();
	const published: WakeUpHint[] = [];
	const bus: WakeUpBus = {
		publish: (hint) => {
			published.push(hint);
			return innerBus.publish(hint);
		},
		subscribe: (brokerId, listener) => innerBus.subscribe(brokerId, listener),
		close: () => innerBus.close(),
	};
	const sessions = new Map<string, BrokerConnectedSession>(
		(options.registeredBefore ?? []).map((registered) => [registered.info.id, registered]),
	);
	const dispatched: string[] = [];
	const fenced: BrokerConnectedSession[] = [];
	const router: MultiNodeRouter = await MultiNodeRouter.start({
		...options.process,
		state,
		bus,
		host: {
			sessions,
			write: (socket, frame) => {
				(socket as FakeSocket).frames.push(frame);
				return true;
			},
			writeConfirmed: (socket, frame, onSettled) => {
				(socket as FakeSocket).frames.push(frame);
				onSettled(true);
			},
			supervisorCache: new SupervisorChannelCache(),
			pendingQuestions: new PendingQuestionIndex(),
			deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
			dispatch: (_socket, clientMessage) => {
				dispatched.push((clientMessage as unknown as HeldSendRequest).message.id);
			},
			revokeReleasedReservation: () => {},
			holdsReservation: () => true,
			// #5607: as the broker does: the session leaves here, as if its connection dropped.
			fence: (session) => {
				fenced.push(session);
				if (sessions.get(session.info.id) === session) sessions.delete(session.info.id);
				router.sessionLeft(session, undefined, false);
			},
		},
	});
	cleanups.push(() => router.close());
	await flush();
	return { router, sessions, state, published, spied, dispatched, fenced };
}

function reserve(
	node: Node,
	capability: string,
	owner: BrokerConnectedSession,
	wake: boolean,
	options?: ReservationOptions,
) {
	node.router.restoringReserved(capability, owner.info.id, "child", CREW, [], false, {
		...(wake ? { wake: true } : {}),
		...options,
	});
}

async function seedHeldSend(node: Node, reservationKey: string, sender: BrokerConnectedSession): Promise<void> {
	const id = randomUUID();
	const held = await node.state.heldSends.hold({
		reservationKey,
		originBrokerId: "other-origin",
		senderSessionId: sender.info.id,
		request: {
			type: "send",
			to: "child",
			message: { id, timestamp: 1, content: { text: "hi" } },
		} as HeldSendRequest,
	});
	assert.equal(held.status, "held");
}

function remoteSend(
	from: BrokerConnectedSession,
	target: string,
	awaitRestoringRecipient: boolean,
): { readonly request: RemoteSendRequest; readonly id: string; readonly attemptId: string } {
	const id = randomUUID();
	const attemptId = randomUUID();
	const message = { id, timestamp: 1, content: { text: "hi" } };
	return {
		id,
		attemptId,
		request: {
			socket: from.socket,
			from,
			clientMessage: { type: "send", to: target, message, attemptId },
			message,
			target,
			signature: `${target}:${id}`,
			attemptId,
			supervisorSend: false,
			requirePendingReply: false,
			resolveReplyTarget: false,
			awaitRestoringRecipient,
			notFound: () => {},
		},
	};
}

describe("router reservation wake (#4326)", () => {
	test("restoringReserved stores the wake flag only when asked (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		node.sessions.set(owner.info.id, owner);
		const woken = `${randomUUID()}.capability`;
		const plain = `${randomUUID()}.capability`;
		node.router.restoringReserved(woken, owner.info.id, "woken", CREW, [], false, { wake: true });
		node.router.restoringReserved(plain, owner.info.id, "plain", CREW, [], false);
		await flush();
		const wokenRead = await node.state.reservations.read(reservationKeyFor(woken));
		const plainRead = await node.state.reservations.read(reservationKeyFor(plain));
		assert.equal(wokenRead.status === "active" && wokenRead.reservation.wake, true);
		assert.equal(plainRead.status === "active" && plainRead.reservation.wake, false);
	});

	test("restoringReserved replaces aliases only when replaceAliases is set (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		node.sessions.set(owner.info.id, owner);
		const merged = `${randomUUID()}.capability`;
		const replaced = `${randomUUID()}.capability`;
		for (const [capability, childName, options] of [
			[merged, "merged", undefined],
			[replaced, "replaced", { replaceAliases: true }],
		] as const) {
			node.router.restoringReserved(capability, owner.info.id, childName, CREW, ["old"], false);
			await flush();
			node.router.restoringReserved(capability, owner.info.id, childName, CREW, ["fresh"], false, options);
			await flush();
		}
		const mergedRead = await node.state.reservations.read(reservationKeyFor(merged));
		const replacedRead = await node.state.reservations.read(reservationKeyFor(replaced));
		assert.deepEqual(mergedRead.status === "active" ? mergedRead.reservation.targets : undefined, [
			"merged",
			"old",
			"fresh",
		]);
		assert.deepEqual(replacedRead.status === "active" ? replacedRead.reservation.targets : undefined, [
			"replaced",
			"fresh",
		]);
	});

	test("a wake reservation made while sends are already held wakes its owner once, with its capability (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		const sender = session("sender");
		node.sessions.set(owner.info.id, owner);
		const capability = `${randomUUID()}.capability`;
		await seedHeldSend(node, reservationKeyFor(capability), sender);
		reserve(node, capability, owner, true);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child", capability }]);
		assert.deepEqual(node.spied.requestWakeCalls, [reservationKeyFor(capability)]);
		reserve(node, capability, owner, true);
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1, "already wakeable: no second wake");
		assert.equal(node.spied.requestWakeCalls.length, 1);
	});

	test("a released child's wake frame carries no capability (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		const sender = session("sender");
		node.sessions.set(owner.info.id, owner);
		const key = releasedReservationKey("child");
		await seedHeldSend(node, key, sender);
		reserve(node, key, owner, true);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child" }]);
	});

	test("a wake reservation re-made after a non-wake one wakes the held sends (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		const sender = session("sender");
		node.sessions.set(owner.info.id, owner);
		const capability = `${randomUUID()}.capability`;
		await seedHeldSend(node, reservationKeyFor(capability), sender);
		reserve(node, capability, owner, false);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.equal(wakeFramesOf(owner).length, 0);
		reserve(node, capability, owner, true);
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1);
	});

	test("a wake reservation with nothing held asks for no wake (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		node.sessions.set(owner.info.id, owner);
		reserve(node, `${randomUUID()}.capability`, owner, true);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.equal(wakeFramesOf(owner).length, 0);
	});

	test("the outcome poll delivers a wake requested without a hint only while a reservation is mirrored (#4326)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const shared = await cluster();
		const idle = await startNode(shared);
		const idleTakes = idle.spied.takeWakeCalls.length;
		await vi.advanceTimersByTimeAsync(MULTI_NODE_OUTCOME_POLL_INTERVAL_MS);
		assert.equal(idle.spied.takeWakeCalls.length, idleTakes, "nothing mirrored: no wake read");

		const node = await startNode(shared);
		const owner = session("owner");
		node.sessions.set(owner.info.id, owner);
		const capability = `${randomUUID()}.capability`;
		reserve(node, capability, owner, true);
		await flush();
		const takesBefore = node.spied.takeWakeCalls.length;
		assert.deepEqual((await node.state.reservations.requestWake(reservationKeyFor(capability))).status, "requested");
		await vi.advanceTimersByTimeAsync(MULTI_NODE_OUTCOME_POLL_INTERVAL_MS);
		await flush();
		assert.equal(node.spied.takeWakeCalls.length, takesBefore + 1);
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child", capability }]);
	});
});

describe("router remote reservation hold (#4326)", () => {
	test("the first send held for a wake reservation wakes the owner's broker through a hint, the second does not (#4326)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared);
		const owner = session("owner");
		const sender = session("sender");
		ownerNode.sessions.set(owner.info.id, owner);
		senderNode.sessions.set(sender.info.id, sender);
		const key = releasedReservationKey("child");
		reserve(ownerNode, key, owner, true);
		await flush();

		const first = remoteSend(sender, "child", true);
		senderNode.router.routeSend(first.request);
		await flush();
		assert.deepEqual(framesOf(sender), [
			{
				type: "send_held",
				messageId: first.id,
				attemptId: first.attemptId,
				timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
			},
		]);
		assert.deepEqual(senderNode.spied.requestWakeCalls, [key]);
		assert.deepEqual(senderNode.published, [{ brokerId: ownerNode.router.brokerId, reason: "outcome", version: 0 }]);
		assert.deepEqual(wakeFramesOf(sender), []);
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child" }]);

		const second = remoteSend(sender, "child", true);
		senderNode.router.routeSend(second.request);
		await flush();
		assert.deepEqual(senderNode.spied.requestWakeCalls, [key]);
		assert.equal(senderNode.published.length, 1);
		assert.equal(wakeFramesOf(owner).length, 1);
	});

	test("the owner's own broker wakes its child directly, with no hint (#4326)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		const sender = session("sender");
		node.sessions.set(owner.info.id, owner);
		node.sessions.set(sender.info.id, sender);
		const capability = `${randomUUID()}.capability`;
		reserve(node, capability, owner, true);
		await flush();
		node.router.routeSend(remoteSend(sender, "child", true).request);
		await flush();
		assert.deepEqual(node.published, []);
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child", capability }]);
	});

	test("a send held for a reservation without wake asks for no wake (#4326)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared);
		const owner = session("owner");
		const sender = session("sender");
		ownerNode.sessions.set(owner.info.id, owner);
		senderNode.sessions.set(sender.info.id, sender);
		reserve(ownerNode, `${randomUUID()}.capability`, owner, false);
		await flush();
		const held = remoteSend(sender, "child", true);
		senderNode.router.routeSend(held.request);
		await flush();
		assert.equal(framesOf(sender)[0]?.type, "send_held");
		assert.deepEqual(senderNode.spied.requestWakeCalls, []);
		assert.deepEqual(senderNode.published, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a wake the store reports as not wakeable sends no hint (#4326)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared, { requestWakeStatus: "not-wakeable" });
		const owner = session("owner");
		const sender = session("sender");
		ownerNode.sessions.set(owner.info.id, owner);
		senderNode.sessions.set(sender.info.id, sender);
		reserve(ownerNode, releasedReservationKey("child"), owner, true);
		await flush();
		senderNode.router.routeSend(remoteSend(sender, "child", true).request);
		await flush();
		assert.equal(framesOf(sender)[0]?.type, "send_held");
		assert.equal(senderNode.spied.requestWakeCalls.length, 1);
		assert.deepEqual(senderNode.published, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a send that does not wait is refused with the reason code of its reservation (#4326)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared);
		const owner = session("owner");
		ownerNode.sessions.set(owner.info.id, owner);
		const sender = session("sender");
		senderNode.sessions.set(sender.info.id, sender);
		reserve(ownerNode, releasedReservationKey("child"), owner, false);
		await flush();
		const parked = remoteSend(sender, "child", false);
		senderNode.router.routeSend(parked.request);
		await flush();
		assert.deepEqual(framesOf(sender), [
			{
				type: "delivery_failed",
				messageId: parked.id,
				attemptId: parked.attemptId,
				reason: restoringRecipientRetryReason("child"),
				reasonCode: "recipient_parked",
			},
		]);

		reserve(ownerNode, releasedReservationKey("child"), owner, true);
		await flush();
		const waking = remoteSend(sender, "child", false);
		senderNode.router.routeSend(waking.request);
		await flush();
		assert.deepEqual(framesOf(sender).slice(1), [
			{
				type: "delivery_failed",
				messageId: waking.id,
				attemptId: waking.attemptId,
				reason: restoringRecipientRetryReason("child"),
				reasonCode: "recipient_not_restored",
			},
		]);
		assert.deepEqual(senderNode.spied.requestWakeCalls, []);
	});

	test("a held send nobody restores fails with its reason code when the hold expires (#4326)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared);
		const owner = session("owner");
		const sender = session("sender");
		ownerNode.sessions.set(owner.info.id, owner);
		senderNode.sessions.set(sender.info.id, sender);
		reserve(ownerNode, releasedReservationKey("child"), owner, false);
		await flush();
		const held = remoteSend(sender, "child", true);
		senderNode.router.routeSend(held.request);
		await flush();
		assert.equal(framesOf(sender).length, 1);
		await vi.advanceTimersByTimeAsync(RESTORING_RECIPIENT_HOLD_MS);
		await flush();
		assert.deepEqual(framesOf(sender).slice(1), [
			{
				type: "delivery_failed",
				messageId: held.id,
				attemptId: held.attemptId,
				reason: restoringRecipientRetryReason("child"),
				reasonCode: "recipient_parked",
			},
		]);
	});
});

describe("router reservation consumption (#4326)", () => {
	async function reserveRaw(
		node: Node,
		reservationKey: string,
		dormant: boolean,
		options: { readonly group?: string; readonly owner?: string } = {},
	): Promise<void> {
		const reserved = await node.state.reservations.reserve({
			reservationKey,
			ownerSessionId: options.owner ?? `owner-${dormant ? "dormant" : "live"}-${reservationKey.slice(-6)}`,
			ownerBrokerId: "other-broker",
			childName: "child",
			childTarget: "child",
			aliases: [],
			group: options.group ?? CREW,
			dormant,
			wake: true,
		});
		assert.equal(reserved.status, "reserved");
	}

	const statusOf = async (node: Node, key: string): Promise<string> => {
		const read = await node.state.reservations.read(key);
		return read.status === "ended" ? read.end.outcome : read.status;
	};

	test("a child registering under its owner's capability consumes its released reservation in its groups and leaves dormant capability ones (#4326)", async () => {
		const node = await startNode(await cluster());
		const releasedKey = releasedReservationKey("child");
		const dormantKey = reservationKeyFor(`${randomUUID()}.capability`);
		const otherGroupKey = releasedReservationKey("other");
		await reserveRaw(node, releasedKey, false, { owner: "the-owner" });
		await reserveRaw(node, dormantKey, true);
		await reserveRaw(node, otherGroupKey, false, { group: normalizeGroup("elsewhere"), owner: "the-other-owner" });
		await node.router.sessionRegistered(session("child"), {
			childName: "Child",
			groups: new Set([CREW]),
			authorizedBy: "the-owner",
		});
		assert.equal(await statusOf(node, releasedKey), "consumed");
		assert.equal(await statusOf(node, dormantKey), "active");
		assert.equal(await statusOf(node, otherGroupKey), "active");
	});

	test("a session that shares a released child's name and group, with no capability or another session's, leaves its reservation (#4326)", async () => {
		const node = await startNode(await cluster());
		const releasedKey = releasedReservationKey("child");
		await reserveRaw(node, releasedKey, false, { owner: "the-owner" });
		await node.router.sessionRegistered(session("squatter"), { childName: "child", groups: new Set([CREW]) });
		assert.equal(await statusOf(node, releasedKey), "active");
		await node.router.sessionRegistered(session("impostor"), {
			childName: "child",
			groups: new Set([CREW]),
			authorizedBy: "another-owner",
		});
		assert.equal(await statusOf(node, releasedKey), "active");
	});

	test("a released reservation outside the registering groups stays (#4326)", async () => {
		const node = await startNode(await cluster());
		const key = releasedReservationKey("child");
		await reserveRaw(node, key, false, { group: normalizeGroup("elsewhere") });
		await node.router.sessionRegistered(session("child"), { childName: "child", groups: new Set([CREW]) });
		assert.equal(await statusOf(node, key), "active");
	});

	test("a child registering with its capability consumes it and its dormant siblings (#4326)", async () => {
		const node = await startNode(await cluster());
		const capability = `${randomUUID()}.capability`;
		const ownKey = reservationKeyFor(capability);
		const siblingKey = reservationKeyFor(`${randomUUID()}.capability`);
		await reserveRaw(node, ownKey, false);
		await reserveRaw(node, siblingKey, true);
		await node.router.sessionRegistered(session("child"), {
			capability,
			childName: "child",
			groups: new Set([CREW]),
		});
		assert.equal(await statusOf(node, ownKey), "consumed");
		assert.equal(await statusOf(node, siblingKey), "consumed");
	});

	test("a capability without a child name consumes only its own reservation (#4326)", async () => {
		const node = await startNode(await cluster());
		const capability = `${randomUUID()}.capability`;
		const ownKey = reservationKeyFor(capability);
		const siblingKey = reservationKeyFor(`${randomUUID()}.capability`);
		await reserveRaw(node, ownKey, false);
		await reserveRaw(node, siblingKey, true);
		await node.router.sessionRegistered(session("child"), { capability, groups: new Set([CREW]) });
		assert.equal(await statusOf(node, ownKey), "consumed");
		assert.equal(await statusOf(node, siblingKey), "active");
	});

	test("a child that leaves while its registration still takes its presence over leaves the released reservation its owner made after it left, and ends its own (#4488)", async () => {
		let answer!: () => void;
		const node = await startNode(await cluster(), {
			presenceAcquireGate: new Promise<void>((resolve) => {
				answer = resolve;
			}),
		});
		const capability = `${randomUUID()}.capability`;
		const ownKey = reservationKeyFor(capability);
		const releasedKey = releasedReservationKey("child");
		await reserveRaw(node, ownKey, false);
		const child = session("child");
		const registered = node.router.sessionRegistered(child, {
			capability,
			childName: "child",
			groups: new Set([CREW]),
			authorizedBy: "the-owner",
		});
		await flush();
		// The child is released while its broker is still taking its presence over: it leaves, and its owner reserves
		// it as released, before the registration gets to the reservations it consumes.
		node.router.sessionLeft(child);
		await reserveRaw(node, releasedKey, true, { owner: "the-owner" });
		answer();
		await registered;
		await flush();
		assert.equal(
			await statusOf(node, releasedKey),
			"active",
			"the released child stays reserved, so a send wakes it",
		);
		assert.equal(await statusOf(node, ownKey), "consumed");
	});

	test("a registration still taking its presence over leaves a released reservation its owner made after it began, before the broker sees the child leave (#4488)", async () => {
		let answer!: () => void;
		const node = await startNode(await cluster(), {
			presenceAcquireGate: new Promise<void>((resolve) => {
				answer = resolve;
			}),
		});
		const capability = `${randomUUID()}.capability`;
		const ownKey = reservationKeyFor(capability);
		const releasedKey = releasedReservationKey("child");
		await reserveRaw(node, ownKey, false);
		const registered = node.router.sessionRegistered(session("child"), {
			capability,
			childName: "child",
			groups: new Set([CREW]),
			authorizedBy: "the-owner",
		});
		await flush();
		// The child is released while the broker still takes its presence over; its leave has not reached the broker.
		await reserveRaw(node, releasedKey, true, { owner: "the-owner" });
		answer();
		await registered;
		await flush();
		assert.equal(
			await statusOf(node, releasedKey),
			"active",
			"the released child stays reserved, so a send wakes it",
		);
		assert.equal(await statusOf(node, ownKey), "consumed");
	});

	test("a consume retried after a store error ends the reservations the registration found, and leaves a released one its owner made after it began (#5138)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const node = await startNode(await cluster(), { consumeFailures: 1 });
			const capability = `${randomUUID()}.capability`;
			const ownKey = reservationKeyFor(capability);
			const releasedKey = releasedReservationKey("child");
			await reserveRaw(node, ownKey, false);
			await node.router.sessionRegistered(session("child"), {
				capability,
				childName: "child",
				groups: new Set([CREW]),
				authorizedBy: "the-owner",
			});
			await flush();
			assert.equal(await statusOf(node, ownKey), "active", "the failed consume ended nothing");
			// The child is released again before the store recovers: its owner's new reservation is newer than the registration.
			await reserveRaw(node, releasedKey, true, { owner: "the-owner" });
			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			await vi.waitFor(async () => assert.equal(await statusOf(node, ownKey), "consumed"), {
				timeout: 2_000,
				interval: 5,
			});
			assert.equal(await statusOf(node, releasedKey), "active", "the released child stays reserved");
			assert.ok(vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("consume failed")));
		} finally {
			vi.useRealTimers();
		}
	});

	test("a registration naming neither a capability nor a child consumes nothing and reports no error (#4326)", async () => {
		const node = await startNode(await cluster());
		const key = releasedReservationKey("child");
		await reserveRaw(node, key, false);
		await node.router.sessionRegistered(session("child"), { groups: new Set([CREW]) });
		await flush();
		assert.equal(await statusOf(node, key), "active");
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});
});

describe("router wake delivery edge cases (#4326)", () => {
	async function hint(shared: Cluster, node: Node): Promise<void> {
		const bus = await shared.connectBus();
		await bus.publish({ brokerId: node.router.brokerId, reason: "outcome", version: 0 });
		await flush();
	}

	test("a wake request the store cannot read is skipped without an error (#4326)", async () => {
		const shared = await cluster();
		const node = await startNode(shared, { takeInvalid: true });
		const before = node.spied.takeWakeCalls.length;
		await hint(shared, node);
		assert.ok(node.spied.takeWakeCalls.length > before);
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("a wake request for an owner not connected here is consumed and skipped without an error (#4326)", async () => {
		const shared = await cluster();
		const node = await startNode(shared);
		const reserved = await node.state.reservations.reserve({
			reservationKey: "absent-owner",
			ownerSessionId: "gone-session",
			ownerBrokerId: node.router.brokerId,
			childName: "child",
			childTarget: "child",
			aliases: [],
			group: CREW,
			dormant: false,
			wake: true,
		});
		assert.equal(reserved.status, "reserved");
		assert.deepEqual(await node.state.reservations.requestWake("absent-owner"), { status: "requested" });
		await hint(shared, node);
		assert.deepEqual(await node.state.reservations.takeWakeRequests(node.router.brokerId), {
			status: "taken",
			requests: [],
		});
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("a wake request for a reservation this broker does not mirror still wakes its owner, without a capability (#4326)", async () => {
		const shared = await cluster();
		const node = await startNode(shared);
		const owner = session("owner");
		node.sessions.set(owner.info.id, owner);
		await node.state.reservations.reserve({
			reservationKey: "unmirrored",
			ownerSessionId: owner.info.id,
			ownerBrokerId: node.router.brokerId,
			childName: "child",
			childTarget: "child",
			aliases: [],
			group: CREW,
			dormant: false,
			wake: true,
		});
		await node.state.reservations.requestWake("unmirrored");
		await hint(shared, node);
		assert.deepEqual(wakeFramesOf(owner), [{ type: "restoring_recipient_wake", childName: "child" }]);
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});
});

describe("released child sends queued across faults (#4401)", () => {
	const CHILD = "child";
	const WAKE = { type: "restoring_recipient_wake", childName: CHILD };

	function useFakeClock(): void {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
	}

	async function register(node: Node, target: BrokerConnectedSession): Promise<void> {
		node.sessions.set(target.info.id, target);
		await node.router.sessionRegistered(target);
		await flush();
	}

	function leave(node: Node, target: BrokerConnectedSession): void {
		node.sessions.delete(target.info.id);
		node.router.sessionLeft(target);
	}

	/** A subagent that registered on `node` and was released: it left, and stays known. */
	async function releasedChild(node: Node, name = CHILD): Promise<BrokerConnectedSession> {
		const child = session(name);
		await register(node, child);
		leave(node, child);
		await flush();
		return child;
	}

	/** The ids Subagents reserves for a released child besides its name. */
	const aliasesOf = (child: BrokerConnectedSession): string[] => [
		child.registrationReturnAddress ?? "",
		child.info.id,
	];

	function reserveReleased(
		node: Node,
		owner: BrokerConnectedSession,
		child: BrokerConnectedSession,
		options: { readonly wake?: boolean; readonly aliases?: readonly string[] } = {},
	): void {
		node.router.restoringReserved(
			releasedReservationKey(CHILD),
			owner.info.id,
			CHILD,
			CREW,
			options.aliases ?? aliasesOf(child),
			true,
			{ wake: options.wake ?? true, replaceAliases: true },
		);
	}

	/** The same session reconnecting through a new socket: a restarted owner, or a woken child. */
	const reconnected = (target: BrokerConnectedSession): BrokerConnectedSession => ({
		...target,
		socket: fakeSocket(),
	});

	async function wakeAndRegister(
		node: Node,
		owner: BrokerConnectedSession,
		child: BrokerConnectedSession,
	): Promise<BrokerConnectedSession> {
		const back = reconnected(child);
		node.sessions.set(back.info.id, back);
		await node.router.sessionRegistered(back, {
			childName: CHILD,
			groups: new Set([CREW]),
			authorizedBy: owner.info.id,
		});
		await flush();
		return back;
	}

	const messageIdsOf = (target: BrokerConnectedSession): string[] =>
		framesOf(target).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));

	/** Sends from `sender` that its broker reports as queued for the offline child. */
	async function queueSends(senderNode: Node, sender: BrokerConnectedSession, count: number): Promise<string[]> {
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const send = remoteSend(sender, CHILD, true);
			senderNode.router.routeSend(send.request);
			await flush();
			ids.push(send.id);
		}
		assert.deepEqual(
			framesOf(sender)
				.slice(-count)
				.map((frame) => (frame.type === "queued" ? [frame.messageId, frame.target] : frame.type)),
			ids.map((id) => [id, "offline session"]),
		);
		return ids;
	}

	/** Rows another node's broker queued for `target` in the shared outbox. */
	async function enqueueFor(node: Node, target: BrokerConnectedSession, count = 1): Promise<string[]> {
		const from = session("remote-sender").info;
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const id = randomUUID();
			const enqueued = await node.state.outbox.enqueue({
				targetIdentity: deliveryTargetIdentity(target),
				originBrokerId: "other-origin",
				digest: id,
				frame: { type: "message", from, message: { id, timestamp: 1, content: { text: "queued" } } },
			});
			assert.equal(enqueued.status, "inserted");
			ids.push(id);
		}
		return ids;
	}

	async function receiveAll(node: Node, child: BrokerConnectedSession, ids: readonly string[]): Promise<void> {
		for (const id of ids) assert.equal(node.router.received(child, id), true);
		await flush();
	}

	async function rowStates(node: Node, ids: readonly string[]): Promise<string[]> {
		return Promise.all(
			ids.map(async (id) => {
				const read = await node.state.outbox.read(id);
				return read.status === "found" ? read.row.state : read.status;
			}),
		);
	}

	async function ownerSenderAndChild(shared: Cluster, ownerNode: Node) {
		const senderNode = await startNode(shared);
		const owner = session("owner");
		const sender = session("sender");
		await register(ownerNode, owner);
		await register(senderNode, sender);
		const child = await releasedChild(ownerNode);
		reserveReleased(ownerNode, owner, child);
		await flush();
		return { senderNode, owner, sender, child };
	}

	test("sends queued while the owner's broker is down wake the child once the owner reserves it through a restarted broker, and arrive once each, in order (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		await ownerNode.router.close();
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const ids = await queueSends(senderNode, sender, 3);

		const restarted = await startNode(shared);
		const reconnectedOwner = reconnected(owner);
		restarted.sessions.set(owner.info.id, reconnectedOwner);
		reserveReleased(restarted, reconnectedOwner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(reconnectedOwner), [WAKE]);

		const back = await wakeAndRegister(restarted, reconnectedOwner, child);
		assert.deepEqual(messageIdsOf(back), ids);
		await receiveAll(restarted, back, ids);
		assert.deepEqual(await rowStates(restarted, ids), ["delivered", "delivered", "delivered"]);
		await vi.advanceTimersByTimeAsync(OUTBOX_CLAIM_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(messageIdsOf(back), ids, "nothing is delivered again");
		assert.equal(wakeFramesOf(reconnectedOwner).length, 1);
	});

	test("sends queued for a released child still wake it and arrive once each, in order, when its owner returns after the brokers forgot the child (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		await ownerNode.router.close();
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const ids = await queueSends(senderNode, sender, 3);
		// The owner stays away past the known-session retention; the sender's broker prunes the child's record meanwhile.
		vi.setSystemTime(Date.now() + KNOWN_SESSION_RETENTION_MS);
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		const forgotten = await senderNode.state.knownSessions.lookup(child.info.id, Number.MAX_SAFE_INTEGER);
		assert.deepEqual(forgotten, { status: "found", sessions: [] });

		const restarted = await startNode(shared);
		const reconnectedOwner = reconnected(owner);
		restarted.sessions.set(owner.info.id, reconnectedOwner);
		reserveReleased(restarted, reconnectedOwner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(reconnectedOwner), [WAKE]);

		const back = await wakeAndRegister(restarted, reconnectedOwner, child);
		assert.deepEqual(messageIdsOf(back), ids);
		await receiveAll(restarted, back, ids);
		assert.deepEqual(await rowStates(restarted, ids), ["delivered", "delivered", "delivered"]);
		await vi.advanceTimersByTimeAsync(OUTBOX_CLAIM_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(messageIdsOf(back), ids, "nothing is delivered again");
		assert.equal(wakeFramesOf(reconnectedOwner).length, 1);
	});

	test("sends still queued when the owner's process is killed, before and after it woke the child, reach the child once each, in order, through the next owner process (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		leave(ownerNode, owner);
		await flush();
		const ids = await queueSends(senderNode, sender, 3);

		const secondOwner = reconnected(owner);
		await register(ownerNode, secondOwner);
		reserveReleased(ownerNode, secondOwner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(secondOwner), [WAKE]);
		assert.deepEqual(await rowStates(ownerNode, ids), ["queued", "queued", "queued"]);
		leave(ownerNode, secondOwner);
		await flush();

		const thirdOwner = reconnected(owner);
		await register(ownerNode, thirdOwner);
		reserveReleased(ownerNode, thirdOwner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(thirdOwner), [WAKE]);
		assert.deepEqual(wakeFramesOf(owner), []);

		const back = await wakeAndRegister(ownerNode, thirdOwner, child);
		assert.deepEqual(messageIdsOf(back), ids);
		await receiveAll(ownerNode, back, ids);
		assert.deepEqual(await rowStates(ownerNode, ids), ["delivered", "delivered", "delivered"]);
		await vi.advanceTimersByTimeAsync(OUTBOX_CLAIM_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(messageIdsOf(back), ids, "nothing is delivered again");
		assert.equal(wakeFramesOf(secondOwner).length, 1);
		assert.equal(wakeFramesOf(thirdOwner).length, 1);
	});

	test("sends queued while the owner's broker cannot renew its reservation wake the child at that broker's next backup poll, once (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const ownerNode = await startNode(shared, { loseReservationRenewals: true });
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const ids = await queueSends(senderNode, sender, 2);
		assert.deepEqual(wakeFramesOf(owner), []);

		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1, "the backup poll wakes a reservation once");

		const back = await wakeAndRegister(ownerNode, owner, child);
		assert.deepEqual(messageIdsOf(back), ids);
	});

	test("a send held for a released child waits while its wake restores it, and is handed on as soon as the child registers with that wake's capability, not at its broker's next outcome poll (#4488)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		const send = remoteSend(sender, CHILD, true);
		senderNode.router.routeSend(send.request);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);

		// The owner restores the child under a capability of its own, which takes the released reservation over.
		const capability = `${randomUUID()}.capability`;
		ownerNode.router.restoringReserved(capability, owner.info.id, CHILD, CREW, aliasesOf(child), false);
		await flush();
		assert.deepEqual(senderNode.dispatched, [], "held while the child is being restored");

		const back = reconnected(child);
		ownerNode.sessions.set(back.info.id, back);
		await ownerNode.router.sessionRegistered(back, {
			capability,
			childName: CHILD,
			groups: new Set([CREW]),
			authorizedBy: owner.info.id,
		});
		await flush();
		assert.deepEqual(senderNode.dispatched, [send.id]);
	});

	test("a send held while its owner makes a released child wakeable again wakes it once, also when the owner's broker looked for held sends before the send was written (#4488)", async () => {
		const shared = await cluster();
		const holdWritten = Promise.withResolvers<void>();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared, { holdGate: holdWritten.promise });
		const owner = session("owner");
		const sender = session("sender");
		await register(ownerNode, owner);
		await register(senderNode, sender);
		const child = await releasedChild(ownerNode);
		// The owner parks the child while it releases it: a send that finds it so is held without asking for a wake.
		reserveReleased(ownerNode, owner, child, { wake: false });
		await flush();
		const send = remoteSend(sender, CHILD, true);
		senderNode.router.routeSend(send.request);
		await flush();
		// Released, it is made wakeable while the held send is still being written.
		reserveReleased(ownerNode, owner, child);
		await flush();
		holdWritten.resolve();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "send_held");
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("a message a released child never confirmed wakes it again and reaches it once, also when its owner made it wakeable before the broker handled its departure (#4488)", async () => {
		const shared = await cluster();
		const departureHandled = Promise.withResolvers<void>();
		const ownerNode = await startNode(shared, { releaseClaimGate: departureHandled.promise });
		const owner = session("owner");
		await register(ownerNode, owner);
		const child = session(CHILD);
		const ids = await enqueueFor(ownerNode, child);
		await register(ownerNode, child);
		assert.deepEqual(messageIdsOf(child), ids, "written to the child, which is released before it confirms it");
		leave(ownerNode, child);
		reserveReleased(ownerNode, owner, child);
		await flush();
		departureHandled.resolve();
		await flush();
		assert.deepEqual(await rowStates(ownerNode, ids), ["queued"]);
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);

		const back = await wakeAndRegister(ownerNode, owner, child);
		assert.deepEqual(messageIdsOf(back), ids);
		await receiveAll(ownerNode, back, ids);
		assert.deepEqual(await rowStates(ownerNode, ids), ["delivered"]);
		assert.equal(wakeFramesOf(owner).length, 1);
	});

	test("a released child that a broker still hosts is not woken for the sends being delivered to it (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		const child = session(CHILD);
		await register(node, owner);
		await register(node, child);
		await enqueueFor(node, child);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a released child whose broker crashed is woken once the presence lease it left behind is stale (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const node = await startNode(shared);
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		const crashed = await shared.connectState();
		const presence = {
			kind: "presence" as const,
			targetIdentity: deliveryTargetIdentity(child),
			session: child.info,
		};
		const acquired = await crashed.leases.acquire(presence, "crashed-broker", BROKER_LEASE_STALE_AFTER_MS);
		assert.equal(acquired.status, "acquired");
		const ids = await enqueueFor(node, child, 2);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [], "hosted while its presence lease is live");

		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		await vi.advanceTimersByTimeAsync(1);
		const back = await wakeAndRegister(node, owner, child);
		assert.deepEqual(messageIdsOf(back), ids);
	});

	test("reserving a woken child again neither wakes it again nor reads the store for it (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		await enqueueFor(node, child);
		reserveReleased(node, owner, child);
		await flush();
		const readsAfterWake = node.spied.heldListCalls;
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		assert.deepEqual(node.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		assert.equal(node.spied.heldListCalls, readsAfterWake);
	});

	test("a woken child that was parked and released again is woken again for the sends still waiting (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		await enqueueFor(node, child);
		reserveReleased(node, owner, child);
		await flush();
		reserveReleased(node, owner, child, { wake: false });
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE, WAKE]);
	});

	test("a child that registered through another broker and was released again is woken again by its owner's broker (#4401)", async () => {
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const otherNode = await startNode(shared);
		const owner = session("owner");
		await register(ownerNode, owner);
		const child = await releasedChild(ownerNode);
		const ids = await enqueueFor(ownerNode, child);
		reserveReleased(ownerNode, owner, child);
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1);

		const back = await wakeAndRegister(otherNode, owner, child);
		assert.deepEqual(messageIdsOf(back), ids);
		leave(otherNode, back);
		await flush();
		reserveReleased(ownerNode, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE, WAKE], "the earlier wake belonged to the reservation it ended");
	});

	test("sends queued for another session that shares the child's name do not wake the child (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		await register(node, owner);
		const namesake = await releasedChild(node);
		const child = await releasedChild(node);
		await enqueueFor(node, namesake);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	for (const [alias, aliasesOf] of [
		["Intercom session id", (child: BrokerConnectedSession) => [child.info.id]],
		["Atomic session id", (child: BrokerConnectedSession) => [child.registrationReturnAddress ?? ""]],
	] as const) {
		test(`a released child reserved under its ${alias} alone is woken for its queued sends (#4401)`, async () => {
			const node = await startNode(await cluster());
			const owner = session("owner");
			await register(node, owner);
			const child = await releasedChild(node);
			await enqueueFor(node, child);
			reserveReleased(node, owner, child, { aliases: aliasesOf(child) });
			await flush();
			assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		});
	}

	test("a released child whose queued sends were all delivered is not woken (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		const ids = await enqueueFor(node, child, 2);
		const back = await wakeAndRegister(node, owner, child);
		await receiveAll(node, back, ids);
		leave(node, back);
		await flush();
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a wake the owner's broker delivered for a held send is not repeated by its backup poll for the child's queued sends (#4401)", async () => {
		useFakeClock();
		const shared = await cluster();
		const ownerNode = await startNode(shared);
		const { senderNode, owner, sender, child } = await ownerSenderAndChild(shared, ownerNode);
		senderNode.router.routeSend(remoteSend(sender, CHILD, true).request);
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "send_held");
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		await enqueueFor(ownerNode, child);
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	function closedGate(): { readonly gate: Promise<void>; open(): void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		return { gate: promise, open: () => resolve() };
	}

	async function ownerAndChildWithQueuedSends(node: Node) {
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		await enqueueFor(node, child);
		return { owner, child };
	}

	test("a backup poll waits behind a reserve of the same child that is still checking, so the owner is asked once (#4401)", async () => {
		useFakeClock();
		const listing = closedGate();
		const node = await startNode(await cluster(), { heldListGate: listing.gate });
		const { owner, child } = await ownerAndChildWithQueuedSends(node);
		reserveReleased(node, owner, child);
		await flush();
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		listing.open();
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("a backup poll queued behind a reserve whose owner left meanwhile asks for nothing and reports no error (#4401)", async () => {
		useFakeClock();
		const listing = closedGate();
		const node = await startNode(await cluster(), { heldListGate: listing.gate });
		const { owner, child } = await ownerAndChildWithQueuedSends(node);
		reserveReleased(node, owner, child);
		await flush();
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		leave(node, owner);
		await flush();
		listing.open();
		await flush();
		assert.deepEqual(wakeFramesOf(owner), []);
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("a held-send listing the store cannot read still lets queued sends wake the child (#4401)", async () => {
		const node = await startNode(await cluster(), { heldListInvalid: true });
		const { owner, child } = await ownerAndChildWithQueuedSends(node);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("an outbox listing the store cannot read wakes nothing and reports no error (#4401)", async () => {
		const node = await startNode(await cluster(), { undeliveredListInvalid: true });
		const { owner, child } = await ownerAndChildWithQueuedSends(node);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("an empty alias is skipped and the child's other ids still wake it (#4401)", async () => {
		const node = await startNode(await cluster());
		const { owner, child } = await ownerAndChildWithQueuedSends(node);
		reserveReleased(node, owner, child, { aliases: ["", child.info.id] });
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("sends queued for a session named after the child's id do not wake the child (#4401)", async () => {
		const node = await startNode(await cluster());
		const owner = session("owner");
		await register(node, owner);
		const child = await releasedChild(node);
		const impostor = await releasedChild(node, child.info.id);
		await enqueueFor(node, impostor);
		reserveReleased(node, owner, child);
		await flush();
		assert.deepEqual(node.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a wake the hold path delivered while the reserve's own check was reading is not asked for again (#4401)", async () => {
		const listing = closedGate();
		const shared = await cluster();
		const ownerNode = await startNode(shared, { heldListGate: listing.gate });
		const { senderNode, owner, sender } = await ownerSenderAndChild(shared, ownerNode);
		senderNode.router.routeSend(remoteSend(sender, CHILD, true).request);
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "send_held");
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		listing.open();
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		assert.deepEqual(ownerNode.spied.requestWakeCalls, []);
	});

	test("a store stalled across backup polls gets one wake check per reservation, not one per poll (#4401)", async () => {
		useFakeClock();
		const listing = closedGate();
		const node = await startNode(await cluster(), { heldListGate: listing.gate });
		const owner = session("owner");
		await register(node, owner);
		const children = ["first", "second", "third"];
		for (const name of children) {
			node.router.restoringReserved(releasedReservationKey(name), owner.info.id, name, CREW, [], true, {
				wake: true,
			});
		}
		await flush();
		assert.equal(node.spied.heldListCalls, children.length, "each reserve's check is stalled in the store");

		const stalledPolls = 4;
		await vi.advanceTimersByTimeAsync(stalledPolls * OUTBOX_BACKUP_POLL_INTERVAL_MS);
		listing.open();
		await flush();
		assert.equal(node.spied.heldListCalls, 2 * children.length, "one queued poll check per reservation");

		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.equal(node.spied.heldListCalls, 3 * children.length, "the next poll checks each reservation again");
	});

	test("overlapping owner and sender checks wake one held send once, and a later send after re-release wakes again (#4488)", async () => {
		const heldWrite = closedGate();
		const ownerListing = closedGate();
		const senderRead = closedGate();
		const shared = await cluster();
		const ownerNode = await startNode(shared, { heldListGate: ownerListing.gate });
		const senderNode = await startNode(shared, { holdGate: heldWrite.gate });
		const owner = session("owner");
		const sender = session("sender");
		ownerNode.sessions.set(owner.info.id, owner);
		senderNode.sessions.set(sender.info.id, sender);
		const manager = SessionManager.inMemory("/work");
		owner.info.id = manager.getSessionId();
		ownerNode.sessions.clear();
		ownerNode.sessions.set(owner.info.id, owner);
		await manager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			version: 1,
			childId: "run:0",
			runId: "run",
			index: 0,
			agent: "worker",
			cwd: "/work",
			state: "terminal",
			terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
			owner: { kind: "session", sessionId: owner.info.id },
			intercomTarget: "child",
		});
		const dispatcher = new AgentWakeDispatcher();
		const restoring = closedGate();
		let restores = 0;
		const stop = handleReleasedChildWakes(
			{ sessionManager: manager } as unknown as ExtensionContext,
			{
				wake: async () => {
					restores++;
					await restoring.gate;
				},
				hold: async () => {},
			},
			dispatcher,
		);
		cleanups.push(async () => {
			restoring.open();
			stop();
		});
		const deliveries: Promise<void>[] = [];
		const frames = framesOf(owner);
		const push = frames.push.bind(frames);
		vi.spyOn(frames, "push").mockImplementation((...notices) => {
			for (const notice of notices)
				if (notice.type === "restoring_recipient_wake") {
					deliveries.push(
						dispatcher.deliver(subagentWakeKey(owner.info.id, "run:0"), {
							id: `intercom:${randomUUID()}`,
							kind: "intercom",
						}),
					);
				}
			return push(...notices);
		});
		const key = releasedReservationKey("child");
		reserve(ownerNode, key, owner, false);
		await flush();
		const first = remoteSend(sender, "child", true);
		senderNode.router.routeSend(first.request);
		await flush();
		reserve(ownerNode, key, owner, true);
		await flush();
		const read = senderNode.state.reservations.read;
		vi.spyOn(senderNode.state.reservations, "read").mockImplementationOnce(async (reservationKey) => {
			const answer = await read(reservationKey);
			assert.equal(answer.status === "active" && answer.reservation.wake, true);
			await senderRead.gate;
			return answer;
		});
		heldWrite.open();
		await flush();
		ownerListing.open();
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1, "owner found the held send first");
		senderRead.open();
		await flush();
		assert.equal(wakeFramesOf(owner).length, 1, "the sender's delayed answer must not restore it twice");
		assert.equal(restores, 1, "only one restore starts while its run is pending");
		restoring.open();
		await Promise.all(deliveries);
		assert.equal(restores, 1, "no duplicate restore runs after the first re-releases");

		await senderNode.state.heldSends.drop(first.id);
		reserve(ownerNode, key, owner, false);
		await flush();
		reserve(ownerNode, key, owner, true);
		await flush();
		senderNode.router.routeSend(remoteSend(sender, "child", true).request);
		await flush();
		assert.equal(wakeFramesOf(owner).length, 2, "a new send after re-release must still wake");
		await Promise.all(deliveries);
		assert.equal(restores, 2, "the later send restores the re-released child");
	});

	/** A send its broker routed to the child's live presence; the broker writes its row only once `written` opens. */
	function routeToPresence(senderNode: Node, sender: BrokerConnectedSession, target = CHILD): string {
		const send = remoteSend(sender, target, true);
		senderNode.router.routeSend(send.request);
		return send.id;
	}

	/**
	 * An owner and a sender on brokers of their own, and a live child its owner reserved as released on the owner's
	 * broker: the sender's broker writes outbox rows only once `written` opens.
	 */
	async function liveReleasedChild(options: { readonly wake?: boolean; readonly aliases?: readonly string[] } = {}) {
		const shared = await cluster();
		const written = closedGate();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared, { enqueueGate: written.gate });
		const owner = session("owner");
		const sender = session("sender");
		const child = session(CHILD);
		await register(ownerNode, owner);
		await register(senderNode, sender);
		await register(ownerNode, child);
		reserveReleased(ownerNode, owner, child, options);
		await flush();
		return { shared, written, ownerNode, senderNode, owner, sender, child };
	}

	test("a send routed to a released child's presence but written only after its departure looked for waiting sends wakes the child at once, not at the next backup poll, and reaches it once (#4512)", async () => {
		useFakeClock();
		const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
		const id = routeToPresence(senderNode, sender);
		await flush();
		leave(ownerNode, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [], "the departure looked before the send was written");

		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		assert.deepEqual(senderNode.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE], "the owner's backup poll does not wake it again");

		const back = await wakeAndRegister(ownerNode, owner, child);
		assert.deepEqual(messageIdsOf(back), [id]);
		await receiveAll(ownerNode, back, [id]);
		assert.deepEqual(await rowStates(ownerNode, [id]), ["delivered"]);
		assert.equal(framesOf(sender).at(-1)?.type, "delivered");
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("a send written after a released child left another broker wakes it at once when the sender's broker is its owner's (#4512)", async () => {
		useFakeClock();
		const shared = await cluster();
		const written = closedGate();
		const ownerNode = await startNode(shared, { enqueueGate: written.gate });
		const childNode = await startNode(shared);
		const owner = session("owner");
		const sender = session("sender");
		const child = session(CHILD);
		await register(ownerNode, owner);
		await register(ownerNode, sender);
		await register(childNode, child);
		reserveReleased(ownerNode, owner, child);
		await flush();
		const id = routeToPresence(ownerNode, sender);
		await flush();
		leave(childNode, child);
		await flush();
		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		assert.deepEqual(ownerNode.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);

		const back = await wakeAndRegister(childNode, owner, child);
		assert.deepEqual(messageIdsOf(back), [id]);
	});

	for (const [kind, aliasesOf] of [
		["Intercom session id", (child: BrokerConnectedSession) => [child.info.id]],
		["Atomic session id", (child: BrokerConnectedSession) => [child.registrationReturnAddress ?? ""]],
	] as const) {
		test(`a send written after its departure wakes a released child reserved under its ${kind} alone (#4512)`, async () => {
			const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
			reserveReleased(ownerNode, owner, child, { aliases: aliasesOf(child) });
			await flush();
			routeToPresence(senderNode, sender);
			await flush();
			leave(ownerNode, child);
			await flush();
			written.open();
			await flush();
			assert.deepEqual(wakeFramesOf(owner), [WAKE]);
			assert.deepEqual(senderNode.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		});
	}

	test("a send written after its departure wakes a released child that registered without a return address (#4512)", async () => {
		const shared = await cluster();
		const written = closedGate();
		const ownerNode = await startNode(shared);
		const senderNode = await startNode(shared, { enqueueGate: written.gate });
		const owner = session("owner");
		const sender = session("sender");
		const child: BrokerConnectedSession = { ...session(CHILD), registrationReturnAddress: undefined };
		await register(ownerNode, owner);
		await register(senderNode, sender);
		await register(ownerNode, child);
		reserveReleased(ownerNode, owner, child, { aliases: [child.info.id] });
		await flush();
		routeToPresence(senderNode, sender);
		await flush();
		leave(ownerNode, child);
		await flush();
		written.open();
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("a send written after its departure does not wake a parked child; making it wakeable does, once (#4512)", async () => {
		const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild({ wake: false });
		routeToPresence(senderNode, sender);
		await flush();
		leave(ownerNode, child);
		await flush();
		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(senderNode.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);

		reserveReleased(ownerNode, owner, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});

	test("sends from two brokers written after the departure wake the child once, and reach it once each, in order (#4512)", async () => {
		const { shared, written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
		const secondWritten = closedGate();
		const secondNode = await startNode(shared, { enqueueGate: secondWritten.gate });
		const secondSender = session("second-sender");
		await register(secondNode, secondSender);
		const first = routeToPresence(senderNode, sender);
		const second = routeToPresence(secondNode, secondSender);
		await flush();
		leave(ownerNode, child);
		await flush();
		written.open();
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
		secondWritten.open();
		await flush();
		assert.equal(framesOf(secondSender).at(-1)?.type, "queued");
		assert.deepEqual(secondNode.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		assert.deepEqual(wakeFramesOf(owner), [WAKE], "the second sender's broker claims the send the first woke it for");

		const back = await wakeAndRegister(ownerNode, owner, child);
		assert.deepEqual(messageIdsOf(back), [first, second]);
		await receiveAll(ownerNode, back, [first, second]);
		assert.deepEqual(await rowStates(ownerNode, [first, second]), ["delivered", "delivered"]);
	});

	test("a send written after its departure does not wake a child its owner's broker already woke, and matches it only by the ids its owner reserved (#4512)", async () => {
		const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
		const impostor = session("impostor");
		impostor.info.id = CHILD;
		await register(senderNode, impostor);
		leave(senderNode, impostor);
		await flush();
		await enqueueFor(ownerNode, impostor);
		const earlier = await enqueueFor(ownerNode, child);
		const id = routeToPresence(senderNode, sender);
		await flush();
		leave(ownerNode, child);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE], "the departure found the message written to the child earlier");
		written.open();
		await flush();
		assert.deepEqual(senderNode.spied.requestWakeCalls, [releasedReservationKey(CHILD)]);
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);

		const back = await wakeAndRegister(ownerNode, owner, child);
		assert.deepEqual(messageIdsOf(back), [...earlier, id]);
	});

	test("a send to a session whose id is a released child's name, written after that session left, does not wake the child (#4512)", async () => {
		const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
		leave(ownerNode, child);
		await flush();
		const namesake = session("namesake");
		namesake.info.id = CHILD;
		await register(ownerNode, namesake);
		routeToPresence(senderNode, sender, CHILD);
		await flush();
		leave(ownerNode, namesake);
		await flush();
		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(senderNode.spied.requestWakeCalls, []);
		assert.deepEqual(wakeFramesOf(owner), []);
	});

	test("a send written after an unreserved recipient without a return address left is queued without asking for a wake (#4512)", async () => {
		const shared = await cluster();
		const written = closedGate();
		const recipientNode = await startNode(shared);
		const senderNode = await startNode(shared, { enqueueGate: written.gate });
		const sender = session("sender");
		const recipient: BrokerConnectedSession = { ...session(CHILD), registrationReturnAddress: undefined };
		await register(senderNode, sender);
		await register(recipientNode, recipient);
		routeToPresence(senderNode, sender);
		await flush();
		leave(recipientNode, recipient);
		await flush();
		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(senderNode.spied.requestWakeCalls, []);
		assert.equal(vi.mocked(console.error).mock.calls.length, 0);
	});

	test("a reservation read that fails on the sender's broker is reported, and the send stays queued for the owner's backup poll (#4512)", async () => {
		useFakeClock();
		const { written, ownerNode, senderNode, owner, sender, child } = await liveReleasedChild();
		vi.spyOn(senderNode.state.reservations, "lookup").mockRejectedValueOnce(new Error("reservations unreadable"));
		routeToPresence(senderNode, sender);
		await flush();
		leave(ownerNode, child);
		await flush();
		written.open();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(wakeFramesOf(owner), []);
		assert.deepEqual(vi.mocked(console.error).mock.calls, [["Intercom multi-node routing: reservations unreadable"]]);

		await vi.advanceTimersByTimeAsync(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await flush();
		assert.deepEqual(wakeFramesOf(owner), [WAKE]);
	});
});

describe("an Intercom id bound to the return address that registered it", () => {
	const granted = (claim: SessionIdClaim): boolean => claim.status === "granted";

	/** A claim of `id` granted to `returnAddress`, whose registration then left again, giving the id up (#5607). */
	async function claimedAndLeft(node: Node, id: string, returnAddress: string): Promise<void> {
		const claimed = await node.router.claimSessionId(id, returnAddress);
		assert.ok(claimed.status === "granted", "granted");
		await node.router.releaseOwner({ intercomSessionId: id, token: claimed.grant.token });
	}

	/** A session on another broker registering under `original`'s id with a return address of its own. */
	function underTheSameId(original: BrokerConnectedSession): BrokerConnectedSession {
		const other = session("other");
		return { ...other, info: { ...other.info, id: original.info.id } };
	}

	/** `original` registered on `node` and is away; a sender on a second broker. */
	async function awaySessionAndSender(shared: Cluster) {
		const home = await startNode(shared);
		const original = session("original");
		home.sessions.set(original.info.id, original);
		await home.router.sessionRegistered(original);
		home.sessions.delete(original.info.id);
		home.router.sessionLeft(original, undefined, false);
		await flush();
		const senderNode = await startNode(shared);
		const sender = session("sender");
		senderNode.sessions.set(sender.info.id, sender);
		await senderNode.router.sessionRegistered(sender);
		return { home, original, senderNode, sender };
	}

	async function queuedFor(node: Node, target: BrokerConnectedSession): Promise<string[]> {
		const rows = await node.state.outbox.listUndelivered(deliveryTargetIdentity(target));
		if (rows.status !== "listed") throw new Error(`the outbox did not list: ${rows.reason}`);
		return rows.rows.map((row) => row.messageId);
	}

	test("a session registered under an id bound to another return address is not routed to by that id", async () => {
		const shared = await cluster();
		const { original, senderNode, sender } = await awaySessionAndSender(shared);
		const elsewhere = await startNode(shared);
		const other = underTheSameId(original);
		elsewhere.sessions.set(other.info.id, other);
		await elsewhere.router.sessionRegistered(other);

		const send = remoteSend(sender, original.info.id, false);
		senderNode.router.routeSend(send.request);
		await flush();
		assert.deepEqual(await queuedFor(senderNode, other), []);
		assert.deepEqual(await queuedFor(senderNode, original), [send.id]);
	});

	/** What a broker that grants ids without binding them shares for `other`: its presence and known-session record. */
	async function sharedByAnUnbindingBroker(node: Node, other: BrokerConnectedSession): Promise<void> {
		const taken = await node.state.leases.acquire(
			{ kind: "presence", targetIdentity: deliveryTargetIdentity(other), session: other.info },
			"unbinding-broker",
			BROKER_LEASE_STALE_AFTER_MS,
		);
		assert.equal(taken.status, "acquired");
		await node.state.knownSessions.record({
			targetIdentity: deliveryTargetIdentity(other),
			intercomSessionId: other.info.id,
			name: other.info.name,
			atomicSessionId: other.registrationReturnAddress,
			group: CREW,
			groups: [CREW],
		});
	}

	test("a session refused its id holds no presence and no record under it, also once it updates and its broker renews", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const shared = await cluster();
		const { original, senderNode } = await awaySessionAndSender(shared);
		const elsewhere = await startNode(shared);
		const other = underTheSameId(original);
		elsewhere.sessions.set(other.info.id, other);
		await elsewhere.router.sessionRegistered(other);
		elsewhere.router.sessionUpdated(other);
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_RENEW_INTERVAL_MS);
		await flush();

		const present = await senderNode.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS);
		const presentIdentities = present.map((lease) => (lease.subject as RecipientPresenceSubject).targetIdentity);
		assert.equal(presentIdentities.includes(deliveryTargetIdentity(other)), false);
		const known = await senderNode.state.knownSessions.lookup(original.info.id, KNOWN_SESSION_RETENTION_MS);
		assert.deepEqual(known.status === "found" ? known.sessions.map((record) => record.targetIdentity) : known, [
			deliveryTargetIdentity(original),
		]);
	});

	test("a session refused its id leaving does not end the asks of the session the id is bound to", async () => {
		const shared = await cluster();
		const { original, senderNode, sender } = await awaySessionAndSender(shared);
		const askId = randomUUID();
		await senderNode.state.pendingAsks.record({
			senderSessionId: original.info.id,
			targetSessionId: sender.info.id,
			messageId: askId,
		});
		const elsewhere = await startNode(shared);
		const other = underTheSameId(original);
		elsewhere.sessions.set(other.info.id, other);
		await elsewhere.router.sessionRegistered(other);
		elsewhere.sessions.delete(other.info.id);
		elsewhere.router.sessionLeft(other, undefined, true);
		await flush();

		const route = { replySenderSessionId: sender.info.id, replyTargetSessionId: original.info.id, replyTo: askId };
		assert.equal((await senderNode.state.pendingAsks.matchesReply(route)).status, "match");
	});

	test("an ask's failure goes to the session its asker's id is bound to, not a presence taken under that id", async () => {
		const shared = await cluster();
		const { original, senderNode, sender } = await awaySessionAndSender(shared);
		const askId = randomUUID();
		await senderNode.state.pendingAsks.record({
			senderSessionId: original.info.id,
			targetSessionId: sender.info.id,
			messageId: askId,
		});
		const other = underTheSameId(original);
		await sharedByAnUnbindingBroker(senderNode, other);
		senderNode.sessions.delete(sender.info.id);
		senderNode.router.sessionLeft(sender, undefined, true);
		await flush();

		assert.deepEqual(await queuedFor(senderNode, other), []);
		assert.deepEqual(await queuedFor(senderNode, original), [`ended:${askId}`]);
	});

	test("a record under an id bound to another return address is not resolved by its name either", async () => {
		const shared = await cluster();
		const { original, senderNode, sender } = await awaySessionAndSender(shared);
		const other = underTheSameId(original);
		await sharedByAnUnbindingBroker(senderNode, other);
		await senderNode.state.leases.release(
			(await senderNode.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS)).find(
				(lease) => (lease.subject as RecipientPresenceSubject).targetIdentity === deliveryTargetIdentity(other),
			)!,
		);

		const send = remoteSend(sender, "other", false);
		senderNode.router.routeSend(send.request);
		await flush();
		assert.deepEqual(await queuedFor(senderNode, other), []);
	});

	test("a broker grants a requested id only after binding it to the same return address, and never unchecked", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		await claimedAndLeft(node, id, "return-1");
		assert.equal(granted(await node.router.claimSessionId(id, "return-2")), false);
		await claimedAndLeft(node, id, "return-1");

		const bind = vi.spyOn(node.state.knownSessions, "bind");
		bind.mockRejectedValueOnce(new Error("the shared database is down"));
		assert.equal(granted(await node.router.claimSessionId(id, "return-1")), false, "a failed binding grants nothing");
		bind.mockReturnValueOnce(new Promise(() => {}));
		const claim = node.router.claimSessionId(id, "return-1");
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal(granted(await claim), false, "a binding that does not answer in time grants nothing");

		await node.router.close();
		assert.equal(granted(await node.router.claimSessionId(id, "return-1")), false, "a closed router grants nothing");
	});

	test("an expired claim does not bind an unused id while its confirmation is pending (#5607)", async () => {
		const node = await startNode(await cluster());
		const id = randomUUID();
		await claimedAndLeft(node, id, "return-1");
		const knownSessions = node.state.knownSessions;
		const bind = knownSessions.bind.bind(knownSessions);
		const requests = vi.spyOn(knownSessions, "bind").mockImplementationOnce(async (...args) => {
			await databaseAnswer();
			return bind(...args);
		});

		const claim = node.router.claimSessionId(id, "return-1");
		// The database answers at once, but this broker does not run for longer than the claim may wait.
		stallEventLoop(SESSION_ID_CLAIM_BOUND_MS + STALL_PAST_BOUND_MS);

		await claim;
		assert.deepEqual(
			requests.mock.calls.map(([sessionId]) => sessionId),
			[id],
		);
	});

	test("a returning session keeps its id when its binding is confirmed just before the deadline (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		await claimedAndLeft(node, id, "return-1");
		const knownSessions = node.state.knownSessions;
		const bind = knownSessions.bind.bind(knownSessions);
		let answer!: () => void;
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		vi.spyOn(knownSessions, "bind").mockImplementationOnce(async (...args) => {
			const binding = await bind(...args);
			await answered;
			return binding;
		});

		const claim = node.router.claimSessionId(id, "return-1");
		let grantedId: boolean | undefined;
		void claim.then((result) => {
			grantedId = granted(result);
		});
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS - 1);
		assert.equal(grantedId, undefined);
		answer();
		assert.equal(granted(await claim), true);
	});

	test("an ended session's unanswered presence check expires on the first turn after its wall-clock deadline (#5607)", async () => {
		const node = await startNode(await cluster());
		vi.spyOn(node.state.leases, "read").mockReturnValueOnce(new Promise(() => {}));
		const present = node.router.identityPresentElsewhere(deliveryTargetIdentity(session("ended")));
		// The broker can't dispatch the two-second remote-session deadline during the stall.
		stallEventLoop(2_200);
		assert.equal(
			await Promise.race([present, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 30))]),
			false,
		);
	});

	/** `session` registered live on `node` under its id and return address. */
	async function registeredLive(node: Node, target: BrokerConnectedSession): Promise<void> {
		node.sessions.set(target.info.id, target);
		await node.router.sessionRegistered(target);
		await flush();
	}

	test("a session that registers again while another live registration of it holds its id gets a fresh id (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const shared = await cluster();
		const [first, second] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredLive(first, live);

		const claim = second.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);

		assert.equal(granted(await claim), false, "one live registration per id");
	});

	test("a session gets its id back on another broker at once once its registration there left (#5607)", async () => {
		const shared = await cluster();
		const [first, second] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredLive(first, live);
		first.sessions.delete(live.info.id);
		first.router.sessionLeft(live, undefined, false);
		await flush();

		assert.equal(granted(await second.router.claimSessionId(live.info.id, live.registrationReturnAddress!)), true);
	});

	test("a session gets its id back while its earlier registration's broker is still giving it up, within the claim's wait (#5607)", async () => {
		const shared = await cluster();
		const [first, second] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredLive(first, live);
		const owners = first.state.knownSessions.owners!;
		const release = owners.release.bind(owners);
		const released = Promise.withResolvers<void>();
		vi.spyOn(owners, "release").mockImplementationOnce(async (ownership) => {
			await released.promise;
			return release(ownership);
		});
		first.sessions.delete(live.info.id);
		first.router.sessionLeft(live, undefined, false);
		await flush();

		const claim = second.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		await new Promise((resolve) => setTimeout(resolve, 120));
		released.resolve();

		assert.equal(granted(await claim), true);
	});

	test("an id whose owning broker stopped renewing it is free once its owner went stale, not before (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
		const shared = await cluster();
		const [first, second] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredLive(first, live);
		// Its broker stops, as a crashed one does: nothing renews or releases what it owned.
		vi.spyOn(first.state.knownSessions.owners!, "renew").mockReturnValue(new Promise(() => {}));

		const early = second.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal(granted(await early), false);
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS);
		const late = second.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal(granted(await late), true);
	});

	test("an owner kept renewed by its live registration's broker keeps its id past the stale age (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
		const shared = await cluster();
		const [first, second] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredLive(first, live);
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS * 2);

		const claim = second.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal(granted(await claim), false);
	});

	/**
	 * A claim of `id` whose binding the database writes but whose answer the broker never reads in time: the broker stalled
	 * past the claim's deadline.
	 */
	async function unansweredClaim(node: Node, id: string, returnAddress: string): Promise<UnansweredSessionIdClaim> {
		const knownSessions = node.state.knownSessions;
		const bind = knownSessions.bind.bind(knownSessions);
		vi.spyOn(knownSessions, "bind").mockImplementationOnce(async (...args) => {
			await bind(...args);
			return new Promise<never>(() => {});
		});
		const pending = node.router.claimSessionId(id, returnAddress);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		const claim = await pending;
		assert.equal(claim.status, "unanswered");
		vi.mocked(knownSessions.bind).mockRestore();
		return (claim as Extract<SessionIdClaim, { status: "unanswered" }>).unanswered;
	}

	/**
	 * Registers the returning session as the broker does for an unanswered claim: under a fresh id, not yet shown on this
	 * broker, until the binding write settles it once under the claimed id or the fresh one.
	 */
	function registerUnanswered(node: Node, claim: UnansweredSessionIdClaim, returnAddress: string, answered = false) {
		const freshId = randomUUID();
		const base = session("returning");
		const target: BrokerConnectedSession = {
			...base,
			info: { ...base.info, id: freshId },
			registrationReturnAddress: returnAddress,
		};
		const settles: boolean[] = [];
		let settled = answered;
		if (answered) node.sessions.set(freshId, target);
		const registered = node.router.sessionRegistered(target, undefined, {
			...claim,
			settle: (keep) => {
				if (settled) return false;
				settled = true;
				settles.push(keep);
				const kept = keep && !node.sessions.has(claim.sessionId);
				if (kept) target.info.id = claim.sessionId;
				node.sessions.set(target.info.id, target);
				return kept;
			},
			unsettled: () => !settled,
		});
		return { target, freshId, settles, registered };
	}

	test("an id an unanswered claim took is given back when its registration does not keep it (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");

		// Answered meanwhile: the session keeps the fresh id its registration was answered with.
		const back = registerUnanswered(node, claim, "return-1", true);
		await back.registered;

		assert.equal(back.target.info.id, back.freshId);
		const again = node.router.claimSessionId(id, "return-1");
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal(granted(await again), true, "nothing still owns it");
	});

	test("a returning session whose claim went unanswered keeps the id when the binding is still the one its claim wrote (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");

		const back = registerUnanswered(node, claim, "return-1");
		await back.registered;

		assert.deepEqual(back.settles, [true]);
		assert.equal(back.target.info.id, id);
		const known = await node.state.knownSessions.lookup(id, KNOWN_SESSION_RETENTION_MS);
		assert.deepEqual(known.status === "found" ? known.sessions.map((record) => record.intercomSessionId) : known, [
			id,
		]);
		assert.deepEqual(await node.state.knownSessions.binding(back.freshId, KNOWN_SESSION_RETENTION_MS), {
			status: "unbound",
		});
	});

	test("a returning session whose claim went unanswered gets its fresh id, bound, when another registration of it claimed the id since (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");
		await node.state.knownSessions.bind(id, "return-1", KNOWN_SESSION_RETENTION_MS, randomUUID());

		const back = registerUnanswered(node, claim, "return-1");
		await back.registered;

		assert.deepEqual(back.settles, [false]);
		assert.equal(back.target.info.id, back.freshId);
		assert.deepEqual(await node.state.knownSessions.binding(back.freshId, KNOWN_SESSION_RETENTION_MS), {
			status: "bound",
			returnAddress: "return-1",
		});
	});

	test("a returning session whose claim went unanswered gets its fresh id when a session here holds the claimed id (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");
		const holder = session("holder");
		node.sessions.set(id, { ...holder, info: { ...holder.info, id } });

		const back = registerUnanswered(node, claim, "return-1");
		await back.registered;

		assert.deepEqual(back.settles, [true], "the write kept it, but the broker cannot give it");
		assert.equal(back.target.info.id, back.freshId);
		assert.deepEqual(await node.state.knownSessions.binding(back.freshId, KNOWN_SESSION_RETENTION_MS), {
			status: "bound",
			returnAddress: "return-1",
		});
	});

	test("a returning session answered before its binding write decided stays under its fresh id, bound as before (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");
		const reclaim = vi.spyOn(node.state.knownSessions, "reclaim");

		const back = registerUnanswered(node, claim, "return-1", true);
		await back.registered;

		assert.deepEqual(back.settles, []);
		assert.equal(reclaim.mock.calls.length, 0, "no write tries to keep an id it can no longer give");
		assert.deepEqual(await node.state.knownSessions.binding(back.freshId, KNOWN_SESSION_RETENTION_MS), {
			status: "bound",
			returnAddress: "return-1",
		});
	});

	test("a store that cannot reclaim registers a session whose claim went unanswered under its fresh id, bound as before (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		const claim = await unansweredClaim(node, id, "return-1");
		Reflect.deleteProperty(node.state.knownSessions, "reclaim");

		const back = registerUnanswered(node, claim, "return-1");
		await back.registered;

		assert.deepEqual(back.settles, [false]);
		assert.equal(back.target.info.id, back.freshId);
		assert.deepEqual(await node.state.knownSessions.binding(back.freshId, KNOWN_SESSION_RETENTION_MS), {
			status: "bound",
			returnAddress: "return-1",
		});
	});

	test("a database that does not answer still ends the claim of a broker that keeps running late, with a fresh id (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const node = await startNode(await cluster());
		const id = randomUUID();
		await claimedAndLeft(node, id, "return-1");
		vi.spyOn(node.state.knownSessions, "bind").mockReturnValueOnce(new Promise(() => {}));

		const claim = node.router.claimSessionId(id, "return-1");
		let grantedId: boolean | undefined;
		void claim.then((result) => {
			grantedId = granted(result);
		});
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS - 100);
		// From here every tick of the broker comes late: it is slow, not stalled once, and the claim must not wait for good.
		for (let tick = 0; tick < 2 && grantedId === undefined; tick++) {
			stallEventLoop(STALL_PAST_BOUND_MS / 5);
			await vi.advanceTimersByTimeAsync(100);
		}

		assert.equal(grantedId, false, "a late broker still ends an unanswered claim");
	});

	test("a presence taken under an id bound to another return address is not routed to by that id", async () => {
		const shared = await cluster();
		const { original, senderNode, sender } = await awaySessionAndSender(shared);
		// A broker that grants ids without binding them took a presence under the id.
		const other = underTheSameId(original);
		const taken = await senderNode.state.leases.acquire(
			{ kind: "presence", targetIdentity: deliveryTargetIdentity(other), session: other.info },
			"unbinding-broker",
			BROKER_LEASE_STALE_AFTER_MS,
		);
		assert.equal(taken.status, "acquired");

		const send = remoteSend(sender, original.info.id, false);
		senderNode.router.routeSend(send.request);
		await flush();
		assert.deepEqual(await queuedFor(senderNode, other), []);
		assert.deepEqual(await queuedFor(senderNode, original), [send.id]);
	});
});

describe("a send racing its recipient's clean quit", () => {
	test("a claim that reaches the database only after its recipient quit is handed back as never claimed, so the send is queued for the recipient's return at once and delivered to it once", async () => {
		const shared = await cluster();
		const claimLands = Promise.withResolvers<void>();
		const presenceReleased = Promise.withResolvers<void>();
		const senderNode = await startNode(shared);
		const recipientNode = await startNode(shared, {
			claimGate: claimLands.promise,
			presenceReleaseGate: presenceReleased.promise,
		});
		const sender = session("sender");
		senderNode.sessions.set(sender.info.id, sender);
		await senderNode.router.sessionRegistered(sender);
		const recipient = session("recipient");
		recipientNode.sessions.set(recipient.info.id, recipient);
		// Its broker looks for rows to deliver to it as it registers; that claim is still on its way to the database.
		await recipientNode.router.sessionRegistered(recipient);
		await flush();

		// It quits cleanly. Its presence is still live while its broker cleans up after it.
		recipientNode.sessions.delete(recipient.info.id);
		recipientNode.router.sessionLeft(recipient);
		await flush();
		const send = remoteSend(sender, "recipient", false);
		senderNode.router.routeSend(send.request);
		await flush();
		assert.equal(await queuedRowCount(senderNode, recipient), 1, "routed to its live presence and written");

		// The claim lands after the row was written, for a recipient its broker no longer has; then its presence goes.
		claimLands.resolve();
		await flush();
		presenceReleased.resolve();
		const outcomes = () =>
			framesOf(sender).flatMap((frame) =>
				frame.type === "queued"
					? [["queued", frame.messageId, frame.target]]
					: frame.type === "delivery_failed"
						? [["failed", frame.messageId, frame.reason]]
						: [],
			);
		// Well within the receipt wait, which would otherwise end with the outcome reported uncertain.
		await vi.waitFor(() => assert.deepEqual(outcomes(), [["queued", send.id, "offline session"]]), {
			timeout: 2_000,
			interval: 10,
		});

		const back: BrokerConnectedSession = { ...recipient, info: { ...recipient.info }, socket: fakeSocket() };
		recipientNode.sessions.set(back.info.id, back);
		await recipientNode.router.sessionRegistered(back);
		await vi.waitFor(() =>
			assert.deepEqual(
				framesOf(back).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : [])),
				[send.id],
			),
		);
	});
});

async function queuedRowCount(node: Node, target: BrokerConnectedSession): Promise<number> {
	const listed = await node.state.outbox.listUndelivered(deliveryTargetIdentity(target));
	return listed.status === "listed" ? listed.rows.length : 0;
}

describe("a row queued for an offline session that registered meanwhile (#5607)", () => {
	/** `original` registered on `home` and is away; a sender on a broker whose outbox writes wait for `written`. */
	async function awayRecipientAndGatedSender(shared: Cluster) {
		const written = Promise.withResolvers<void>();
		const home = await startNode(shared);
		const original = session("original");
		home.sessions.set(original.info.id, original);
		await home.router.sessionRegistered(original);
		home.sessions.delete(original.info.id);
		home.router.sessionLeft(original, undefined, false);
		await flush();
		const senderNode = await startNode(shared, { enqueueGate: written.promise });
		const sender = session("sender");
		senderNode.sessions.set(sender.info.id, sender);
		await senderNode.router.sessionRegistered(sender);
		await flush();
		return { home, original, senderNode, sender, written };
	}

	/** `original` registers again on `node`; its broker looks for what was queued for it as it registers. */
	async function comesBack(node: Node, original: BrokerConnectedSession): Promise<BrokerConnectedSession> {
		const back: BrokerConnectedSession = { ...original, info: { ...original.info }, socket: fakeSocket() };
		node.sessions.set(back.info.id, back);
		await node.router.sessionRegistered(back);
		await flush();
		return back;
	}

	const messageIds = (target: BrokerConnectedSession): string[] =>
		framesOf(target).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));

	beforeEach(() => {
		// The backup poll would deliver the row eventually; these rows must not wait for it.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
	});

	test("a send to an offline session reaches it at once when it registered on another broker before the row was written (#5607)", async () => {
		const { home, original, senderNode, sender, written } = await awayRecipientAndGatedSender(await cluster());
		const send = remoteSend(sender, original.info.id, false);
		senderNode.router.routeSend(send.request);
		await flush();
		const back = await comesBack(home, original);
		assert.deepEqual(messageIds(back), [], "its registration looked before the row was written");

		written.resolve();
		await flush();
		assert.equal(framesOf(sender).at(-1)?.type, "queued");
		assert.deepEqual(messageIds(back), [send.id]);
	});

	test("an ask's failure reaches its offline asker at once when it registered on another broker before the failure was written (#5607)", async () => {
		const { home, original, senderNode, sender, written } = await awayRecipientAndGatedSender(await cluster());
		const askId = randomUUID();
		await senderNode.state.pendingAsks.record({
			senderSessionId: original.info.id,
			targetSessionId: sender.info.id,
			messageId: askId,
		});
		senderNode.sessions.delete(sender.info.id);
		senderNode.router.sessionLeft(sender, undefined, true);
		await flush();
		const back = await comesBack(home, original);
		assert.deepEqual(messageIds(back), [], "its registration looked before the failure was written");

		written.resolve();
		await flush();
		assert.deepEqual(messageIds(back), [`ended:${askId}`]);
	});

	test("a send to an offline session reaches it at once when it registered on the sender's own broker before the row was written (#5607)", async () => {
		const { original, senderNode, sender, written } = await awayRecipientAndGatedSender(await cluster());
		const send = remoteSend(sender, original.info.id, false);
		senderNode.router.routeSend(send.request);
		await flush();
		const back = await comesBack(senderNode, original);
		assert.deepEqual(messageIds(back), []);

		written.resolve();
		await flush();
		assert.deepEqual(messageIds(back), [send.id]);
	});
});

describe("one live registration per Intercom id across brokers (#5607)", () => {
	// The wall clock alone moves a session's id window on: its elapsed time is the larger of the two clocks'.
	const ADVANCE = ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] as const;

	/** Another registration of `original`'s session: the same id and return address, a connection of its own. */
	function twinOf(original: BrokerConnectedSession, name = "twin"): BrokerConnectedSession {
		const twin = session(name);
		return {
			...twin,
			info: { ...twin.info, id: original.info.id },
			registrationReturnAddress: original.registrationReturnAddress!,
		};
	}

	async function registeredOn(node: Node, target: BrokerConnectedSession, grant?: SessionIdGrant): Promise<void> {
		node.sessions.set(target.info.id, target);
		await node.router.sessionRegistered(target, undefined, undefined, grant);
		await flush();
	}

	/** A send from `from` to the session `to` registered on the same broker; `local` counts its local-path answers. */
	function localSend(from: BrokerConnectedSession, to: BrokerConnectedSession) {
		const send = remoteSend(from, to.info.id, false);
		const local = { answers: 0 };
		return { request: { ...send.request, localTarget: to, notFound: () => void local.answers++ }, local };
	}

	/**
	 * `live` registered on `paused`, none of whose renewals then reach the store for longer than the stale age (its
	 * broker is paused), and the same session registered again on `other`, which took the id. Returns the paused broker's
	 * id renewal spy, still failing every renewal, and `resume`, after which its renewals reach the store again.
	 */
	async function tookOverWhilePaused() {
		vi.useFakeTimers({ toFake: [...ADVANCE] });
		const shared = await cluster();
		const [paused, other] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredOn(paused, live);
		const owners = paused.state.knownSessions.owners!;
		const renew = owners.renew.bind(owners);
		const stopped = new Error("the broker is paused");
		const held = vi.spyOn(owners, "renew").mockRejectedValue(stopped);
		const leases = vi.spyOn(paused.state.leases, "renew").mockRejectedValue(stopped);
		const resume = () => leases.mockRestore();
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + BROKER_LEASE_RENEW_INTERVAL_MS);
		const twin = twinOf(live);
		const claimed = other.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(0);
		const claim = await claimed;
		assert.ok(claim.status === "granted", "the id went stale, so the other registration takes it");
		const registered = registeredOn(other, twin, claim.grant);
		await vi.advanceTimersByTimeAsync(PRESENCE_REGISTRATION_BOUND_MS);
		await registered;
		return { paused, other, live, twin, held, renew, resume };
	}

	/**
	 * `live` registered on `stopped`, whose broker then stops (nothing it owns is renewed any more), and the same session,
	 * registered again on `here` under a fresh id while it awaits the one it asked for.
	 */
	async function awaitingWhileStopped() {
		vi.useFakeTimers({ toFake: [...ADVANCE, "performance"] });
		const shared = await cluster();
		const [stopped, here] = [await startNode(shared), await startNode(shared)];
		const live = session("live");
		await registeredOn(stopped, live);
		const halted = new Error("the broker stopped");
		vi.spyOn(stopped.state.knownSessions.owners!, "renew").mockRejectedValue(halted);
		vi.spyOn(stopped.state.leases, "renew").mockRejectedValue(halted);
		const fresh: BrokerConnectedSession = {
			...twinOf(live, "fresh"),
			info: { ...twinOf(live, "fresh").info, id: randomUUID() },
		};
		here.sessions.set(fresh.info.id, fresh);
		const registered = here.router.sessionRegistered(fresh, undefined, undefined, undefined, live.info.id);
		await vi.advanceTimersByTimeAsync(PRESENCE_REGISTRATION_BOUND_MS);
		await registered;
		return { shared, stopped, here, live, fresh };
	}

	test("a session that got a fresh id while a stopped broker still owned the one it asked for takes that id back once that ownership lapses, and keeps the fresh one as an alias (#5607)", async () => {
		const { shared, here, live, fresh } = await awaitingWhileStopped();
		const id = live.info.id;
		const known = await here.state.knownSessions.lookup(id, KNOWN_SESSION_RETENTION_MS);
		assert.deepEqual(
			known.status === "found"
				? known.sessions.map((record) => [record.intercomSessionId, record.aliasSessionId])
				: known,
			[[fresh.info.id, id]],
			"its record names the fresh id and the one it awaits",
		);
		assert.deepEqual(here.fenced, []);

		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 2 * BROKER_LEASE_RENEW_INTERVAL_MS);
		assert.deepEqual(here.fenced, [fresh], "it registers again to take the id back");

		// A client that kept the fresh id asks for that one: it is given the id it awaited, and keeps the fresh one too.
		const claim = await here.router.claimSessionId(
			fresh.info.id,
			fresh.registrationReturnAddress!,
			deliveryTargetIdentity(fresh),
		);
		assert.ok(claim.status === "granted");
		assert.equal(claim.grant.sessionId, id);
		assert.equal(claim.grant.alias, fresh.info.id);
		const back: BrokerConnectedSession = { ...fresh, socket: fakeSocket(), info: { ...fresh.info, id } };
		const again = registeredOn(here, back, claim.grant);
		await vi.advanceTimersByTimeAsync(PRESENCE_REGISTRATION_BOUND_MS);
		await again;
		assert.equal(here.router.aliasTarget(fresh.info.id), back);

		const elsewhere = await startNode(shared);
		const twin = twinOf(back, "twin");
		const taken = elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal((await taken).status, "held", "the id is the session's again, on one registration");
	});

	test("an answer of an earlier attempt that arrives after the session came back under the awaited id leaves that id its own (#5607)", async () => {
		const { shared, here, live, fresh } = await awaitingWhileStopped();
		const id = live.info.id;
		const knownSessions = here.state.knownSessions;
		const bind = knownSessions.bind.bind(knownSessions);
		const late = Promise.withResolvers<void>();
		let delayed = 1;
		vi.spyOn(knownSessions, "bind").mockImplementation(async (...args) => {
			const binding = await bind(...args);
			// The first attempt that takes the awaited id is written, but its answer comes only much later.
			if (args[0] === id && binding.status === "bound" && delayed-- > 0) await late.promise;
			return binding;
		});
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 3 * BROKER_LEASE_RENEW_INTERVAL_MS);
		assert.deepEqual(here.fenced, [fresh], "a later attempt took the id back");
		const claim = await here.router.claimSessionId(
			id,
			fresh.registrationReturnAddress!,
			deliveryTargetIdentity(fresh),
		);
		assert.ok(claim.status === "granted");
		const back: BrokerConnectedSession = { ...fresh, socket: fakeSocket(), info: { ...fresh.info, id } };
		const again = registeredOn(here, back, claim.grant);
		await vi.advanceTimersByTimeAsync(PRESENCE_REGISTRATION_BOUND_MS);
		await again;

		late.resolve();
		await flush();
		const elsewhere = await startNode(shared);
		const twin = twinOf(back, "twin");
		const taken = elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal((await taken).status, "held", "the session that came back still owns the id");
	});

	test("an id taken back for an awaiting session is taken only by a registration of the same identity, and given back unused after a while (#5607)", async () => {
		const { shared, here, live, fresh } = await awaitingWhileStopped();
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_STALE_AFTER_MS + 2 * BROKER_LEASE_RENEW_INTERVAL_MS);
		assert.deepEqual(here.fenced, [fresh]);

		// Another registration of the same session, in another group, does not take what was held for this one.
		const otherGroup = { ...twinOf(live, "other"), registrationGroup: "another group" };
		const other = here.router.claimSessionId(
			live.info.id,
			otherGroup.registrationReturnAddress!,
			deliveryTargetIdentity(otherGroup),
		);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal((await other).status, "held");

		// Nobody registers again to take it: it is given back.
		await vi.advanceTimersByTimeAsync(3 * BROKER_LEASE_RENEW_INTERVAL_MS);
		const elsewhere = await startNode(shared);
		const twin = twinOf(live, "twin");
		const taken = elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal((await taken).status, "granted");
	});

	test("a session registered while routing was opening is disconnected once routing is on, when another broker's live registration owns its id (#5607)", async () => {
		const shared = await cluster();
		const elsewhere = await startNode(shared);
		const live = session("live");
		await registeredOn(elsewhere, live);
		const early = twinOf(live, "early");

		const opening = await startNode(shared, { registeredBefore: [early] });

		await vi.waitFor(() => assert.deepEqual(opening.fenced, [early]), { timeout: 5_000, interval: 10 });
		assert.equal(opening.sessions.has(live.info.id), false);
		assert.deepEqual(elsewhere.fenced, [], "the registration that owns the id keeps it");
		const again = await opening.router.claimSessionId(live.info.id, live.registrationReturnAddress!);
		assert.equal(again.status, "held", "while it is live, the id stays the other registration's");
	});

	test("a session registered while routing was opening keeps its id once routing is on when no other registration owns it (#5607)", async () => {
		const shared = await cluster();
		const early = session("early");

		const opening = await startNode(shared, { registeredBefore: [early] });
		await flush();

		assert.deepEqual(opening.fenced, []);
		const elsewhere = await startNode(shared);
		const twin = twinOf(early);
		const claimed = elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		assert.equal((await claimed).status, "held", "the adopted session owns its id now");
	});

	test("a session whose first binding write failed as routing turned on takes its id at the next renewal, or is disconnected (#5607)", async () => {
		vi.useFakeTimers({ toFake: [...ADVANCE] });
		const shared = await cluster();
		const elsewhere = await startNode(shared);
		const live = session("live");
		await registeredOn(elsewhere, live);
		const early = twinOf(live, "early");
		// The broker that opens next fails its first binding write, then the store answers again.
		const opening = await startNode(
			{
				...shared,
				async connectState() {
					const state = await shared.connectState();
					const bind = state.knownSessions.bind.bind(state.knownSessions);
					let failures = 1;
					state.knownSessions.bind = async (...args) => {
						if (failures-- > 0) throw new Error("the shared database is busy");
						return bind(...args);
					};
					return state;
				},
			},
			{ registeredBefore: [early] },
		);
		assert.deepEqual(opening.fenced, [], "a failed write proves nothing");
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_RENEW_INTERVAL_MS);
		assert.deepEqual(opening.fenced, [early]);
		assert.deepEqual(elsewhere.fenced, []);
	});

	test("a session whose first binding write as routing turned on never answers takes its id with a later one, and its registration completes (#5607)", async () => {
		vi.useFakeTimers({ toFake: [...ADVANCE] });
		const shared = await cluster();
		const early = session("early");
		const opening = await startNode(
			{
				...shared,
				async connectState() {
					const state = await shared.connectState();
					const bind = state.knownSessions.bind.bind(state.knownSessions);
					let lost = 1;
					state.knownSessions.bind = async (...args) =>
						lost-- > 0 ? new Promise<never>(() => {}) : bind(...args);
					return state;
				},
			},
			{ registeredBefore: [early] },
		);
		await vi.advanceTimersByTimeAsync(2 * BROKER_LEASE_RENEW_INTERVAL_MS);

		assert.deepEqual(opening.fenced, []);
		const presence = await opening.state.leases.read({
			kind: "presence",
			targetIdentity: deliveryTargetIdentity(early),
		});
		assert.equal(presence.status, "found", "its registration went on to present it across nodes");
		const elsewhere = await startNode(shared);
		const twin = twinOf(early);
		const claimed = elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.notEqual((await claimed).status, "granted", "the id is the adopted session's");
	});

	test("a session that leaves while its adoption write is on its way gives back the id that write took (#5607)", async () => {
		const shared = await cluster();
		const early = session("early");
		const written = Promise.withResolvers<void>();
		const opening = await startNode(
			{
				...shared,
				async connectState() {
					const state = await shared.connectState();
					const bind = state.knownSessions.bind.bind(state.knownSessions);
					let held = 1;
					state.knownSessions.bind = async (...args) => {
						if (held-- > 0) await written.promise;
						return bind(...args);
					};
					return state;
				},
			},
			{ registeredBefore: [early] },
		);
		opening.sessions.delete(early.info.id);
		opening.router.sessionLeft(early, undefined, false);
		written.resolve();
		await flush();

		const elsewhere = await startNode(shared);
		const twin = twinOf(early);
		const claim = await elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		assert.equal(claim.status, "granted", "nothing live owns the id");
	});

	test("a session whose first binding write failed takes its id at the next renewal, and is disconnected if another registration took it meanwhile (#5607)", async () => {
		vi.useFakeTimers({ toFake: [...ADVANCE] });
		const shared = await cluster();
		const failing = await startNode({
			...shared,
			async connectState() {
				const state = await shared.connectState();
				const bind = state.knownSessions.bind.bind(state.knownSessions);
				let failures = 1;
				state.knownSessions.bind = async (...args) => {
					if (failures-- > 0) throw new Error("the shared database is busy");
					return bind(...args);
				};
				return state;
			},
		});
		const fresh = session("fresh");
		await registeredOn(failing, fresh);
		// Its id was answered to it, but nothing shared names it the owner: another registration of it takes the id.
		const elsewhere = await startNode(shared);
		const twin = twinOf(fresh);
		const claimed = await elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		assert.equal(claimed.status, "granted");

		await vi.advanceTimersByTimeAsync(BROKER_LEASE_RENEW_INTERVAL_MS);

		assert.deepEqual(failing.fenced, [fresh]);
	});

	test("a session whose broker on this host stopped running keeps its id there: a pid that names a process never counts as exited (#5607)", async () => {
		const shared = await cluster();
		// The broker's pid names a process: the broker itself, paused, or a later process the host gave the pid to.
		const named = await startNode(shared, {
			process: {
				hostIdentity: "this-host",
				instanceKey: "first-socket",
				pid: 2_000_000_002,
				isProcessAlive: () => true,
			},
		});
		const live = session("live");
		await registeredOn(named, live);
		const here = await startNode(shared, {
			process: { hostIdentity: "this-host", instanceKey: "second-socket", isProcessAlive: () => true },
		});
		const twin = twinOf(live);

		const claim = await here.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);

		assert.notEqual(claim.status, "granted");
	});

	test("a claim whose look at an exited owner's broker answers after the claim's bound binds nothing more (#5607)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const shared = await cluster();
		const EXITED = 2_000_000_003;
		const isProcessAlive = (pid: number) => pid !== EXITED;
		const exited = await startNode(shared, {
			process: { hostIdentity: "this-host", instanceKey: "first-socket", pid: EXITED, isProcessAlive },
		});
		const live = session("live");
		await registeredOn(exited, live);
		const here = await startNode(shared, {
			process: { hostIdentity: "this-host", instanceKey: "second-socket", isProcessAlive },
		});
		const read = here.state.leases.read.bind(here.state.leases);
		const answered = Promise.withResolvers<void>();
		vi.spyOn(here.state.leases, "read").mockImplementationOnce(async (key) => {
			await answered.promise;
			return read(key);
		});
		const binds = vi.spyOn(here.state.knownSessions, "bind");
		const twin = twinOf(live);

		const claim = here.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		assert.equal((await claim).status, "unanswered");
		const sent = binds.mock.calls.length;
		answered.resolve();
		await flush();

		assert.equal(binds.mock.calls.length, sent, "nothing is bound once the claim has given up");
	});

	test("a session whose broker on this host exited gets its id back on another broker of this host at once (#5607)", async () => {
		const shared = await cluster();
		const EXITED = 2_000_000_001;
		const isProcessAlive = (pid: number) => pid !== EXITED;
		const exited = await startNode(shared, {
			process: { hostIdentity: "this-host", instanceKey: "first-socket", pid: EXITED, isProcessAlive },
		});
		const live = session("live");
		await registeredOn(exited, live);
		const here = await startNode(shared, {
			process: { hostIdentity: "this-host", instanceKey: "second-socket", isProcessAlive },
		});
		const elsewhere = await startNode(shared, {
			process: { hostIdentity: "another-host", instanceKey: "first-socket", isProcessAlive },
		});
		const twin = twinOf(live);

		const fromElsewhere = await elsewhere.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		assert.notEqual(fromElsewhere.status, "granted", "a broker on another host cannot tell its process has exited");
		const fromHere = await here.router.claimSessionId(twin.info.id, twin.registrationReturnAddress!);
		assert.equal(fromHere.status, "granted");
	});

	test("a broker paused past the stale age disconnects its session once the store answers it again, and the registration that took the id keeps it (#5607)", async () => {
		const { paused, other, live, held, renew, resume } = await tookOverWhilePaused();
		assert.deepEqual(paused.fenced, [], "nothing is known while the store does not answer");

		resume();
		held.mockImplementation(renew);
		await vi.advanceTimersByTimeAsync(BROKER_LEASE_RENEW_INTERVAL_MS);

		assert.deepEqual(paused.fenced, [live]);
		assert.deepEqual(other.fenced, []);
	});

	test("a send to a session whose id may have passed to another registration is answered locally while its check is unanswered, and the session is disconnected once the check answers (#5607)", async () => {
		const { paused, live, held, renew, resume } = await tookOverWhilePaused();
		resume();
		const sender = session("sender");
		await registeredOn(paused, sender);
		const answered = Promise.withResolvers<void>();
		held.mockImplementation(async (ownerships) => {
			await answered.promise;
			return renew(ownerships);
		});

		const first = localSend(sender, live);
		paused.router.routeSend(first.request);
		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		assert.equal(first.local.answers, 1, "local delivery does not wait for the shared database past its bound");
		assert.deepEqual(paused.fenced, []);

		answered.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await flush();
		assert.deepEqual(paused.fenced, [live], "the check still answers, and the session is disconnected then");
	});

	test("a send to a session whose id passed to another registration is not delivered to it once the store says so (#5607)", async () => {
		const { paused, live, held, renew, resume } = await tookOverWhilePaused();
		resume();
		const sender = session("sender");
		await registeredOn(paused, sender);
		held.mockImplementation(renew);
		let fencedAtAnswer: readonly BrokerConnectedSession[] | undefined;
		const send = localSend(sender, live);
		paused.router.routeSend({
			...send.request,
			notFound: () => {
				fencedAtAnswer = [...paused.fenced];
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await flush();

		assert.deepEqual(fencedAtAnswer, [live], "the send is looked for again only once the session is gone here");
	});

	test("a broker that renews on time routes without checking its sessions' ids (#5607)", async () => {
		vi.useFakeTimers({ toFake: [...ADVANCE] });
		const node = await startNode(await cluster());
		const [sender, recipient] = [session("sender"), session("recipient")];
		await registeredOn(node, sender);
		await registeredOn(node, recipient);
		const renew = vi.spyOn(node.state.knownSessions.owners!, "renew");
		for (let round = 0; round < 3; round++) {
			await vi.advanceTimersByTimeAsync(BROKER_LEASE_RENEW_INTERVAL_MS);
			const calls = renew.mock.calls.length;
			const send = localSend(sender, recipient);
			node.router.routeSend(send.request);
			await vi.advanceTimersByTimeAsync(0);
			await flush();
			assert.equal(send.local.answers, 1);
			assert.equal(renew.mock.calls.length, calls, "no statement beyond the renewal itself");
		}
		assert.ok(SESSION_ID_OWNER_SAFE_MS > BROKER_LEASE_RENEW_INTERVAL_MS);
		assert.deepEqual(node.fenced, []);
	});

	test("a send from a session whose id cannot be checked fails as the shared database being unavailable when it goes to another node (#5607)", async () => {
		const { paused, live, held, resume } = await tookOverWhilePaused();
		resume();
		held.mockReturnValue(new Promise(() => {}));
		const send = remoteSend(live, "someone-elsewhere", false);
		paused.router.routeSend(send.request);
		await vi.advanceTimersByTimeAsync(SESSION_ID_CLAIM_BOUND_MS);
		await flush();

		const failure = (live.socket as FakeSocket).frames.find(
			(frame) => frame.type === "delivery_failed" && frame.messageId === send.id,
		);
		assert.ok(failure !== undefined && failure.type === "delivery_failed");
		assert.match(failure.reason, /could not reach the shared storage/);
	});
});
