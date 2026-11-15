import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { type BrokerNode, type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/**
 * #4997: an open ask stays answerable, and still gets exactly one outcome, after its asker or its recipient resumes
 * on the other broker: an ask that crossed brokers whose peers now share one, and an ask between peers that shared a
 * broker and are now split across both.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 15_000, interval: 25 };
/** How long an outcome that must not arrive, or must not arrive twice, is given to show up. */
const SETTLE_MS = 1_500;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;
const OTHER: Record<BrokerNode, BrokerNode> = { a: "b", b: "a", c: "a" };

/** Every outcome an asker's connections saw for one ask: replies, failed-ask replies, and peer disconnects. */
function outcomeLog() {
	const outcomes: string[] = [];
	return {
		outcomes,
		watch(client: TwoBrokerClient, askId: () => string) {
			client.client.on("message", (_from: unknown, message: { replyTo?: string; replyError?: string }) => {
				if (message.replyTo === askId()) outcomes.push(message.replyError === undefined ? "reply" : "failed");
			});
			client.client.on("peer_disconnected", (notice: { replyTo?: string }) => {
				if (notice.replyTo === askId()) outcomes.push("peer_disconnected");
			});
		},
	};
}

type Placement = "cross-broker" | "same-broker";

/** The asker asks a recipient on node b, from node a ("cross-broker") or from node b too, and the recipient has it. */
async function ask(placement: Placement, log: ReturnType<typeof outcomeLog>, askId: string) {
	const group = unique("g");
	const asker = await harness.connect(placement === "cross-broker" ? "a" : "b", unique("asker"), {
		group,
		beforeConnect: (client) => log.watch(client, () => askId),
	});
	const recipient = await harness.connect("b", unique("recipient"), { group });
	const sent = await asker.client.send(recipient.sessionId, { messageId: askId, text: "q?", expectsReply: true });
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);
	return { group, asker, recipient };
}

/** The session resumes, under the same identity, on the other broker. */
async function moveToOtherBroker(
	moving: TwoBrokerClient,
	beforeConnect?: (client: TwoBrokerClient) => void,
): Promise<TwoBrokerClient> {
	const sessionId = moving.sessionId;
	await moving.client.disconnect({ resumable: true });
	moving.disconnected = true;
	const moved = await harness.connect(OTHER[moving.node], moving.name, {
		group: moving.group,
		returnAddress: moving.returnAddress,
		preferredSessionId: sessionId,
		...(beforeConnect === undefined ? {} : { beforeConnect }),
	});
	assert.equal(moved.sessionId, sessionId);
	return moved;
}

function reply(from: TwoBrokerClient, askerId: string, askId: string) {
	return from.client.send(askerId, {
		text: "answer",
		replyTo: askId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}

const settle = () => new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));

for (const placement of ["cross-broker", "same-broker"] as const) {
	for (const mover of ["asker", "recipient"] as const) {
		test(
			`a ${placement} ask is answered once after its ${mover} moves to the other broker (#4997)`,
			async () => {
				assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
				const log = outcomeLog();
				const askId = randomUUID();
				let { asker, recipient } = await ask(placement, log, askId);
				const askerId = asker.sessionId;
				if (mover === "asker") asker = await moveToOtherBroker(asker, (client) => log.watch(client, () => askId));
				else recipient = await moveToOtherBroker(recipient);

				const replied = await reply(recipient, askerId, askId);

				assert.equal(replied.delivered, true, replied.reason);
				await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
				await harness.disconnect(recipient);
				await settle();
				assert.deepEqual(log.outcomes, ["reply"], "the recipient ending adds no failure");
				await harness.disconnect(asker);
			},
			REAL_BROKERS_TEST_TIMEOUT_MS,
		);

		test(
			`a ${placement} ask fails once when its recipient ends after its ${mover} moved to the other broker (#4997)`,
			async () => {
				const log = outcomeLog();
				const askId = randomUUID();
				let { asker, recipient } = await ask(placement, log, askId);
				if (mover === "asker") asker = await moveToOtherBroker(asker, (client) => log.watch(client, () => askId));
				else recipient = await moveToOtherBroker(recipient);

				await harness.disconnect(recipient);

				await vi.waitFor(() => assert.equal(log.outcomes.length, 1), WAIT);
				assert.notEqual(log.outcomes[0], "reply");
				await settle();
				assert.equal(log.outcomes.length, 1, `the asker is told once: ${JSON.stringify(log.outcomes)}`);
				await harness.disconnect(asker);
			},
			REAL_BROKERS_TEST_TIMEOUT_MS,
		);
	}
}

test(
	"a session that was not asked still cannot answer a moved ask (#4997)",
	async () => {
		const log = outcomeLog();
		const askId = randomUUID();
		const { group, asker, recipient } = await ask("cross-broker", log, askId);
		const moved = await moveToOtherBroker(recipient);
		const bystander = await harness.connect(asker.node, unique("bystander"), { group });

		const refused = await reply(bystander, asker.sessionId, askId);

		assert.equal(refused.delivered, false);
		assert.match(refused.reason ?? "", /does not authorize this public reply/);
		const replied = await reply(moved, asker.sessionId, askId);
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.deepEqual(log.outcomes, ["reply"]), WAIT);
		for (const client of [bystander, moved, asker]) await harness.disconnect(client);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
