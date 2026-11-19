import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { TwoBrokerHarness, twoBrokerHarnessStartTimeoutMs } from "../helpers/intercom-two-broker-harness.js";

const localMessage = randomUUID();
const oldQuestion = randomUUID();
const options = {
	storageAdapter: resolve(import.meta.dirname, "../fixtures/intercom-routing-read-stall.ts"),
	brokerEnv: { TEST_STALLED_OUTBOX_ID: localMessage, TEST_STALLED_REPLY_TO: oldQuestion },
};
let harness: TwoBrokerHarness;
beforeAll(async () => {
	harness = await TwoBrokerHarness.start(options);
}, twoBrokerHarnessStartTimeoutMs(options));
afterAll(() => harness?.cleanup(), twoBrokerHarnessStartTimeoutMs(options));

test("a local send is confirmed when its broker stalls during the duplicate check and its recipient takes six seconds to save (#5607)", async () => {
	const sender = await harness.connect("a", "sender");
	const recipient = await harness.connect("a", "recipient", { acknowledgeReceipts: false });
	let receipt: ReturnType<typeof setTimeout> | undefined;
	recipient.client.on("message", (_from, message) => {
		if (message.id === localMessage)
			receipt = setTimeout(() => recipient.client.acknowledgeReceived(localMessage), 6_000);
	});
	try {
		const result = await sender.client.send(recipient.sessionId, { messageId: localMessage, text: "please save" });
		assert.equal(result.delivered, true, result.reason);
		assert.equal(recipient.messagesWithId(localMessage).length, 1);
		assert.match(readFileSync(`${harness.sharedDatabasePath}.reads`, "utf8"), /^outbox$/mu);
	} finally {
		clearTimeout(receipt);
	}
}, 45_000);

test("a reply to an ask on a crashed broker gets a retryable refusal without losing the next reply's acknowledgment (#5607)", async () => {
	const asker = await harness.connect("b", "asker");
	const replier = await harness.connect("b", "replier");
	const askerId = asker.sessionId;
	const replierId = replier.sessionId;
	const original = await asker.client.send(replierId, { messageId: oldQuestion, text: "first?", expectsReply: true });
	assert.equal(original.delivered, true, original.reason);
	await harness.stopBroker("b", "SIGKILL");
	const back = await harness.connect("a", asker.name, {
		returnAddress: asker.returnAddress,
		preferredSessionId: askerId,
	});
	const from = await harness.connect("a", replier.name, {
		returnAddress: replier.returnAddress,
		preferredSessionId: replierId,
	});
	assert.equal(back.sessionId, askerId);
	assert.equal(from.sessionId, replierId);
	const live = await harness.connect("a", "live-asker");
	const question = randomUUID();
	const asked = await live.client.send(replierId, { messageId: question, text: "second?", expectsReply: true });
	assert.equal(asked.delivered, true, asked.reason);

	// The broker serializes these sends from one replier; both independent client deadlines are already running.
	const reply = randomUUID();
	const results = await Promise.allSettled([
		from.client.send(askerId, { text: "first", replyTo: oldQuestion, requirePendingReply: true }),
		from.client.send(live.sessionId, {
			messageId: reply,
			text: "second",
			replyTo: question,
			requirePendingReply: true,
		}),
	]);
	assert.deepEqual(
		results.map((r) => (r.status === "fulfilled" ? (r.value.reasonCode ?? r.value.delivered) : String(r.reason))),
		["route_unavailable", true],
	);
	assert.equal(live.messagesWithId(reply).length, 1);
	assert.match(readFileSync(`${harness.sharedDatabasePath}.reads`, "utf8"), /^route\nsettled$/mu);
}, 45_000);
