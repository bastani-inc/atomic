import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { MultiNodeRouter } from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type BrokerLeaseStore,
	type BrokerMembershipSubject,
	type IntercomBrokerStateStore,
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
const SOCKET = "/agent/intercom/broker.sock";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const membership = (brokerId: string, instanceKey?: string): BrokerMembershipSubject => ({
	kind: "broker",
	brokerId,
	nodeId: NODE,
	startedAt: 1,
	...(instanceKey === undefined ? {} : { instanceKey }),
});

const presence = (targetIdentity: string): RecipientPresenceSubject => ({
	kind: "presence",
	targetIdentity,
	session: { id: targetIdentity, cwd: "/work", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
});

/** A shared store holding live leases of a broker that was killed (it never released them) and of another broker. */
async function crashedCluster() {
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
	const seed = await leaseFixture.connect();
	const take = async (subject: BrokerMembershipSubject | RecipientPresenceSubject, holderId: string) =>
		assert.equal((await seed.acquire(subject, holderId, BROKER_LEASE_STALE_AFTER_MS)).status, "acquired");
	await take(membership("crashed", `${NODE}:${SOCKET}`), "crashed");
	await take(presence("hosted-by-crashed"), "crashed");
	await take(membership("other", `${NODE}:/other/broker.sock`), "other");
	await take(presence("hosted-by-other"), "other");

	await take(membership("legacy"), "legacy");
	await take(presence("hosted-by-legacy"), "legacy");

	const start = async (options: { readonly instanceKey?: string }) => {
		const leases = await leaseFixture.connect();
		const state: IntercomBrokerStateStore = {
			leases,
			outbox: await fixtures.outbox.connect(),
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
		return { leases, router };
	};
	return { start };
}

const holderOf = async (leases: BrokerLeaseStore, targetIdentity: string) => {
	const read = await leases.read({ kind: "presence", targetIdentity });
	return read.status === "found" ? read.lease.holderId : read.status;
};

test("a restarted broker retires its killed instance's leases as it starts, and no other broker's (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases } = await start({ instanceKey: SOCKET });
	assert.equal(await holderOf(leases, "hosted-by-crashed"), "missing");
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: "crashed" }), { status: "missing" });
	assert.equal(await holderOf(leases, "hosted-by-other"), "other");
	const liveBrokers = (await leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS)).map((lease) => lease.holderId);
	assert.ok(liveBrokers.includes("other"));
	assert.ok(!liveBrokers.includes("crashed"));
});

test("a broker on another socket, or without an instance key, leaves a live broker's leases alone (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases: elsewhere } = await start({ instanceKey: "/elsewhere/broker.sock" });
	assert.equal(await holderOf(elsewhere, "hosted-by-crashed"), "crashed");
	assert.equal(await holderOf(elsewhere, "hosted-by-legacy"), "legacy");
	const { leases: unkeyed, router: first } = await start({});
	await start({});
	assert.equal(await holderOf(unkeyed, "hosted-by-crashed"), "crashed");
	assert.equal(await holderOf(unkeyed, "hosted-by-other"), "other");
	assert.equal(await holderOf(unkeyed, "hosted-by-legacy"), "legacy");
	assert.equal((await unkeyed.read({ kind: "broker", brokerId: first.brokerId })).status, "found");
});

test("a broker started again on the same socket supersedes the instance before it (#5038)", async () => {
	const { start } = await crashedCluster();
	const { leases, router: previous } = await start({ instanceKey: "/restarted/broker.sock" });
	assert.equal((await leases.read({ kind: "broker", brokerId: previous.brokerId })).status, "found");
	const { router: next } = await start({ instanceKey: "/restarted/broker.sock" });
	assert.deepEqual(await leases.read({ kind: "broker", brokerId: previous.brokerId }), { status: "missing" });
	assert.equal((await leases.read({ kind: "broker", brokerId: next.brokerId })).status, "found");
});
