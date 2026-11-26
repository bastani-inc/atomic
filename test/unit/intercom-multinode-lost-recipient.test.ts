import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import { isMessage } from "../../packages/intercom/broker/client-message-validation.js";
import { lostRecipientBounds, lostRecipientReason } from "../../packages/intercom/broker/lost-recipients.js";
import { MultiNodeRouter, type MultiNodeRouterOptions } from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type BrokerMembershipSubject,
	type IntercomBrokerStateStore,
	type LeaseState,
	type RecipientPresenceSubject,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import type { BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { Message } from "../../packages/intercom/types.js";
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

/**
 * #5154: a recipient whose broker stopped before it recorded the recipient leaving is lost: once it has been gone
 * longer than its bound without registering again, the asks to it fail once, as "unavailable".
 */

const NODE = "node-1";
const HOST = "boot-1/pid:[1]";
const SOCKET = "/agent/intercom/broker.sock";
const KEY = `${NODE}:${HOST}:${SOCKET}`;
const DEAD_PID = 101;
const GROUP = "team";
const LOST = "lost-session";
const LOST_IDENTITY = JSON.stringify(["return", "lost-return"]);
const ASKER = "asker-session";
const HOUR_MS = 60 * 60 * 1000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const session = (id: string, name: string | null) => ({
	id,
	...(name === null ? {} : { name }),
	group: GROUP,
	groups: [GROUP],
	cwd: "/work",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
});

interface ClusterOptions {
	/** Whether the asker is connected to the brokers under test, or only known (as on another broker). */
	readonly askerHere?: boolean;
	readonly lostIdentity?: string;
	/** `null`: the lost session registered without a name. */
	readonly lostName?: string | null;
}

/** A shared store where a crashed broker (its process gone) had `lost` present, and `asker` asked it something. */
async function lostCluster({
	askerHere = true,
	lostIdentity = LOST_IDENTITY,
	lostName = "recipient",
}: ClusterOptions = {}) {
	const leaseFixture = await openMemoryLeaseStoreFixture();
	const fixtures = {
		outbox: await openMemoryOutboxFixture(),
		heldSends: await openMemoryHeldSendFixture(),
		reservations: await openMemoryRestoringReservationFixture(),
		pendingAsks: await openMemoryPendingAskFixture(),
		releasedAsks: await openMemoryReleasedAskFixture(),
		sentMessages: await openMemorySentMessageFixture(),
		knownSessions: await openMemoryKnownSessionFixture(),
	};
	const bus = await openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
	const connectState = async (): Promise<IntercomBrokerStateStore> => ({
		leases: await leaseFixture.connect(),
		outbox: await fixtures.outbox.connect(),
		heldSends: await fixtures.heldSends.connect(),
		reservations: await fixtures.reservations.connect(),
		pendingAsks: await fixtures.pendingAsks.connect(),
		releasedAsks: await fixtures.releasedAsks.connect(),
		sentMessages: await fixtures.sentMessages.connect(),
		knownSessions: await fixtures.knownSessions.connect(),
		close: async () => {},
	});
	const seed = await connectState();
	const membership: BrokerMembershipSubject = {
		kind: "broker",
		brokerId: "crashed",
		nodeId: NODE,
		startedAt: 1,
		instanceKey: KEY,
		pid: DEAD_PID,
	};
	const presence: RecipientPresenceSubject = {
		kind: "presence",
		targetIdentity: lostIdentity,
		session: session(LOST, lostName),
	};
	await seed.leases.acquire(membership, "crashed", BROKER_LEASE_STALE_AFTER_MS);
	await seed.leases.acquire(presence, "crashed", BROKER_LEASE_STALE_AFTER_MS);
	await seed.knownSessions.record({
		targetIdentity: lostIdentity,
		intercomSessionId: LOST,
		...(lostName === null ? {} : { name: lostName }),
		group: GROUP,
		groups: [GROUP],
	});
	// Another broker, alive, has its own session present: the crashed broker's restart leaves it alone.
	await seed.leases.acquire({ ...membership, brokerId: "live", instanceKey: "elsewhere", pid: 1 }, "live", HOUR_MS);
	await seed.leases.acquire(
		{ kind: "presence", targetIdentity: "live-identity", session: session("live-session", "live") },
		"live",
		HOUR_MS,
	);
	await seed.knownSessions.record({
		targetIdentity: "live-identity",
		intercomSessionId: "live-session",
		group: GROUP,
		groups: [GROUP],
	});
	await seed.pendingAsks.record({ senderSessionId: ASKER, targetSessionId: "live-session", messageId: "q-live" });
	if (!askerHere) {
		await seed.knownSessions.record({
			targetIdentity: "asker-identity",
			intercomSessionId: ASKER,
			group: GROUP,
			groups: [GROUP],
		});
	}
	await seed.pendingAsks.record({ senderSessionId: ASKER, targetSessionId: LOST, messageId: "q1" });

	const frames: BrokerOutboundFrame[] = [];
	const asker: BrokerConnectedSession = {
		socket: { destroyed: false, writableEnded: false } as unknown as net.Socket,
		info: session(ASKER, "asker"),
		registrationGroup: GROUP,
		registrationName: "asker",
		registrationReturnAddress: "asker-return",
		acknowledgesReceipt: true,
	};
	const start = async (options: Partial<MultiNodeRouterOptions> = {}) => {
		const router = await MultiNodeRouter.start({
			state: await connectState(),
			bus: await bus.connect(),
			nodeId: NODE,
			hostIdentity: HOST,
			instanceKey: SOCKET,
			isProcessAlive: (pid) => pid !== DEAD_PID,
			...options,
			host: {
				sessions: new Map(askerHere ? [[ASKER, asker]] : []),
				write: (_socket, frame) => {
					frames.push(frame);
					return true;
				},
				writeConfirmed: (_socket, frame, onSettled) => {
					frames.push(frame);
					onSettled(true);
				},
				supervisorCache: new SupervisorChannelCache(),
				pendingQuestions: new PendingQuestionIndex(),
				deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
				dispatch: () => {},
				revokeReleasedReservation: () => {},
				holdsReservation: () => true,
				fence: () => {},
			},
		});
		cleanups.push(() => router.close());
		return router;
	};
	const failures = () =>
		frames.flatMap((frame) =>
			frame.type === "message" && (frame.message as Message).replyTo === "q1" ? [frame.message as Message] : [],
		);
	const route = (replySenderSessionId: string, replyTo: string) =>
		seed.pendingAsks.matchesReply({ replySenderSessionId, replyTargetSessionId: ASKER, replyTo });
	return { seed, connectState, start, failures, route, frames };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("an ask to a recipient its restarted broker lost fails once, as unavailable and retryable, past the bound (#5154)", async () => {
	const { start, failures, route, frames } = await lostCluster();
	await start({ lostRecipientBounds: { afterRestartMs: 0, afterStaleLeaseMs: HOUR_MS } });
	await vi.waitFor(() => assert.equal(failures().length, 1));
	const [failure] = failures();
	assert.equal(failure!.id, "ended:q1");
	assert.equal(failure!.replyError, lostRecipientReason("recipient", 0));
	assert.equal(failure!.retryLater, true);
	const from = frames.flatMap((frame) => (frame.type === "message" ? [frame.from] : []))[0]!;
	assert.deepEqual(
		[from.id, from.name, from.group, from.groups, from.cwd, from.model],
		[LOST, "recipient", GROUP, [GROUP], "", ""],
	);
	assert.deepEqual(await route(LOST, "q1"), { status: "no-match" }, "its route is gone, so a late reply is refused");
	assert.deepEqual(await route("live-session", "q-live"), { status: "match" }, "a live broker's session is not lost");

	await start({ lostRecipientBounds: { afterRestartMs: 0, afterStaleLeaseMs: HOUR_MS } });
	await settle();
	assert.equal(failures().length, 1, "another broker that finds it lost does not tell the asker again");
});

test("an ask to a lost recipient waits out the bound (#5154)", async () => {
	const { start, failures } = await lostCluster();
	await start({ lostRecipientBounds: { afterRestartMs: HOUR_MS, afterStaleLeaseMs: HOUR_MS } });
	await settle();
	assert.deepEqual(failures(), []);
});

test("an ask to a lost recipient that registered again, or whose return an owner reserved, stays open (#5154)", async () => {
	for (const comeBack of ["present", "reserved"] as const) {
		const { seed, start, failures } = await lostCluster();
		await start({ lostRecipientBounds: { afterRestartMs: HOUR_MS, afterStaleLeaseMs: HOUR_MS } });
		if (comeBack === "present") {
			// Registered again, under another identity, on a broker too old to clear the mark: its live presence keeps
			// the ask open.
			await seed.leases.acquire(
				{ kind: "presence", targetIdentity: "new-identity", session: session(LOST, "recipient") },
				"elsewhere",
				BROKER_LEASE_STALE_AFTER_MS,
			);
		} else {
			await seed.reservations.reserve({
				reservationKey: "released:recipient",
				ownerSessionId: "owner",
				ownerBrokerId: "owner-broker",
				childName: "recipient",
				childTarget: "recipient",
				aliases: [LOST],
				group: GROUP,
				dormant: false,
				wake: true,
			});
		}
		await start({
			instanceKey: "/other.sock",
			lostRecipientBounds: { afterRestartMs: 0, afterStaleLeaseMs: HOUR_MS },
		});
		await settle();
		assert.deepEqual(failures(), [], comeBack);
	}
});

test("a recipient recorded again is no longer lost (#5154)", async () => {
	const { seed, start, failures } = await lostCluster();
	await start({ lostRecipientBounds: { afterRestartMs: HOUR_MS, afterStaleLeaseMs: HOUR_MS } });
	await seed.knownSessions.record({
		targetIdentity: LOST_IDENTITY,
		intercomSessionId: LOST,
		group: GROUP,
		groups: [GROUP],
	});
	await start({ instanceKey: "/other.sock", lostRecipientBounds: { afterRestartMs: 0, afterStaleLeaseMs: HOUR_MS } });
	await settle();
	assert.deepEqual(failures(), []);
});

test("an ask to a recipient whose presence lease went stale with no restart fails only past the longer bound (#5154)", async () => {
	vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
	const { start, failures } = await lostCluster();
	const bounds = { afterRestartMs: 0, afterStaleLeaseMs: 2 * HOUR_MS };
	// Not the crashed broker's restart: its lease is left to go stale.
	vi.setSystemTime(Date.now() + BROKER_LEASE_STALE_AFTER_MS + HOUR_MS);
	await start({ instanceKey: "/other.sock", lostRecipientBounds: bounds });
	await settle();
	assert.deepEqual(failures(), [], "stale, but not for the longer bound yet");

	vi.setSystemTime(Date.now() + HOUR_MS);
	await start({ instanceKey: "/other.sock", lostRecipientBounds: bounds });
	await vi.waitFor(() => assert.equal(failures().length, 1));
	assert.equal(failures()[0]!.replyError, lostRecipientReason("recipient", 2 * HOUR_MS));
});

test("the lost-recipient bounds are 5 minutes after a restart and an hour after a stale lease, unless overridden (#5154)", () => {
	assert.deepEqual(lostRecipientBounds({}), { afterRestartMs: 5 * 60 * 1000, afterStaleLeaseMs: HOUR_MS });
	assert.deepEqual(
		lostRecipientBounds({
			ATOMIC_INTERCOM_LOST_RECIPIENT_AFTER_MS: "3000",
			ATOMIC_INTERCOM_LOST_RECIPIENT_STALE_LEASE_AFTER_MS: "0",
		}),
		{ afterRestartMs: 3000, afterStaleLeaseMs: 0 },
	);
	for (const invalid of ["", " ", "-1", "1.5", "soon"]) {
		assert.deepEqual(
			lostRecipientBounds({ ATOMIC_INTERCOM_LOST_RECIPIENT_AFTER_MS: invalid }),
			{ afterRestartMs: 5 * 60 * 1000, afterStaleLeaseMs: HOUR_MS },
			invalid,
		);
	}
	assert.equal(
		lostRecipientReason("r", 5 * 60 * 1000),
		'Session "r" is unavailable: its broker stopped and it has not come back within 5 minutes; it may not have ended cleanly, so you can ask again later',
	);
	assert.match(lostRecipientReason("r", 1000), /within 1 minute;/);
});

test("a failed-ask message is valid with retryLater only as true (#5154)", () => {
	const failed = { id: "ended:q1", timestamp: 1, replyTo: "q1", replyError: "unavailable", content: { text: "x" } };
	assert.equal(isMessage(failed), true);
	assert.equal(isMessage({ ...failed, retryLater: true }), true);
	for (const retryLater of [false, "true", 1])
		assert.equal(isMessage({ ...failed, retryLater }), false, String(retryLater));
});

test("an asker on another broker is told through the outbox, under the lost session's id when it had no name (#5154)", async () => {
	const { seed, start, route } = await lostCluster({
		askerHere: false,
		lostIdentity: JSON.stringify(["intercom", LOST]),
		lostName: null,
	});
	await start({ lostRecipientBounds: { afterRestartMs: 0, afterStaleLeaseMs: HOUR_MS } });
	await vi.waitFor(async () => assert.equal((await seed.outbox.read("ended:q1")).status, "found"));
	const read = await seed.outbox.read("ended:q1");
	assert.ok(read.status === "found" && read.row.frame.type === "message");
	assert.equal(read.row.frame.message.replyError, lostRecipientReason(LOST, 0));
	assert.equal(read.row.frame.message.retryLater, true);
	await vi.waitFor(async () =>
		assert.deepEqual(await route(LOST, "q1"), { status: "no-match" }, "an asker in its groups needs no route for it"),
	);
});

test("a sweep that finds no recipient lost reads no live presence lease (#6560)", async () => {
	const { seed, connectState, start, failures } = await lostCluster();
	for (let index = 0; index < 30; index++)
		await seed.leases.acquire(
			{ kind: "presence", targetIdentity: `present-${index}`, session: session(`present-${index}`, null) },
			"live",
			HOUR_MS,
		);
	const state = await connectState();
	let presencesRead = 0;
	let swept = false;
	const countPresences = (leases: LeaseState[]) => {
		presencesRead += leases.filter((lease) => lease.key.kind === "presence").length;
		return leases;
	};
	const leases = new Proxy(state.leases, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "listLive" || key === "listAged")
				return (...args: unknown[]) => value.apply(target, args).then(countPresences);
			return value.bind(target);
		},
	});
	const knownSessions = new Proxy(state.knownSessions, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "listLost")
				return (...args: unknown[]) =>
					value.apply(target, args).finally(() => {
						swept = true;
					});
			return value.bind(target);
		},
	});
	// Not the crashed broker's restart, so its session's presence is live like every other.
	await start({
		instanceKey: "/other.sock",
		state: { ...state, leases, knownSessions },
		lostRecipientBounds: { afterRestartMs: HOUR_MS, afterStaleLeaseMs: HOUR_MS },
	});
	await vi.waitFor(() => assert.ok(swept, "the broker swept for lost recipients"));
	await settle();
	assert.equal(presencesRead, 0, "the sweep read the live presence leases");
	assert.deepEqual(failures(), []);
});
