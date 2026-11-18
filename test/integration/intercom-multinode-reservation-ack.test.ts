import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { BROKER_LEASE_RENEW_INTERVAL_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	TWO_BROKER_HARNESS_START_TIMEOUT_MS,
	TWO_BROKER_STORAGE_PREFIX,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * With multi-node routing, a supervisor that reserves a starting subagent is acknowledged only once brokers on other
 * hosts can find that reservation. Here the shared-store write of the reservation is parked, so a sender that sends as
 * soon as the reservation is acknowledged lands inside the window where only the owner's broker knows it. A write that
 * fails is written again at the owner's broker's next renewal, unless the reservation ended first.
 */

const TEST_TIMEOUT_MS = 120_000;
const WAIT = { timeout: 15_000, interval: 25 };
/**
 * Long enough for an acknowledgement given before the write to come back, and well within the bound the owner's broker
 * waits for the write before it acknowledges anyway.
 */
const PARKED_MS = 500;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ parkableReservations: true });
}, TWO_BROKER_HARNESS_START_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), TWO_BROKER_HARNESS_START_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"with multi-node routing, a send made once a starting subagent's reservation is acknowledged is held on the other broker (#5352)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const shared = await harness.openSharedStorage("a");
		const home = unique("home");
		const sender = await harness.connect("a", unique("sender"), { group: home });
		const supervisor = await harness.connect("b", unique("sup"), { group: home, supervisorOwnerToken: randomUUID() });
		const childName = `subagent-worker-${unique("starting")}-1`;
		const auth = await supervisor.client.authorizeSupervisorChild(childName);

		harness.holdReservation(childName);
		const messageId = randomUUID();
		let acknowledged = false;
		let settled: unknown;
		const sent = supervisor.client
			.reserveRestoringRecipient(auth.capability, { group: home, holdMs: 60_000 })
			.then(() => {
				acknowledged = true;
				return sender.client.send(childName, { messageId, text: "held for the starting child" });
			})
			.then((result) => {
				settled = result;
				return result;
			});
		try {
			await harness.reservationParked(childName);
			await sleep(PARKED_MS);
			assert.equal(acknowledged, false, "the reservation was acknowledged before other brokers could find it");
		} finally {
			harness.releaseReservation();
		}

		await vi.waitFor(async () => {
			assert.equal(settled, undefined, `the send settled before the child connected: ${JSON.stringify(settled)}`);
			const row = await shared.get(
				`SELECT message_id FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_held_sends WHERE message_id = ?`,
				messageId,
			);
			assert.equal(row?.message_id, messageId);
		}, WAIT);
		const child = await harness.connect("b", childName, { group: home, reachable: [], supervisor: auth });
		const delivered = await sent;
		assert.equal(delivered.delivered, true, JSON.stringify(delivered));
		await vi.waitFor(() => assert.equal(child.messagesWithId(messageId).length, 1), WAIT);
	},
	TEST_TIMEOUT_MS,
);

/** A renewal of the owner's broker, which writes again a reservation whose shared write failed, with room to finish. */
const RETRY_WAIT = { timeout: BROKER_LEASE_RENEW_INTERVAL_MS * 3, interval: 50 };

async function reservationRows(shared: SqliteDatabase, childName: string): Promise<{ active: number; all: number }> {
	const row = await shared.get<{ active: number; total: number }>(
		`SELECT count(*) AS total, sum(CASE WHEN end_json IS NULL THEN 1 ELSE 0 END) AS active
		 FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_restoring_reservations WHERE child_name = ?`,
		JSON.stringify(childName),
	);
	return { active: Number(row?.active ?? 0), all: Number(row?.total ?? 0) };
}

/** Reserve `childName` on node b while its first shared write fails, so only the owner's broker holds it at first. */
async function reserveWithFailedWrite(home: string, childName: string) {
	const supervisor = await harness.connect("b", unique("sup"), { group: home, supervisorOwnerToken: randomUUID() });
	const auth = await supervisor.client.authorizeSupervisorChild(childName);
	harness.failReservationOnce(childName);
	try {
		const reserved = await supervisor.client.reserveRestoringRecipient(auth.capability, {
			group: home,
			holdMs: 60_000,
		});
		await harness.reservationFailed(childName);
		return { supervisor, auth, reserved };
	} finally {
		harness.releaseReservation();
	}
}

