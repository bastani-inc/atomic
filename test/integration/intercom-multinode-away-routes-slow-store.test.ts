import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import { type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/**
 * #4997: with multi-node routing, an ask between two sessions on one broker moves to the shared state when one of them
 * leaves without ending. With a slow shared database that move takes a while: an ask answered, or whose broker crashes,
 * while it is under way still gets exactly one outcome.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 90_000;
/** Every shared database call waits this long, as a remote database would, so the move is still under way. */
const DATABASE_CALL_DELAY_MS = 250;
const WAIT = { timeout: 30_000, interval: 25 };
/** How long an outcome that must not arrive, or must not arrive twice, is given to show up. */
const SETTLE_MS = 2_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ databaseCallDelayMs: DATABASE_CALL_DELAY_MS });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;
const settle = () => new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));

/** Every outcome the asker's connections saw for one ask: replies, failed-ask replies, and peer disconnects. */
function outcomeLog(askId: string) {
	const outcomes: string[] = [];
	return {
		outcomes,
		watch(client: TwoBrokerClient) {
			client.client.on("message", (_from: unknown, message: { replyTo?: string; replyError?: string }) => {
				if (message.replyTo === askId) outcomes.push(message.replyError === undefined ? "reply" : "failed");
			});
			client.client.on("peer_disconnected", (notice: { replyTo?: string }) => {
				if (notice.replyTo === askId) outcomes.push("peer_disconnected");
			});
		},
	};
}

/** An asker and a recipient on node b, and an ask the recipient has. */
async function askOnOneBroker(log: ReturnType<typeof outcomeLog>, askId: string) {
	const group = unique("g");
	const asker = await harness.connect("b", unique("asker"), { group, beforeConnect: (client) => log.watch(client) });
	const recipient = await harness.connect("b", unique("recipient"), { group });
	const sent = await asker.client.send(recipient.sessionId, { messageId: askId, text: "q?", expectsReply: true });
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);
	return { asker, recipient };
}

/** The session leaves without ending, so it may resume. */
async function leaveResumably(session: TwoBrokerClient): Promise<void> {
	await session.client.disconnect({ resumable: true });
	session.disconnected = true;
}

/** The session connects to node b again under the same identity. */
function rejoin(session: TwoBrokerClient, sessionId: string, beforeConnect?: (client: TwoBrokerClient) => void) {
	return harness.connect("b", session.name, {
		group: session.group,
		returnAddress: session.returnAddress,
		preferredSessionId: sessionId,
		...(beforeConnect === undefined ? {} : { beforeConnect }),
	});
}

function reply(from: TwoBrokerClient, askerId: string, askId: string) {
	return from.client.send(askerId, {
		text: "answer",
		replyTo: askId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}

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

for (const leaver of ["asker", "recipient"] as const) {
	for (const then of ["reply", "end"] as const) {
		test(
			`an ask whose broker crashes while it moves to the shared state, after its ${leaver} left, gets one outcome when the recipient then ${then === "reply" ? "replies" : "ends"} (#4997)`,
			async () => {
				const askId = randomUUID();
				const log = outcomeLog(askId);
				const { asker, recipient } = await askOnOneBroker(log, askId);
				const ids = { asker: asker.sessionId, recipient: recipient.sessionId };
				await leaveResumably(leaver === "asker" ? asker : recipient);
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
}

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
