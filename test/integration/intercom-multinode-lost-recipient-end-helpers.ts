import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { LOST_RECIPIENT_AFTER_ENV } from "../../packages/intercom/broker/lost-recipients.js";
import { OUTBOX_BACKUP_POLL_INTERVAL_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	type TwoBrokerClient,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #5154: a recipient that ends while its broker is killed before the broker records the departure leaves no trace of
 * its end. Once its broker restarted and it has not come back within the lost-recipient bound, its askers are told
 * once that it is unavailable; one that comes back within the bound still answers.
 */

/** The brokers' shortened lost-recipient bound (`LOST_RECIPIENT_UNAVAILABLE_AFTER_MS` is minutes). */
const LOST_AFTER_MS = 3_000;
/** Every shared database call waits this long, so a kill within 100 ms lands before the departure's first write. */
const DATABASE_CALL_DELAY_MS = 250;
const HARNESS_OPTIONS: TwoBrokerHarnessOptions = {
	databaseCallDelayMs: DATABASE_CALL_DELAY_MS,
	brokerEnv: { [LOST_RECIPIENT_AFTER_ENV]: String(LOST_AFTER_MS) },
};
/** Spawning, killing and restarting real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/** A lost recipient is noticed at the first backup poll past the bound. */
export const TOLD_WITHIN_MS = LOST_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS + 15_000;
/** Each scenario restarts broker b on the slow database. */
const BROKER_RESTART_MS = twoBrokerHarnessStartTimeoutMs({ ...HARNESS_OPTIONS, nodes: ["b"] });
/** A broker restart, the scenario's own work, and up to two waits for an outcome. */
export const TEST_TIMEOUT_MS = BROKER_RESTART_MS + 60_000 + 2 * TOLD_WITHIN_MS;
export const WAIT = { timeout: 45_000, interval: 25 };
/** How long an outcome that must not arrive twice is given to show up. */
export const SETTLE_MS = 1_500;

export let harness: TwoBrokerHarness;

export function useLostRecipientEndBrokers(): void {
	beforeAll(async () => {
		harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
	}, REAL_BROKERS_HOOK_TIMEOUT_MS);
	afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
	beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);
}

export const outcomesOf = (asker: TwoBrokerClient, askId: string) =>
	asker.received.filter((frame) => frame.message.replyTo === askId);

export async function askAcross(group: string) {
	const asker = await harness.connect("a", "asker", { group });
	const recipient = await harness.connect("b", "recipient", { group });
	// Registration resolves at PRESENCE_REGISTRATION_BOUND_MS if the slow shared store has not finished writing the
	// presence lease yet; wait until both brokers see the live presence leases before sending across nodes.
	await vi.waitFor(async () => {
		const [seenByAsker, seenByRecipient] = await Promise.all([
			asker.client.listSessions(group),
			recipient.client.listSessions(group),
		]);
		assert.ok(
			seenByAsker.some((session) => session.id === recipient.sessionId),
			"recipient presence is visible to broker a",
		);
		assert.ok(
			seenByRecipient.some((session) => session.id === asker.sessionId),
			"asker presence is visible to broker b",
		);
	}, WAIT);
	const registration = { returnAddress: recipient.returnAddress, sessionId: recipient.sessionId };
	const askId = randomUUID();
	const sent = await asker.client.send(recipient.sessionId, {
		messageId: askId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(sent.delivered, true, sent.reason ?? JSON.stringify(sent));
	await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1, "the recipient has the ask"), WAIT);
	return { asker, recipient, registration, askId };
}

export async function runLostRecipientUnavailableScenario(killAfterMs: number): Promise<void> {
	const group = `lost-${randomUUID().slice(0, 8)}`;
	const { asker, registration, recipient, askId } = await askAcross(group);
	let back: TwoBrokerClient | undefined;
	try {
		const leaving = harness.disconnect(recipient);
		await sleep(killAfterMs);
		await harness.stopBroker("b", "SIGKILL");
		await leaving;
		await harness.startBroker("b");
		const restartedAt = Date.now();

		await vi.waitFor(() => assert.equal(outcomesOf(asker, askId).length, 1, "told"), {
			timeout: TOLD_WITHIN_MS,
			interval: 100,
		});
		assert.ok(Date.now() - restartedAt >= LOST_AFTER_MS, "not told before the bound");
		const [failure] = outcomesOf(asker, askId);
		assert.match(failure!.message.replyError ?? "", /^Session "recipient" is unavailable: its broker stopped/);
		assert.equal(failure!.message.retryLater, true);

		// The session comes back after its ask failed: its late reply, as the intercom tool sends one, is refused.
		back = await harness.connect("b", "recipient", {
			group,
			returnAddress: registration.returnAddress,
			preferredSessionId: registration.sessionId,
		});
		const late = await back.client
			.send(asker.sessionId, { text: "8080", replyTo: askId, requirePendingReply: true })
			.catch((error: Error) => ({ delivered: false, reason: error.message }));
		assert.equal(late.delivered, false, "the late reply is refused");
		await sleep(SETTLE_MS);
		assert.equal(outcomesOf(asker, askId).length, 1, "told once");
	} finally {
		if (back !== undefined) await harness.disconnect(back);
		await harness.disconnect(asker);
	}
}
