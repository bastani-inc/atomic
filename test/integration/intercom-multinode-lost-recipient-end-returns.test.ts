import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, vi } from "vitest";
import type { TwoBrokerClient } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";
import {
	askAcross,
	harness,
	outcomesOf,
	SETTLE_MS,
	TEST_TIMEOUT_MS,
	TOLD_WITHIN_MS,
	useLostRecipientEndBrokers,
	WAIT,
} from "./intercom-multinode-lost-recipient-end-helpers.js";

useLostRecipientEndBrokers();

test(
	"a recipient whose broker was killed and that comes back within the bound still answers its ask (#5154)",
	async () => {
		const group = `back-${randomUUID().slice(0, 8)}`;
		const { asker, registration, askId } = await askAcross(group);
		let back: TwoBrokerClient | undefined;
		try {
			await harness.stopBroker("b", "SIGKILL");
			await harness.startBroker("b");
			back = await harness.connect("b", "recipient", {
				group,
				returnAddress: registration.returnAddress,
				preferredSessionId: registration.sessionId,
			});
			// Past the bound and a backup poll: a recipient that came back is not failed.
			await sleep(TOLD_WITHIN_MS - 15_000);
			assert.deepEqual(outcomesOf(asker, askId), [], "nothing before the reply");

			const replied = await back.client.send(asker.sessionId, {
				text: "8080",
				replyTo: askId,
				requirePendingReply: true,
			});
			assert.equal(replied.delivered, true, replied.reason ?? JSON.stringify(replied));
			await vi.waitFor(() => assert.equal(outcomesOf(asker, askId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			const outcomes = outcomesOf(asker, askId);
			assert.equal(outcomes.length, 1, "one outcome");
			assert.equal(outcomes[0]!.message.replyError, undefined);
			assert.equal(outcomes[0]!.message.content.text, "8080");
		} finally {
			if (back !== undefined) await harness.disconnect(back);
			await harness.disconnect(asker);
		}
	},
	TEST_TIMEOUT_MS,
);
