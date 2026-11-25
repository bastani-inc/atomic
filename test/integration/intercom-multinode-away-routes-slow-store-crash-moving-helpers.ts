import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import {
	askOnOneBroker,
	harness,
	leaveResumably,
	outcomeLog,
	rejoin,
	reply,
	settle,
} from "../helpers/intercom-away-routes-slow-store.js";
import type { TwoBrokerClient } from "../helpers/intercom-two-broker-harness.js";

/** Outbox delivery to a session back on another broker after a crash waits out the crashed broker's leases and a poll. */
export const AFTER_CRASH_DELIVERY_MS = BROKER_LEASE_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS + 15_000;

export async function runMovingCrashScenario(
	copies: "local" | "local-and-shared",
	then: "reply" | "end",
): Promise<void> {
	const askId = randomUUID();
	const log = outcomeLog(askId);
	const { asker, recipient } = await askOnOneBroker(log, askId);
	const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
	await leaveResumably(asker);
	// Crashes before the move's shared write (the database answers every call 250 ms late).
	await harness.stopBroker("b", "SIGKILL");
	const shared = await harness.openSharedStorage("a");
	const sharedRows = async () =>
		(await shared.all("SELECT 1 FROM mn_intercom_pending_asks WHERE message_id = ?", askId)).length;
	if (copies === "local-and-shared" && (await sharedRows()) === 0) {
		// The crash came after the shared write committed but before the copy here was dropped.
		await shared.run(
			"INSERT INTO mn_intercom_pending_asks(sender_session_id, target_session_id, message_id) VALUES (?, ?, ?)",
			ids.asker,
			ids.recipient,
			askId,
		);
	}
	await harness.startBroker("b");
	const recipientBack = await rejoin(recipient, ids.recipient);
	const askerOnA = () =>
		harness.connect("a", asker.name, {
			group: asker.group,
			returnAddress: asker.returnAddress,
			preferredSessionId: ids.asker,
			beforeConnect: (client) => log.watch(client),
		});
	let onA: TwoBrokerClient;
	if (then === "reply") {
		// A send to the away asker waits out the crashed broker's presence lease of it, as any send does (#5038).
		await new Promise((resolveDelay) => setTimeout(resolveDelay, BROKER_LEASE_STALE_AFTER_MS + 1_000));
		const replied = await reply(recipientBack, ids.asker, askId);
		assert.ok(replied.delivered || replied.queued, replied.reason);
		// The reply reaches the asker before the recipient ends: a reply still queued when its replier ends is #5001 (M7).
		onA = await askerOnA();
		await vi.waitFor(() => assert.equal(log.outcomes.length, 1), {
			timeout: AFTER_CRASH_DELIVERY_MS,
			interval: 50,
		});
		await harness.disconnect(recipientBack);
	} else {
		await harness.disconnect(recipientBack);
		onA = await askerOnA();
	}
	assert.equal(onA.sessionId, ids.asker);

	await vi.waitFor(() => assert.equal(log.outcomes.length, 1), {
		timeout: AFTER_CRASH_DELIVERY_MS,
		interval: 50,
	});
	assert.equal(log.outcomes[0], then === "reply" ? "reply" : "failed");
	await harness.disconnect(onA);
	const onB = await rejoin(asker, ids.asker, (client) => log.watch(client));
	await settle();
	assert.equal(log.outcomes.length, 1, `the ask has one outcome: ${JSON.stringify(log.outcomes)}`);
	await harness.disconnect(onB);
}
