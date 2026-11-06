import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	MULTI_NODE_OUTCOME_POLL_INTERVAL_MS,
	MultiNodeRouter,
	type ReservationOptions,
} from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type HeldSendRequest,
	type IntercomBrokerStateStore,
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
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
	const outbox = await openMemoryOutboxFixture();
	const heldSends = await openMemoryHeldSendFixture();
	const reservations = await openMemoryRestoringReservationFixture();
	const pendingAsks = await openMemoryPendingAskFixture();
	const releasedAsks = await openMemoryReleasedAskFixture();
	const sentMessages = await openMemorySentMessageFixture();
	const knownSessions = await openMemoryKnownSessionFixture();
	const bus = await openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
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
		/** Held sends are written only once this settles, as when the database is slow to answer. */
		readonly holdGate?: Promise<void>;
	} = {},
): Promise<Node> {
	const inner = await shared.connectState();
	const spied: Spied = { requestWakeCalls: [], takeWakeCalls: [], heldListCalls: 0 };
	const state: IntercomBrokerStateStore = {
		...inner,
		leases: {
			...inner.leases,
			acquire: async (subject, holderId, staleAfterMs) => {
				if (subject.kind === "presence") await options.presenceAcquireGate;
				return inner.leases.acquire(subject, holderId, staleAfterMs);
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
			releaseClaim: async (claim) => {
				await options.releaseClaimGate;
				return inner.outbox.releaseClaim(claim);
			},
			listUndelivered: async (identity) =>
				options.undeliveredListInvalid === true
					? { status: "invalid", reason: "empty-target-identity" }
					: inner.outbox.listUndelivered(identity),
		},
		reservations: {
			...inner.reservations,
			requestWake: async (key) => {
				spied.requestWakeCalls.push(key);
				if (options.requestWakeStatus !== undefined) return { status: options.requestWakeStatus };
				return inner.reservations.requestWake(key);
			},
			takeWakeRequests: async (brokerId) => {
				spied.takeWakeCalls.push(brokerId);
				if (options.takeInvalid === true) return { status: "invalid", reason: "empty-broker-id" };
				return inner.reservations.takeWakeRequests(brokerId);
			},
			renew: async (lease) =>
				options.loseReservationRenewals === true ? { status: "renewed" } : inner.reservations.renew(lease),
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
	const sessions = new Map<string, BrokerConnectedSession>();
	const dispatched: string[] = [];
	const router = await MultiNodeRouter.start({
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
		},
	});
	cleanups.push(() => router.close());
	await flush();
	return { router, sessions, state, published, spied, dispatched };
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
});
