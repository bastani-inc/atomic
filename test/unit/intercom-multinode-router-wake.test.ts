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
	type HeldSendRequest,
	type IntercomBrokerStateStore,
	reservationKeyFor,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	RESTORING_RECIPIENT_HOLD_MS,
	restoringRecipientRetryReason,
} from "../../packages/intercom/broker/restoring-recipients.js";
import type { BrokerConnectedSession, RemoteSendRequest } from "../../packages/intercom/broker/send-handler.js";
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
	openMemoryRestoringReservationFixture,
	openMemorySentMessageFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";

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
}

interface Node {
	readonly router: MultiNodeRouter;
	readonly sessions: Map<string, BrokerConnectedSession>;
	readonly state: IntercomBrokerStateStore;
	readonly published: WakeUpHint[];
	readonly spied: Spied;
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
	options: { readonly requestWakeStatus?: "not-wakeable"; readonly takeInvalid?: boolean } = {},
): Promise<Node> {
	const inner = await shared.connectState();
	const spied: Spied = { requestWakeCalls: [], takeWakeCalls: [] };
	const state: IntercomBrokerStateStore = {
		...inner,
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
			dispatch: () => {},
			revokeReleasedReservation: () => {},
		},
	});
	cleanups.push(() => router.close());
	await flush();
	return { router, sessions, state, published, spied };
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
		options: { readonly group?: string } = {},
	): Promise<void> {
		const reserved = await node.state.reservations.reserve({
			reservationKey,
			ownerSessionId: `owner-${dormant ? "dormant" : "live"}-${reservationKey.slice(-6)}`,
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

	test("a child registering by name consumes its released reservation in its groups and leaves dormant capability ones (#4326)", async () => {
		const node = await startNode(await cluster());
		const releasedKey = releasedReservationKey("child");
		const dormantKey = reservationKeyFor(`${randomUUID()}.capability`);
		const otherGroupKey = releasedReservationKey("other");
		await reserveRaw(node, releasedKey, false);
		await reserveRaw(node, dormantKey, true);
		await reserveRaw(node, otherGroupKey, false, { group: normalizeGroup("elsewhere") });
		await node.router.sessionRegistered(session("child"), {
			childName: "Child",
			groups: new Set([CREW]),
		});
		assert.equal(await statusOf(node, releasedKey), "consumed");
		assert.equal(await statusOf(node, dormantKey), "active");
		assert.equal(await statusOf(node, otherGroupKey), "active");
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
