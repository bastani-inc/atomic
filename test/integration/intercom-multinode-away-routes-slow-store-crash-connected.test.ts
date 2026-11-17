import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	askOnOneBroker,
	harness,
	outcomeLog,
	REAL_BROKERS_TEST_TIMEOUT_MS,
	reply,
	settle,
	useSlowStoreBrokers,
	WAIT,
} from "../helpers/intercom-away-routes-slow-store.js";
import type { TwoBrokerClient } from "../helpers/intercom-two-broker-harness.js";

/**
 * Asks between two connected sessions whose broker crashes, with a session coming back on the other broker (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

for (const mover of ["asker", "recipient"] as const) {
	test(
		`an ask between two connected sessions survives its broker crashing and its ${mover} coming back on the other broker: answered once, and its recipient's end adds nothing (#4997)`,
		async () => {
			const askId = randomUUID();
			const log = outcomeLog(askId);
			const { asker, recipient } = await askOnOneBroker(log, askId);
			const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
			await harness.stopBroker("b", "SIGKILL");
			await harness.startBroker("b");
			const back = (session: TwoBrokerClient, sessionId: string, moves: boolean, watch?: boolean) =>
				harness.connect(moves ? "a" : "b", session.name, {
					group: session.group,
					returnAddress: session.returnAddress,
					preferredSessionId: sessionId,
					...(watch === true ? { beforeConnect: (client: TwoBrokerClient) => log.watch(client) } : {}),
				});
			const askerBack = await back(asker, ids.asker, mover === "asker", true);
			const recipientBack = await back(recipient, ids.recipient, mover === "recipient");
			assert.deepEqual({ asker: askerBack.sessionId, recipient: recipientBack.sessionId }, ids);
			// Any send across brokers to a session back on the crashed broker waits until the crashed broker's leases are
			// stale, as in intercom-multinode-two-broker.test.ts; this reply needs its route, not that wait.
			await new Promise((resolveDelay) => setTimeout(resolveDelay, BROKER_LEASE_STALE_AFTER_MS + 1_000));

			const replied = await reply(recipientBack, ids.asker, askId);

			assert.equal(replied.delivered, true, replied.reason);
			await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
			await harness.disconnect(recipientBack);
			await settle();
			assert.deepEqual(log.outcomes, ["reply"], "the recipient ending adds no failure");
			await harness.disconnect(askerBack);
		},
		REAL_BROKERS_TEST_TIMEOUT_MS + BROKER_LEASE_STALE_AFTER_MS,
	);

	test(
		`an ask between two connected sessions fails once when its recipient ends after its broker crashed and its ${mover} came back on the other broker (#4997)`,
		async () => {
			const askId = randomUUID();
			const log = outcomeLog(askId);
			const { asker, recipient } = await askOnOneBroker(log, askId);
			const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
			await harness.stopBroker("b", "SIGKILL");
			await harness.startBroker("b");
			const askerBack = await harness.connect(mover === "asker" ? "a" : "b", asker.name, {
				group: asker.group,
				returnAddress: asker.returnAddress,
				preferredSessionId: ids.asker,
				beforeConnect: (client) => log.watch(client),
			});
			const recipientBack = await harness.connect(mover === "recipient" ? "a" : "b", recipient.name, {
				group: recipient.group,
				returnAddress: recipient.returnAddress,
				preferredSessionId: ids.recipient,
			});
			assert.deepEqual({ asker: askerBack.sessionId, recipient: recipientBack.sessionId }, ids);

			await harness.disconnect(recipientBack);

			await vi.waitFor(() => assert.equal(log.outcomes.length, 1), WAIT);
			assert.notEqual(log.outcomes[0], "reply");
			await settle();
			assert.equal(log.outcomes.length, 1, `the asker is told once: ${JSON.stringify(log.outcomes)}`);
			await harness.disconnect(askerBack);
		},
		REAL_BROKERS_TEST_TIMEOUT_MS,
	);
}
