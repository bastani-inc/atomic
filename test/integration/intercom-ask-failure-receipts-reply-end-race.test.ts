import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	BROKER_START_HOOK_TIMEOUT_MS,
	createAskFailureReceiptsHarness,
	failuresOf,
	idOf,
	REAL_BROKER_TEST_TIMEOUT_MS,
	repliesTo,
	replyTo,
	SETTLE_MS,
	WAIT,
} from "./intercom-ask-failure-receipts-helpers.js";

const harness = await createAskFailureReceiptsHarness("ask-fail-reply-race-");
const { connect, runAskerDiesScenario } = harness;

/** How many times the recipient replies and ends at once: the race lost about half the time before the fix. */
const REPLY_THEN_END_ITERATIONS = 30;

beforeAll(() => harness.startBroker(), BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => harness.cleanup());

test(
	"an asker whose recipient replies and ends at once gets only the reply, every time (#5095)",
	async () => {
		const outcomes: string[] = [];
		for (let iteration = 0; iteration < REPLY_THEN_END_ITERATIONS; iteration++) {
			const label = `reply-then-end-${iteration}-5095`;
			const asker = await connect(`asker-${label}`, { returnAddress: randomUUID() });
			const askerId = idOf(asker.client);
			const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
			const questionId = randomUUID();
			const asked = await asker.client.send(`recipient-${label}`, {
				messageId: questionId,
				text: "which port?",
				expectsReply: true,
			});
			assert.equal(asked.delivered, true, asked.reason);
			await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

			// The recipient replies and ends without waiting for the reply to be confirmed.
			const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
			void recipient.client.disconnect();
			await replying;
			await vi.waitFor(() => assert.equal(repliesTo(asker, questionId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			outcomes.push(
				`#${iteration}: replies=${repliesTo(asker, questionId).length} failures=${failuresOf(asker, questionId).length}`,
			);
			await asker.client.disconnect();
		}
		assert.deepEqual(
			outcomes,
			outcomes.map((_, iteration) => `#${iteration}: replies=1 failures=0`),
			"each ask has exactly one outcome: its reply",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS * 3,
);

test(
	"an asker whose connection dies just after the reply while its recipient ends gets one outcome once it is back, every time (#5095)",
	async () => {
		await runAskerDiesScenario(1, "just after the reply");
	},
	REAL_BROKER_TEST_TIMEOUT_MS * 3,
);