test(
	"with multi-node routing, a starting subagent's reservation whose shared write failed is written again, and a send to it from the other broker is held and delivered (#5352)",
	async () => {
		const shared = await harness.openSharedStorage("a");
		const home = unique("retry-home");
		const sender = await harness.connect("a", unique("sender"), { group: home });
		const childName = `subagent-worker-${unique("retried")}-1`;
		const { auth, reserved } = await reserveWithFailedWrite(home, childName);

		await vi.waitFor(async () => assert.equal((await reservationRows(shared, childName)).active, 1), RETRY_WAIT);
		const messageId = randomUUID();
		let settled: unknown;
		const sent = sender.client.send(childName, { messageId, text: "held once published" }).then((result) => {
			settled = result;
			return result;
		});
		await vi.waitFor(async () => {
			assert.equal(settled, undefined, `the send settled before the child connected: ${JSON.stringify(settled)}`);
			const row = await shared.get(
				`SELECT message_id FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_held_sends WHERE message_id = ?`,
				messageId,
			);
			assert.equal(row?.message_id, messageId);
		}, WAIT);
		const child = await harness.connect("b", childName, { group: home, reachable: [], supervisor: auth });
		const delivered = await sent;
		assert.equal(delivered.delivered, true, JSON.stringify(delivered));
		await vi.waitFor(() => assert.equal(child.messagesWithId(messageId).length, 1), WAIT);
		assert.deepEqual(reserved, { published: false }, "the reservation was acknowledged as not yet published");
	},
	TEST_TIMEOUT_MS,
);

test(
	"with multi-node routing, a reservation released while its failed shared write waits to be written again is never written (#5352)",
	async () => {
		const shared = await harness.openSharedStorage("a");
		const home = unique("release-home");
		const sender = await harness.connect("a", unique("sender"), { group: home });
		const childName = `subagent-worker-${unique("released")}-1`;
		const { supervisor, auth } = await reserveWithFailedWrite(home, childName);

		await supervisor.client.releaseRestoringRecipient(auth.capability);
		// Past the renewal that would have written it again.
		await sleep(BROKER_LEASE_RENEW_INTERVAL_MS * 2);
		assert.deepEqual(await reservationRows(shared, childName), { active: 0, all: 0 });
		const refused = await sender.client.send(childName, { text: "after the release" });
		assert.equal(refused.delivered, false, JSON.stringify(refused));
		assert.match(refused.reason ?? "", /Session not found/);
	},
	TEST_TIMEOUT_MS,
);

test(
	"with multi-node routing, a released subagent's reservation whose shared write failed is not written back once its owner reserves the subagent again and releases it (#5352)",
	async () => {
		const shared = await harness.openSharedStorage("a");
		const home = unique("supersede-home");
		const sender = await harness.connect("a", unique("sender"), { group: home });
		const owner = await harness.connect("b", unique("owner"), { group: home, supervisorOwnerToken: randomUUID() });
		const childName = `subagent-worker-${unique("superseded")}-1`;
		harness.failReservationOnce(childName);
		try {
			await owner.client.reserveReleasedChildren([{ childName, wake: false }]);
			await harness.reservationFailed(childName);
		} finally {
			harness.releaseReservation();
		}

		// The owner restores the subagent: the newer reservation replaces the released one, which was never written.
		const auth = await owner.client.authorizeSupervisorChild(childName);
		const reserved = await owner.client.reserveRestoringRecipient(auth.capability, { group: home });
		assert.deepEqual(reserved, { published: true });
		await vi.waitFor(async () => assert.equal((await reservationRows(shared, childName)).active, 1), WAIT);
		// Past the renewal that would write the replaced reservation again.
		await sleep(BROKER_LEASE_RENEW_INTERVAL_MS * 2);

		await owner.client.releaseRestoringRecipient(auth.capability);
		await vi.waitFor(async () => assert.equal((await reservationRows(shared, childName)).active, 0), WAIT);
		const refused = await sender.client.send(childName, { text: "after the release" });
		assert.equal(refused.delivered, false, JSON.stringify(refused));
		assert.match(refused.reason ?? "", /Session not found/);
	},
	TEST_TIMEOUT_MS,
);
