import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #4992: an ask answered by a reply that is still on its way when its replier ends gets only the reply, on another
 * broker as on one: the replier's end does not also fail it.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 15_000, interval: 25 };
/** How long a failure that must not arrive is given to show up. */
const SETTLE_MS = 2_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

/** The asker on node a asks the replier on node b, which saves the ask. */
async function savedAsk() {
	const group = unique("reply-end");
	const asker = await harness.connect("a", unique("asker"), { group });
	const replier = await harness.connect("b", unique("replier"), { group });
	const askId = randomUUID();
	const sent = await asker.client.send(replier.sessionId, {
		messageId: askId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(replier.messagesWithId(askId).length, 1), WAIT);
	return { asker, askerId: asker.sessionId, replier, askId };
}

function outcomes(asker: TwoBrokerClient, askId: string): string[] {
	return asker.received
		.filter((frame) => frame.message.replyTo === askId)
		.map((frame) => frame.message.replyError ?? "reply");
}

test(
	"a connected asker on another broker gets only the reply when its replier ends right after replying (#4992)",
	async () => {
		const { asker, askerId, replier, askId } = await savedAsk();
		const replying = replier.client.send(askerId, { text: "port 8080", replyTo: askId, requirePendingReply: true });
		const leaving = harness.disconnect(replier);
		await replying.catch(() => undefined);
		await leaving;
		await vi.waitFor(() => assert.ok(outcomes(asker, askId).length > 0), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(outcomes(asker, askId), ["reply"]);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an away asker on another broker gets only the queued reply when its replier ends before it is back (#4992)",
	async () => {
		const { asker, askerId, replier, askId } = await savedAsk();
		await asker.client.disconnect({ resumable: true });
		asker.disconnected = true;
		const answered = await replier.client.send(askerId, {
			text: "port 8080",
			replyTo: askId,
			requirePendingReply: true,
		});
		assert.equal(answered.queued, true, answered.reason);
		await harness.disconnect(replier);
		await sleep(SETTLE_MS);
		const back = await harness.connect("a", asker.name, {
			group: asker.group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		await vi.waitFor(() => assert.ok(outcomes(back, askId).length > 0), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(outcomes(back, askId), ["reply"]);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
