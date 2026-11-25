import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { LOST_RECIPIENT_AFTER_ENV } from "../../packages/intercom/broker/lost-recipients.js";
import {
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import {
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #4992: a broker removes an ended recipient's ask route only once its asker's failure is queued, so a broker that
 * crashes right after the route is gone has already queued the failure, and the asker still gets it once. #5154: a
 * kill before the departure marks the asks ended loses the recipient's end instead; its askers are then told once it
 * stayed lost past the bound, so the asker still gets exactly one failure wherever the kill lands.
 */

/** Spawning, killing and restarting real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
export const CRASH_TEST_TIMEOUT_MS = 120_000;
/**
 * #5154: the brokers' shortened lost-recipient bound. A kill that lands before the departing broker marks the
 * recipient's asks ended leaves the recipient only lost, and its askers are failed once it stayed gone this long.
 */
const LOST_AFTER_MS = 3_000;
/**
 * A broker finishes what another left only once that is a stale claim's age old, or, for a departure the kill lost, the
 * lost-recipient bound past the restart, at its next backup poll.
 */
export const SWEPT_WITHIN_MS =
	Math.max(OUTBOX_CLAIM_STALE_AFTER_MS, LOST_AFTER_MS) + OUTBOX_BACKUP_POLL_INTERVAL_MS + 15_000;
/** Every shared database call waits this long, so the crash lands between the broker's writes. */
const DATABASE_CALL_DELAY_MS = 250;
export const WAIT = { timeout: 45_000, interval: 25 };
/** How long a failure that must not arrive twice is given to show up. */
export const SETTLE_MS = 1_500;
export const PENDING_ASKS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_pending_asks`;

export let harness: TwoBrokerHarness;

/**
 * An asker reaches a recipient on the other broker once that broker has recorded the recipient in the shared storage,
 * which can come after the recipient's own registration was answered.
 */
export async function untilListed(asker: TwoBrokerClient, recipient: TwoBrokerClient): Promise<void> {
	await vi.waitFor(async () => {
		const listed = await asker.client.listSessions(asker.group);
		assert.ok(
			listed.some((session) => session.id === recipient.sessionId),
			"the asker's broker lists the recipient",
		);
	}, WAIT);
}

export function useEndedRecipientCrashBrokers(): void {
	beforeAll(async () => {
		harness = await TwoBrokerHarness.start({
			databaseCallDelayMs: DATABASE_CALL_DELAY_MS,
			brokerEnv: { [LOST_RECIPIENT_AFTER_ENV]: String(LOST_AFTER_MS) },
		});
	}, REAL_BROKERS_HOOK_TIMEOUT_MS);
	afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
	beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);
}

export async function runDepartureCrashScenario(killAfterMs: number): Promise<void> {
	const group = `crash-${randomUUID().slice(0, 8)}`;
	const asker = await harness.connect("a", "asker", { group });
	const recipient = await harness.connect("b", "recipient", { group });
	await untilListed(asker, recipient);
	const askId = randomUUID();
	const sent = await asker.client.send(recipient.sessionId, {
		messageId: askId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(sent.delivered, true, sent.reason);
	const database = await harness.openSharedStorage("a");
	try {
		await vi.waitFor(
			async () =>
				assert.ok(
					await database.get(`SELECT 1 AS found FROM ${PENDING_ASKS_TABLE} WHERE message_id = ?`, askId),
					"the ask's route is recorded",
				),
			WAIT,
		);
	} finally {
		await database.close();
	}

	const leaving = harness.disconnect(recipient);
	await sleep(killAfterMs);
	await harness.stopBroker("b", "SIGKILL");
	await leaving;
	await harness.startBroker("b");

	const failures = () =>
		asker.received.filter((frame) => frame.message.replyTo === askId && frame.message.replyError !== undefined);
	await vi.waitFor(() => assert.equal(failures().length, 1), { timeout: SWEPT_WITHIN_MS, interval: 100 });
	await sleep(SETTLE_MS);
	assert.equal(failures().length, 1, "told once");
}
