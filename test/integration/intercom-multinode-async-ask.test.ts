import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { OFFLINE_SESSION_TARGET } from "../../packages/intercom/broker/held-reply-targets.js";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const ARRIVAL_WAIT = { timeout: 15_000, interval: 25 };

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"with multi-node routing, an asker that closes keeps its ask, and the reply sent meanwhile reaches it once when it is back (#4751)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const askerName = unique("away-asker");
		const asker = await harness.connect("a", askerName);
		const recipient = await harness.connect("b", unique("away-recipient"));
		const askerId = asker.sessionId;
		const questionId = randomUUID();
		const asked = await asker.client.send(recipient.name, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, JSON.stringify(asked));
		await vi.waitFor(() => assert.equal(recipient.messagesWithId(questionId).length, 1), ARRIVAL_WAIT);

		// The asker's session closes; it can be resumed, so it is only away.
		await asker.client.disconnect({ resumable: true });
		await vi.waitFor(async () => {
			const sessions = await recipient.client.listSessions();
			assert.equal(
				sessions.some((session) => session.id === askerId),
				false,
			);
		}, ARRIVAL_WAIT);

		const replyId = randomUUID();
		const reply = await recipient.client.send(askerId, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: askerId,
		});
		assert.equal(reply.queued, true, JSON.stringify(reply));
		assert.equal(reply.target, OFFLINE_SESSION_TARGET);

		const back = await harness.connect("a", askerName, {
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		assert.equal(back.sessionId, askerId);
		await vi.waitFor(() => assert.equal(back.messagesWithId(replyId).length, 1), ARRIVAL_WAIT);
		assert.equal(back.messagesWithId(replyId)[0]?.message.replyTo, questionId);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
		assert.equal(back.messagesWithId(replyId).length, 1, "the reply is delivered exactly once");
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);
