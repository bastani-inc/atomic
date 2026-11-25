import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import { BROKER_LEASE_RENEW_INTERVAL_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	askOnOneBroker,
	harness,
	outcomeLog,
	REAL_BROKERS_TEST_TIMEOUT_MS,
	reply,
	unique,
	useSlowStoreBrokers,
	WAIT,
} from "../helpers/intercom-away-routes-slow-store.js";
import type { TwoBrokerClient } from "../helpers/intercom-two-broker-harness.js";

/**
 * Replies whose ask's route is kept by a broker whose leases have gone stale: refused as retryable until it is back
 * (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"a reply whose ask's route is kept by a broker that is down is refused as retryable, and delivered once that broker is back (#4997)",
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
		// Broker b has missed its lease renewals: it is down, and it keeps the ask's only route.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 2 * BROKER_LEASE_RENEW_INTERVAL_MS));

		const refused = await reply(recipientOnA, ids.asker, askId);

		assert.equal(refused.delivered, false);
		assert.equal(refused.reasonCode, "route_unavailable", refused.reason);
		assert.match(refused.reason ?? "", /try again/i);
		assert.deepEqual(log.outcomes, []);

		await harness.startBroker("b");
		await vi.waitFor(
			async () => {
				const replied = await reply(recipientOnA, ids.asker, askId);
				assert.equal(replied.delivered, true, replied.reason);
			},
			{ timeout: WAIT.timeout, interval: 500 },
		);
		await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
		// With every broker up, a reply no route authorizes is refused for good.
		const bystander = await harness.connect("a", unique("bystander"), { group: asker.group });
		const unauthorized = await reply(bystander, ids.asker, askId);
		assert.equal(unauthorized.delivered, false);
		assert.notEqual(unauthorized.reasonCode, "route_unavailable");
		assert.match(unauthorized.reason ?? "", /does not authorize this public reply/);
		for (const client of [bystander, recipientOnA, askerOnA]) await harness.disconnect(client);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
