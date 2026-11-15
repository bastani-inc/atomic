import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { TWO_BROKER_STORAGE_PREFIX, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #4992: a broker removes an ended recipient's ask route only once its asker's failure is queued, so a broker that
 * crashes right after the route is gone has already queued the failure, and the asker still gets it once.
 */

/** Spawning, killing and restarting real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const CRASH_TEST_TIMEOUT_MS = 120_000;
/** Every shared database call waits this long, so the crash lands between the broker's writes. */
const DATABASE_CALL_DELAY_MS = 100;
const WAIT = { timeout: 45_000, interval: 25 };
/** How long a failure that must not arrive twice is given to show up. */
const SETTLE_MS = 1_500;
const PENDING_ASKS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_pending_asks`;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ databaseCallDelayMs: DATABASE_CALL_DELAY_MS });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"an asker on another broker gets its failure once when the ended recipient's broker crashes right after the ask's route is removed (#4992)",
	async () => {
		const group = `crash-${randomUUID().slice(0, 8)}`;
		const asker = await harness.connect("a", "asker", { group });
		const recipient = await harness.connect("b", "recipient", { group });
		const askId = randomUUID();
		const sent = await asker.client.send(recipient.sessionId, {
			messageId: askId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(sent.delivered, true, sent.reason);
		const database = await harness.openSharedStorage("a");
		try {
			const route = () => database.get(`SELECT 1 AS found FROM ${PENDING_ASKS_TABLE} WHERE message_id = ?`, askId);
			await vi.waitFor(async () => assert.ok(await route(), "the ask's route is recorded"), WAIT);

			const leaving = harness.disconnect(recipient);
			await vi.waitFor(async () => assert.equal(await route(), undefined, "the route is still recorded"), {
				timeout: WAIT.timeout,
				interval: 5,
			});
			await harness.stopBroker("b", "SIGKILL");
			await leaving;
		} finally {
			await database.close();
		}
		await harness.startBroker("b");

		const failures = () =>
			asker.received.filter((frame) => frame.message.replyTo === askId && frame.message.replyError !== undefined);
		await vi.waitFor(() => assert.equal(failures().length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.equal(failures().length, 1, "told once");
		assert.equal(failures()[0]!.message.replyError, 'Session "recipient" ended before replying');
	},
	CRASH_TEST_TIMEOUT_MS,
);
