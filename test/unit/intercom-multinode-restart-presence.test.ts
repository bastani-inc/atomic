import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { MultiNodeRouter, type MultiNodeRouterOptions } from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type BrokerLeaseStore,
	type BrokerMembershipSubject,
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type OutboxStore,
	type RecipientPresenceSubject,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
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

const NODE = "node-1";
const HOST = "boot-1/pid:[1]";
const SOCKET = "/agent/intercom/broker.sock";
const KEY = `${NODE}:${HOST}:${SOCKET}`;
/** Process ids of the seeded brokers: the crashed one has exited, the others still run. */
const DEAD_PID = 101;
const LIVE_PID = 102;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const membership = (brokerId: string, instanceKey?: string, pid?: number): BrokerMembershipSubject => ({
	kind: "broker",
	brokerId,
	nodeId: NODE,
	startedAt: 1,
	...(instanceKey === undefined ? {} : { instanceKey }),
	...(pid === undefined ? {} : { pid }),
});

const presence = (targetIdentity: string): RecipientPresenceSubject => ({
	kind: "presence",
	targetIdentity,
	session: { id: targetIdentity, cwd: "/work", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
});

/**
 * A shared store holding the live leases, and a claimed outbox row, of a broker that was killed (it released
 * nothing), of a live broker on the same host and socket, and of brokers elsewhere.
 */
async function crashedCluster() {
	const leaseFixture = await openMemoryLeaseStoreFixture();
	const outboxFixture = await openMemoryOutboxFixture();
	const fixtures = {
		heldSends: await openMemoryHeldSendFixture(),
		reservations: await openMemoryRestoringReservationFixture(),
		pendingAsks: await openMemoryPendingAskFixture(),
		releasedAsks: await openMemoryReleasedAskFixture(),
		sentMessages: await openMemorySentMessageFixture(),
		knownSessions: await openMemoryKnownSessionFixture(),
	};
	const bus = await openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
	const seed = await leaseFixture.connect();
	const take = async (subject: BrokerMembershipSubject | RecipientPresenceSubject, holderId: string) =>
		assert.equal((await seed.acquire(subject, holderId, BROKER_LEASE_STALE_AFTER_MS)).status, "acquired");
	await take(membership("crashed", KEY, DEAD_PID), "crashed");
	await take(presence("hosted-by-crashed"), "crashed");
	await take(membership("other", `${NODE}:${HOST}:/other/broker.sock`, DEAD_PID), "other");
	await take(presence("hosted-by-other"), "other");
	await take(membership("legacy", KEY), "legacy");
	await take(presence("hosted-by-legacy"), "legacy");
	const outbox = await outboxFixture.connect();
	for (const [messageId, claimantId] of [
		["claimed-by-crashed", "crashed"],
		["claimed-by-other", "other"],
	] as const) {
		const targetIdentity = `target-of-${claimantId}`;
		await outbox.enqueue({
			targetIdentity,
			originBrokerId: "sender-broker",
			digest: messageId,
			frame: {
				type: "message",
				from: presence("sender").session,
				message: { id: messageId, timestamp: 1, content: { text: messageId } },
			},
		} as Parameters<OutboxStore["enqueue"]>[0]);
		const claimed = await outbox.claim({ targetIdentity, claimantId, staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS });
		assert.equal(claimed.status, "claimed");
	}

	const start = async (options: Partial<MultiNodeRouterOptions> = {}) => {
		const leases = await leaseFixture.connect();
		const state: IntercomBrokerStateStore = {
			leases,
			outbox: await outboxFixture.connect(),
			heldSends: await fixtures.heldSends.connect(),
			reservations: await fixtures.reservations.connect(),
			pendingAsks: await fixtures.pendingAsks.connect(),
			releasedAsks: await fixtures.releasedAsks.connect(),
			sentMessages: await fixtures.sentMessages.connect(),
			knownSessions: await fixtures.knownSessions.connect(),
			close: async () => {},
		};
		const router = await MultiNodeRouter.start({
			state,
			bus: await bus.connect(),
			nodeId: NODE,
			hostIdentity: HOST,
			isProcessAlive: (pid) => pid !== DEAD_PID,
			...options,
			host: {
				sessions: new Map(),
				write: () => true,
				writeConfirmed: (_socket, _frame, onSettled) => onSettled(true),
				supervisorCache: new SupervisorChannelCache(),
				pendingQuestions: new PendingQuestionIndex(),
				deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
				dispatch: () => {},
				revokeReleasedReservation: () => {},
			},
		});
		cleanups.push(() => router.close());
		return { leases, outbox: state.outbox, router };
	};
	return { start };
}

const holderOf = async (leases: BrokerLeaseStore, targetIdentity: string) => {
	const read = await leases.read({ kind: "presence", targetIdentity });
	return read.status === "found" ? read.lease.holderId : read.status;
};

const stateOf = async (outbox: OutboxStore, messageId: string) => {
	const read = await outbox.read(messageId);
	return read.status === "found" ? read.row.state : read.status;
};

test("a restarted broker retires its killed instance's leases and claims as it starts, and no other broker's (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "queued");
	assert.equal(await holderOf(leases, "hosted-by-other"), "other");
	assert.equal(await holderOf(leases, "hosted-by-legacy"), "legacy");
	assert.equal(await stateOf(outbox, "claimed-by-other"), "claimed");
	const liveBrokers = (await leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS)).map((lease) => lease.holderId);
	assert.ok(liveBrokers.includes("other"));
	assert.ok(!liveBrokers.includes("crashed"));
});

test("a broker with the same host name and socket but another host identity retires nothing (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET, hostIdentity: "boot-2/pid:[1]" });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "crashed");
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "claimed");
});

test("two live brokers with the same host name and socket but different host identities never retire each other (#5038)", async () => {
	const { start } = await crashedCluster();
	const first = await start({ instanceKey: SOCKET, hostIdentity: "machine-a", isProcessAlive: () => false });
	const second = await start({ instanceKey: SOCKET, hostIdentity: "machine-b", isProcessAlive: () => false });
	for (const { router } of [first, second]) {
		assert.equal((await first.leases.read({ kind: "broker", brokerId: router.brokerId })).status, "found");
	}
});

test("an earlier instance whose process still runs is not retired (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, outbox } = await start({ instanceKey: SOCKET, isProcessAlive: () => true });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "crashed");
	assert.equal(await stateOf(outbox, "claimed-by-crashed"), "claimed");
});

test("a broker on another socket, or without an instance key, leaves a live broker's leases alone (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases: elsewhere } = await start({ instanceKey: "/elsewhere/broker.sock" });
	assert.equal(await holderOf(elsewhere, "hosted-by-crashed"), "crashed");
	const { leases: unkeyed, router: first } = await start({ isProcessAlive: () => false });
	await start({ isProcessAlive: () => false });
	assert.equal(await holderOf(unkeyed, "hosted-by-crashed"), "crashed");
	assert.equal(await holderOf(unkeyed, "hosted-by-other"), "other");
	assert.equal((await unkeyed.read({ kind: "broker", brokerId: first.brokerId })).status, "found");
});

test("a broker started again on the same socket supersedes the instance before it once its process exited (#5038)", async () => {
	const { start } = await crashedCluster();
	const socket = "/restarted/broker.sock";
	const { leases, router: previous } = await start({ instanceKey: socket, pid: LIVE_PID });
	const { router: next } = await start({ instanceKey: socket, pid: DEAD_PID + 1, isProcessAlive: () => false });
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: previous.brokerId }), { status: "missing" });
	assert.equal((await leases.read({ kind: "broker", brokerId: next.brokerId })).status, "found");
});
