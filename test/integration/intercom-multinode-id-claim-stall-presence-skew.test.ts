import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { TWO_BROKER_STORAGE_PREFIX, type TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import {
	BROKER_STALL_MS,
	IdClaimStallSupport,
	REAL_BROKERS_HOOK_TIMEOUT_MS,
	unique,
} from "./intercom-multinode-id-claim-stall-helpers.js";

const TEST_TIMEOUT_MS = 60_000;

let support: IdClaimStallSupport;
let harness: TwoBrokerHarness;

beforeAll(async () => {
	support = await IdClaimStallSupport.start();
	harness = support.harness;
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => support?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const slowWrites = ["fresh binding", "serial bindings", "known session"] as const;

test.each(slowWrites)(
	"a peer can list and send to the acknowledged id, the one the database wrote, immediately with a slow %s write (#5607)",
	async (slowWrite) => {
		const peer = await harness.connect("b", unique("peer"));
		const { back, preferredSessionId } = await support.reconnectWithSlowWrite(slowWrite);
		const listed = await peer.client.listSessions();
		const sent = await peer.client.send(back.sessionId, { text: "at registration" });
		assert.equal(sent.delivered, true, sent.reason);
		assert.ok(listed.some((session) => session.id === back.sessionId));
		if (slowWrite === "serial bindings") {
			// Even when the peer saw the ID in time, an unused binding must not occupy the store's writer.
			const store = await harness.openSharedStorage("b");
			const unused = await store.all(
				`SELECT intercom_session_id FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_session_bindings
				 WHERE return_address = ? AND intercom_session_id NOT IN (?, ?)`,
				back.returnAddress,
				preferredSessionId,
				back.sessionId,
			);
			assert.deepEqual(unused, []);
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session after an 8 s broker stall on a healthy database publishes presence before registered so a peer can list and send immediately (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, peer);
		harness.stallIdClaim(original.returnAddress, BROKER_STALL_MS);

		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			assert.equal(harness.idClaimStalled(original.returnAddress), true);
			assert.equal(back.sessionId, id);
			const listed = await peer.client.listSessions();
			assert.ok(
				listed.some((session) => session.id === back.sessionId),
				"peer lists kept id immediately",
			);
			const sent = await peer.client.send(back.sessionId, { text: "after 8 s stall" });
			assert.equal(sent.delivered, true, sent.reason);
		});
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session after a 5.5 s broker stall and a 2.5 s slow known-session write still publishes presence before registered within its 10 s deadline (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const original = await harness.connect("b", unique("returning"));
		const id = await support.leaveAway(original, peer);
		harness.stallIdClaim(original.returnAddress, 5_500, undefined, 2_500, "known session");

		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			assert.equal(harness.idClaimStalled(original.returnAddress), true);
			assert.equal(back.sessionId, id);
			const listed = await peer.client.listSessions();
			assert.ok(
				listed.some((session) => session.id === back.sessionId),
				"peer lists kept id immediately",
			);
			const sent = await peer.client.send(back.sessionId, { text: "after 5.5s+2.5s" });
			assert.equal(sent.delivered, true, sent.reason);
		});
	},
	TEST_TIMEOUT_MS,
);

test(
	"wall-clock skew (+10 s broker ahead of client) never shrinks a healthy registration's presence bound or hides it from peers (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const name = unique("skew-a1");
		harness.holdRegistration(name);
		const releaseTimer = setTimeout(() => harness.releaseRegistration(), 80);
		const realDateNow = Date.now;
		Date.now = () => realDateNow() - 10_000;
		try {
			const joined = await harness.connect("a", name, { connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS });
			Date.now = realDateNow;
			const listed = await peer.client.listSessions();
			assert.ok(
				listed.some((session) => session.id === joined.sessionId),
				"peer lists session despite +10 s clock skew",
			);
			const sent = await peer.client.send(joined.sessionId, { text: "skew-a1" });
			assert.equal(sent.delivered, true, sent.reason);
		} finally {
			Date.now = realDateNow;
			clearTimeout(releaseTimer);
			harness.releaseRegistration();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"wall-clock skew (+6 s broker ahead of client) still allows a 3.8 s registration write to publish presence before registered (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const name = unique("skew-a2");
		harness.holdRegistration(name);
		const releaseTimer = setTimeout(() => harness.releaseRegistration(), 3_800);
		const realDateNow = Date.now;
		Date.now = () => realDateNow() - 6_000;
		try {
			const joined = await harness.connect("a", name, { connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS });
			Date.now = realDateNow;
			const listed = await peer.client.listSessions();
			assert.ok(
				listed.some((session) => session.id === joined.sessionId),
				"peer lists session despite +6 s clock skew",
			);
			const sent = await peer.client.send(joined.sessionId, { text: "skew-a2" });
			assert.equal(sent.delivered, true, sent.reason);
		} finally {
			Date.now = realDateNow;
			clearTimeout(releaseTimer);
			harness.releaseRegistration();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"wall-clock skew (+10 s broker ahead of client) never forfeits a returning session's claimed id on an async reclaim (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, peer);
		harness.stallIdClaim(original.returnAddress, 2_800, undefined, 50, "fresh binding");

		const realDateNow = Date.now;
		Date.now = () => realDateNow() - 10_000;
		try {
			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});
				Date.now = realDateNow;
				assert.equal(harness.idClaimStalled(original.returnAddress), true);
				assert.equal(back.sessionId, id, "kept claimed id despite +10 s clock skew");
			});
		} finally {
			Date.now = realDateNow;
		}
	},
	TEST_TIMEOUT_MS,
);
