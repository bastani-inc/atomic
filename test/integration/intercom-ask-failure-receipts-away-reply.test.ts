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

const harness = await createAskFailureReceiptsHarness("ask-fail-away-reply-");
const { connect, runAskerDiesScenario } = harness;

beforeAll(() => harness.startBroker(), BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => harness.cleanup());

test(
	"a recipient that ends while its reply waits for the asker to save it fails only the ask it did not answer, once (#5095)",
	async () => {
		const label = "reply-unsaved-then-end-5095";
		// The asker saves nothing yet, so the reply is still on its way when the recipient ends.
		const asker = await connect(`asker-${label}`, { returnAddress: randomUUID(), confirms: false });
		const askerId = idOf(asker.client);
		const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
		const [answered, unanswered] = [randomUUID(), randomUUID()] as const;
		for (const messageId of [answered, unanswered]) {
			const asked = await asker.client.send(`recipient-${label}`, {
				messageId,
				text: "which port?",
				expectsReply: true,
			});
			assert.equal(asked.delivered, true, asked.reason);
		}
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === unanswered)), WAIT);

		const replying = replyTo(recipient, askerId, answered).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(asker, answered).length, 1), WAIT);
		await recipient.client.disconnect();
		await vi.waitFor(() => assert.equal(failuresOf(asker, unanswered).length, 1), WAIT);
		for (const message of asker.received) asker.client.acknowledgeReceived(message.id);
		await replying;
		await sleep(SETTLE_MS);

		assert.deepEqual(failuresOf(asker, answered), [], "an answered ask is not also failed");
		assert.equal(repliesTo(asker, answered).length, 1);
		assert.deepEqual(failuresOf(asker, unanswered), [`ended:${unanswered}`], "an unanswered ask still fails, once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker whose connection dies as the reply is sent while its recipient ends gets one outcome once it is back, every time (#5095)",
	async () => {
		await runAskerDiesScenario(2, "as the reply is sent");
	},
	REAL_BROKER_TEST_TIMEOUT_MS * 3,
);

test(
	"an ask answered while its recipient was away cannot be answered again when that recipient is back (#5095)",
	async () => {
		const label = "answered-while-away-5095";
		const asker = await connect(`asker-${label}`, { returnAddress: randomUUID(), confirms: false });
		const askerId = idOf(asker.client);
		const recipientAddress = { name: `recipient-${label}`, returnAddress: randomUUID() };
		const recipient = await connect(recipientAddress.name, recipientAddress);
		const recipientId = idOf(recipient.client);
		const questionId = randomUUID();
		const asked = await asker.client.send(recipientAddress.name, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

		// The recipient replies and goes away before the asker saves the reply; the asker saves it then.
		const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(asker, questionId).length, 1), WAIT);
		await recipient.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		asker.client.acknowledgeReceived(repliesTo(asker, questionId)[0]?.id ?? "");
		await replying;
		await sleep(SETTLE_MS);

		const back = await connect(recipientAddress.name, { ...recipientAddress, preferredSessionId: recipientId });
		assert.equal(idOf(back.client), recipientId);
		const again = await replyTo(back, askerId, questionId).catch((error: Error) => ({
			delivered: false,
			reason: error.message,
		}));
		assert.equal(again.delivered, false, "an answered ask is not answered again");
		await back.client.disconnect();
		await sleep(SETTLE_MS);
		assert.equal(repliesTo(asker, questionId).length, 1);
		assert.deepEqual(failuresOf(asker, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker back to a resent reply whose recipient ended meanwhile gets only that reply, then and later (#5095)",
	async () => {
		const label = "resent-reply-5095";
		const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
		// It gets the reply but crashes before saving it.
		const first = await connect(askerAddress.name, { ...askerAddress, confirms: false });
		const askerId = idOf(first.client);
		const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
		const questionId = randomUUID();
		const asked = await first.client.send(`recipient-${label}`, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);
		const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(first, questionId).length, 1), WAIT);
		const [reply] = repliesTo(first, questionId);
		await first.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		// The recipient ends while the asker is away, its reply still unsaved.
		await recipient.client.disconnect();
		await replying;
		await sleep(SETTLE_MS);

		const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					repliesTo(back, questionId).map((message) => message.id),
					[reply?.id],
				),
			WAIT,
		);
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(back, questionId), [], "the resent reply is the ask's one outcome");

		// Saved now: coming back again brings neither the reply nor a failure.
		await back.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const again = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(again, questionId), []);
		assert.deepEqual(repliesTo(again, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
