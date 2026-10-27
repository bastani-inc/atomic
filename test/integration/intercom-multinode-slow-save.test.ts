import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVING_REPORT_INTERVAL_MS,
	SEND_RESPONSE_TIMEOUT_MS,
} from "../../packages/intercom/retry-policy.js";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/** The remote save is held past both the broker's receipt wait and the sender's own response wait. */
const HELD_SAVE_MS = SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS;
const SLOW_SAVE_TEST_TIMEOUT_MS = 4 * HELD_SAVE_MS;
const ARRIVAL_WAIT_MS = 15_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"a cross-node send whose remote recipient is still saving it past the receipt wait is delivered once (#3983)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const sender = await harness.connect("a", unique("slow-save-sender"));
		// The recipient confirms by hand: its save is held behind a gate, as a pooled stage's journal commit waits
		// behind other writers, and it reports progress while the save is in flight, as the Intercom extension does.
		const recipient = await harness.connect("b", unique("slow-save-recipient"), { acknowledgeReceipts: false });
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const messageId = randomUUID();
		try {
			const sent = sender.client.send(recipient.name, { text: "held behind a busy journal", messageId });
			await vi.waitFor(() => assert.equal(recipient.messagesWithId(messageId).length, 1), {
				timeout: ARRIVAL_WAIT_MS,
				interval: 25,
			});
			const saving = setInterval(
				() => recipient.client.reportSaving(messageId),
				RECIPIENT_SAVING_REPORT_INTERVAL_MS,
			);
			void gate.then(() => {
				clearInterval(saving);
				recipient.client.acknowledgeReceived(messageId);
			});
			await new Promise((resolveHold) => setTimeout(resolveHold, HELD_SAVE_MS));
			release();
			const result = await sent;
			assert.equal(result.delivered, true, JSON.stringify(result));
			assert.equal(recipient.messagesWithId(messageId).length, 1, "the held message was delivered exactly once");
		} finally {
			release();
		}
	},
	SLOW_SAVE_TEST_TIMEOUT_MS,
);

test(
	"a cross-node send whose remote recipient stops reporting progress still ends uncertain (#3983)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const sender = await harness.connect("a", unique("dead-save-sender"));
		const recipient = await harness.connect("b", unique("dead-save-recipient"), { acknowledgeReceipts: false });
		const messageId = randomUUID();
		const sent = sender.client.send(recipient.name, { text: "never saved", messageId });
		await vi.waitFor(() => assert.equal(recipient.messagesWithId(messageId).length, 1), {
			timeout: ARRIVAL_WAIT_MS,
			interval: 25,
		});
		// It reports once, then hangs: no more reports and no confirmation.
		recipient.client.reportSaving(messageId);
		const result = await sent;
		assert.equal(result.delivered, false, JSON.stringify(result));
		assert.match(result.reason ?? "", /did not confirm that it saved the message in time/);
	},
	SLOW_SAVE_TEST_TIMEOUT_MS,
);
