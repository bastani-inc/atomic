import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import {
	askOnOneBroker,
	harness,
	leaveResumably,
	outcomeLog,
	REAL_BROKERS_TEST_TIMEOUT_MS,
	reply,
	settle,
	useSlowStoreBrokers,
	WAIT,
} from "../helpers/intercom-away-routes-slow-store.js";
import type { TwoBrokerClient } from "../helpers/intercom-two-broker-harness.js";

/**
 * Replies whose ask is kept by a broker that is down: never failed twice, and refused as retryable until it is back
 * (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"an ask its crashed broker still keeps is not failed after it was answered on the other broker while that broker was down (#4997)",
	async () => {
		const askId = randomUUID();
		const log = outcomeLog(askId);
		const { asker, recipient } = await askOnOneBroker(log, askId);
		const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
		await leaveResumably(asker);
		// Crashes before the move drops the copy here (the database answers every call 250 ms late).
		await harness.stopBroker("b", "SIGKILL");
		const shared = await harness.openSharedStorage("a");
		if ((await shared.all("SELECT 1 FROM mn_intercom_pending_asks WHERE message_id = ?", askId)).length === 0) {
			// The move's shared write committed before the crash.
			await shared.run(
				"INSERT INTO mn_intercom_pending_asks(sender_session_id, target_session_id, message_id) VALUES (?, ?, ?)",
				ids.asker,
				ids.recipient,
				askId,
			);
		}
		const onA = (session: TwoBrokerClient, sessionId: string, watch: boolean) =>
			harness.connect("a", session.name, {
				group: session.group,
				returnAddress: session.returnAddress,
				preferredSessionId: sessionId,
				...(watch ? { beforeConnect: (client: TwoBrokerClient) => log.watch(client) } : {}),
			});
		const askerOnA = await onA(asker, ids.asker, true);
		const recipientOnA = await onA(recipient, ids.recipient, false);
		assert.deepEqual({ asker: askerOnA.sessionId, recipient: recipientOnA.sessionId }, ids);
		const replied = await reply(recipientOnA, ids.asker, askId);
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);

		// The crashed broker is back with its copy of the answered ask.
		await harness.startBroker("b");
		await settle();
		await harness.disconnect(recipientOnA);

		await settle();
		await settle();
		assert.deepEqual(log.outcomes, ["reply"], "the answered ask is not failed too");
		await harness.disconnect(askerOnA);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"a reply a second after the broker keeping its ask's only route crashed is refused as retryable, not for good (#4997)",
	async () => {
		const askId = randomUUID();
		const log = outcomeLog(askId);
		const { asker, recipient } = await askOnOneBroker(log, askId);
		const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
		await harness.stopBroker("b", "SIGKILL");
		const onA = (session: TwoBrokerClient, sessionId: string, watch: boolean) =>
			harness.connect("a", session.name, {
				group: session.group,
				returnAddress: session.returnAddress,
				preferredSessionId: sessionId,
				...(watch ? { beforeConnect: (client: TwoBrokerClient) => log.watch(client) } : {}),
			});
		const askerOnA = await onA(asker, ids.asker, true);
		const recipientOnA = await onA(recipient, ids.recipient, false);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));

		const refused = await reply(recipientOnA, ids.asker, askId);

		assert.equal(refused.delivered, false);
		assert.equal(refused.reasonCode, "route_unavailable", refused.reason);
		await harness.startBroker("b");
		await vi.waitFor(
			async () => {
				const replied = await reply(recipientOnA, ids.asker, askId);
				assert.equal(replied.delivered, true, replied.reason);
			},
			{ timeout: WAIT.timeout, interval: 500 },
		);
		await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
		// Answered: a further reply to it is refused for good, while the crashed broker's leases may still name them.
		const again = await reply(recipientOnA, ids.asker, askId);
		assert.equal(again.delivered, false);
		assert.notEqual(again.reasonCode, "route_unavailable", again.reason);
		for (const client of [recipientOnA, askerOnA]) await harness.disconnect(client);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
