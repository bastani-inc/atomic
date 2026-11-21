import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { ASK_FAILURE_QUEUED, BROKER_CRASH_AT_ENV } from "../../packages/intercom/broker/crash-points.js";
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
const CRASH_TEST_TIMEOUT_MS = 120_000;
/**
 * #5154: the brokers' shortened lost-recipient bound. A kill that lands before the departing broker marks the
 * recipient's asks ended leaves the recipient only lost, and its askers are failed once it stayed gone this long.
 */
const LOST_AFTER_MS = 3_000;
/**
 * A broker finishes what another left only once that is a stale claim's age old, or, for a departure the kill lost, the
 * lost-recipient bound past the restart, at its next backup poll.
 */
const SWEPT_WITHIN_MS = Math.max(OUTBOX_CLAIM_STALE_AFTER_MS, LOST_AFTER_MS) + OUTBOX_BACKUP_POLL_INTERVAL_MS + 15_000;
/** Every shared database call waits this long, so the crash lands between the broker's writes. */
const DATABASE_CALL_DELAY_MS = 250;
const WAIT = { timeout: 45_000, interval: 25 };
/** How long a failure that must not arrive twice is given to show up. */
const SETTLE_MS = 1_500;
const PENDING_ASKS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_pending_asks`;

let harness: TwoBrokerHarness;

/**
 * An asker reaches a recipient on the other broker once that broker has recorded the recipient in the shared storage,
 * which can come after the recipient's own registration was answered.
 */
async function untilListed(asker: TwoBrokerClient, recipient: TwoBrokerClient): Promise<void> {
	await vi.waitFor(async () => {
		const listed = await asker.client.listSessions(asker.group);
		assert.ok(
			listed.some((session) => session.id === recipient.sessionId),
			"the asker's broker lists the recipient",
		);
	}, WAIT);
}

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({
		databaseCallDelayMs: DATABASE_CALL_DELAY_MS,
		brokerEnv: { [LOST_RECIPIENT_AFTER_ENV]: String(LOST_AFTER_MS) },
	});
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"an asker on another broker gets its failure once when the ended recipient's broker crashes right after the ask's route is removed (#4992)",
	async () => {
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

test(
	"an asker on another broker gets its failure once when the ended recipient's broker crashes after queueing it and before clearing the ask (#5145)",
	async () => {
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b", { [BROKER_CRASH_AT_ENV]: ASK_FAILURE_QUEUED });
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
			const route = () => database.get(`SELECT 1 AS found FROM ${PENDING_ASKS_TABLE} WHERE message_id = ?`, askId);
			await vi.waitFor(async () => assert.ok(await route(), "the ask's route is recorded"), WAIT);

			// Broker b queues the asker's failure and crashes before it clears the ask, which stays marked ended. It stays
			// down, so the asker's own broker both delivers the queued failure and sweeps the ended ask. Delivering the
			// failure closes the ask's route, so a backup poll that delivers it before the sweep leaves nothing to sweep.
			await harness.disconnect(recipient);
			await vi.waitFor(() => assert.equal(harness.isBrokerRunning("b"), false, "broker b crashed"), WAIT);
			const queued = await database.get(
				`SELECT state FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_outbox WHERE message_id = ?`,
				`ended:${askId}`,
			);
			assert.ok(queued, "the failure was queued before the crash");

			await vi.waitFor(async () => assert.equal(await route(), undefined, "the ended ask is not swept yet"), {
				timeout: SWEPT_WITHIN_MS,
				interval: 100,
			});
		} finally {
			await database.close();
		}
		const failures = () =>
			asker.received.filter((frame) => frame.message.replyTo === askId && frame.message.replyError !== undefined);
		await vi.waitFor(() => assert.ok(failures().length >= 1, "told"), { timeout: SWEPT_WITHIN_MS, interval: 100 });
		await sleep(SETTLE_MS);
		assert.deepEqual(
			failures().map((frame) => frame.message.id),
			[`ended:${askId}`],
			"told once",
		);
	},
	CRASH_TEST_TIMEOUT_MS + 2 * SWEPT_WITHIN_MS,
);

for (const killAfterMs of [300, 800]) {
	test(
		`an asker on another broker gets its failure once when the ended recipient's broker crashes ${killAfterMs} ms into the departure (#4992)`,
		async () => {
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
		},
		CRASH_TEST_TIMEOUT_MS + SWEPT_WITHIN_MS,
	);
}
