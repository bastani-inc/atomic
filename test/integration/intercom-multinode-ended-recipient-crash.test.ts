import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import { ASK_FAILURE_QUEUED, BROKER_CRASH_AT_ENV } from "../../packages/intercom/broker/crash-points.js";
import { TWO_BROKER_STORAGE_PREFIX } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";
import {
	CRASH_TEST_TIMEOUT_MS,
	harness,
	PENDING_ASKS_TABLE,
	SETTLE_MS,
	SWEPT_WITHIN_MS,
	untilListed,
	useEndedRecipientCrashBrokers,
	WAIT,
} from "./intercom-multinode-ended-recipient-crash-helpers.js";

useEndedRecipientCrashBrokers();

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
