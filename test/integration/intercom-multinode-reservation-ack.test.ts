import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import {
	TWO_BROKER_HARNESS_START_TIMEOUT_MS,
	TWO_BROKER_STORAGE_PREFIX,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * With multi-node routing, a supervisor that reserves a starting subagent is acknowledged only once brokers on other
 * hosts can find that reservation. Here the shared-store write of the reservation is parked, so a sender that sends as
 * soon as the reservation is acknowledged lands inside the window where only the owner's broker knows it.
 */

const TEST_TIMEOUT_MS = 90_000;
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
