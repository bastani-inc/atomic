import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import {
	askOnOneBroker,
	harness,
	leaveResumably,
	outcomeLog,
	REAL_BROKERS_TEST_TIMEOUT_MS,
	rejoin,
	reply,
	settle,
	useSlowStoreBrokers,
	WAIT,
} from "../helpers/intercom-away-routes-slow-store.js";

/**
 * Asks still moving to the slow shared state when their asker comes back or their broker crashes (#4997).
 * Shared fixtures and the suite overview: test/helpers/intercom-away-routes-slow-store.ts.
 */
useSlowStoreBrokers();

test(
	"a reply right after its asker came back is delivered while the ask is still moving to the shared state (#4997)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const askId = randomUUID();
		const log = outcomeLog(askId);
		const { asker, recipient } = await askOnOneBroker(log, askId);
		const askerId = asker.sessionId;
		await leaveResumably(asker);
		const back = await rejoin(asker, askerId, (client) => log.watch(client));

		const replied = await reply(recipient, askerId, askId);

		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
		await harness.disconnect(recipient);
		await settle();
		assert.deepEqual(log.outcomes, ["reply"], "the recipient ending adds no failure");
		await harness.disconnect(back);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

for (const then of ["reply", "end"] as const) {
	test(
		`an ask whose broker crashes while it moves to the shared state, after its asker left, gets one outcome when the recipient then ${then === "reply" ? "replies" : "ends"} (#4997)`,
		async () => {
			const askId = randomUUID();
			const log = outcomeLog(askId);
			const { asker, recipient } = await askOnOneBroker(log, askId);
			const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
			await leaveResumably(asker);
			await harness.stopBroker("b", "SIGKILL");
			await harness.startBroker("b");
			const askerBack = await rejoin(asker, ids.asker, (client) => log.watch(client));
			const recipientBack = await rejoin(recipient, ids.recipient);
			assert.deepEqual({ asker: askerBack.sessionId, recipient: recipientBack.sessionId }, ids);

			if (then === "reply") {
				const replied = await reply(recipientBack, ids.asker, askId);
				assert.equal(replied.delivered, true, replied.reason);
				await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
			}
			await harness.disconnect(recipientBack);
			await vi.waitFor(() => assert.equal(log.outcomes.length, 1), WAIT);
			await settle();
			assert.equal(log.outcomes.length, 1, `the ask has one outcome: ${JSON.stringify(log.outcomes)}`);
			if (then === "end") assert.notEqual(log.outcomes[0], "reply");
			await harness.disconnect(askerBack);
		},
		REAL_BROKERS_TEST_TIMEOUT_MS,
	);
}
