import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { queryIntercomBroker } from "../../packages/intercom/broker/control.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import {
	BROKER_START_ALLOWANCE_MS,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";
import {
	assertUnrouted,
	confirmDelivered,
	DELIVERY_WAIT_MS,
	REAL_BROKERS_HOOK_TIMEOUT_MS,
	RECOVERY_MARGIN_MS,
	unique,
	waitForMessage,
} from "./intercom-multinode-two-broker-helpers.js";

/** A harness whose every shared database call waits 20 ms. */
const DELAYED_HARNESS: TwoBrokerHarnessOptions = { databaseCallDelayMs: 20 };
/** It starts both brokers, then restarts one. */
const DELAYED_HARNESS_TEST_TIMEOUT_MS =
	twoBrokerHarnessStartTimeoutMs(DELAYED_HARNESS) +
	twoBrokerHarnessStartTimeoutMs({ ...DELAYED_HARNESS, nodes: ["b"] }) +
	30_000;
/** These scenarios restart a broker before the windows they wait out. */
const OFFLINE_QUEUED_TEST_TIMEOUT_MS =
	BROKER_START_ALLOWANCE_MS + BROKER_LEASE_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS + RECOVERY_MARGIN_MS;
const BROKER_KILL_WAIT_MS = BROKER_LEASE_STALE_AFTER_MS + OUTBOX_CLAIM_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS;
const BROKER_KILL_TEST_TIMEOUT_MS = BROKER_START_ALLOWANCE_MS + BROKER_KILL_WAIT_MS + RECOVERY_MARGIN_MS;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"a restarted two-broker fixture waits for shared routing to open (#3857)",
	async () => {
		const delayed = await TwoBrokerHarness.start(DELAYED_HARNESS);
		try {
			await delayed.stopBroker("b", "SIGTERM");
			await delayed.startBroker("b");
			const status = await queryIntercomBroker(delayed.agentDir("b"));
			assert.ok(status.state === "running");
			assert.equal(status.report.multiNode.status, "on");
		} finally {
			await delayed.cleanup();
		}
	},
	DELAYED_HARNESS_TEST_TIMEOUT_MS,
);

test(
	"a send to a recipient whose broker is down is queued, then delivered when that broker starts again",
	async ({ annotate }) => {
		const sender = await harness.connect("a", unique("offline-sender"));
		const recipient = await harness.connect("b", unique("offline-recipient"));
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
			await assertUnrouted(sender, recipient);
			return;
		}
		const recipientId = recipient.sessionId;
		await harness.stopBroker("b", "SIGKILL");
		await sleep(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const text = "held for an offline session";
		const queued = await sender.client.send(recipientId, { text });
		assert.equal(queued.delivered, false, JSON.stringify(queued));
		assert.equal(queued.queued, true, JSON.stringify(queued));
		assert.ok(queued.target);

		await harness.startBroker("b");
		const back = await harness.connect("b", recipient.name, {
			returnAddress: recipient.returnAddress,
			preferredSessionId: recipientId,
		});
		await waitForMessage(back, queued.id, OUTBOX_BACKUP_POLL_INTERVAL_MS + DELIVERY_WAIT_MS);
		await confirmDelivered(sender, recipientId, text, queued.id, DELIVERY_WAIT_MS);
		assert.equal(back.messagesWithId(queued.id).length, 1);
	},
	OFFLINE_QUEUED_TEST_TIMEOUT_MS,
);

test(
	"a message claimed by a broker that crashes before the recipient's ack is redelivered after restart",
	async ({ annotate }) => {
		const sender = await harness.connect("a", unique("crash-sender"));
		const recipient = await harness.connect("b", unique("crash-recipient"), { acknowledgeReceipts: false });
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
			await assertUnrouted(sender, recipient);
			return;
		}
		const recipientId = recipient.sessionId;
		const messageId = randomUUID();
		const text = "survives a broker crash";
		const firstAttempt = sender.client.send(recipient.name, { text, messageId }).then(
			(result) => result,
			(error: Error) => error,
		);
		await waitForMessage(recipient, messageId);
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");
		const back = await harness.connect("b", recipient.name, {
			returnAddress: recipient.returnAddress,
			preferredSessionId: recipientId,
		});
		const redelivered = await waitForMessage(back, messageId, BROKER_KILL_WAIT_MS);
		assert.equal(redelivered.message.content.text, text);
		assert.equal(redelivered.from.id, sender.sessionId);
		await firstAttempt;
		await confirmDelivered(sender, recipient.name, text, messageId, DELIVERY_WAIT_MS);
		assert.equal(back.messagesWithId(messageId).length, 1);
	},
	BROKER_KILL_TEST_TIMEOUT_MS,
);
