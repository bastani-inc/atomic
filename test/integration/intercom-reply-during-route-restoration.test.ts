import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/** Spawning a real broker process is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 90_000;
const WAIT = { timeout: 15_000, interval: 20 };
/** Long enough for a refusal the broker writes at once to arrive. */
const REPLY_SETTLE_MS = 500;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ nodes: ["a"], parkableRegistrations: true });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"a reply to an asker whose route a restarted broker is still restoring is delivered, not refused (#5101)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const group = unique("restoring");
		const askerName = unique("asker");
		const asker = await harness.connect("a", askerName, { group });
		const recipient = await harness.connect("a", unique("recipient"), { group });
		const questionId = randomUUID();
		const asked = await asker.client.send(recipient.sessionId, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.equal(recipient.messagesWithId(questionId).length, 1), WAIT);
		const askerId = asker.sessionId;
		const recipientId = recipient.sessionId;

		await harness.shutdownBroker("a");
		await harness.startBroker("a");

		const recipientBack = await harness.connect("a", recipient.name, {
			group,
			returnAddress: recipient.returnAddress,
			preferredSessionId: recipientId,
		});
		assert.equal(recipientBack.sessionId, recipientId);
		// The asker is back and routable, but the broker has not finished its registration, so it has not restored the
		// ask's route yet: the shared-store write that records the registration is parked.
		harness.holdRegistration(askerName);
		const askerBack = harness.connect("a", askerName, {
			group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		await harness.registrationParked(askerName);

		const replyId = randomUUID();
		const replied = recipientBack.client.send(askerId, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: askerId,
		});
		// A refusal comes back at once; a reply that waits for the route's restoration is answered once it is restored.
		const early = await Promise.race([replied, sleep(REPLY_SETTLE_MS).then(() => undefined)]);
		assert.equal(early?.delivered ?? true, true, JSON.stringify(early));
		harness.releaseRegistration();
		const asker2 = await askerBack;
		const result = await replied;
		assert.equal(result.delivered, true, JSON.stringify(result));
		await vi.waitFor(() => assert.equal(asker2.messagesWithId(replyId).length, 1), WAIT);
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);
