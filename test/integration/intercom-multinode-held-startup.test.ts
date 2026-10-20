import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { SendResult } from "../../packages/intercom/broker/client.js";
import { type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * Broker "a" opens the shared storage only when the test lets it: what it does for its sessions while multi-node
 * routing is still starting, and what it carries into routing once it starts.
 */

/** Spawning two real broker processes (and restarting one) is the structural cost of this suite. */
const REAL_BROKERS_TIMEOUT_MS = 60_000;
/** A local send never waits for the shared storage to open; far above the bound it does wait. */
const LOCAL_SEND_WAIT_MS = 3_000;
/** Router startup after a failed opening includes its first retry backoff (1 s). */
const ROUTING_STARTED_WAIT_MS = 15_000;
/** A send still unanswered after this is being held, not refused. */
const HELD_PROBE_MS = 1_000;
const SETTLE_MS = 500;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ gatedStorageOpening: "a" });
}, REAL_BROKERS_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

async function within(result: Promise<SendResult>, ms: number): Promise<SendResult | undefined> {
	return Promise.race([result, sleep(ms).then(() => undefined)]);
}

/** Send until the target is held rather than refused, as a sender retrying `Session not found` would. */
async function sendUntilHeld(
	sender: TwoBrokerClient,
	target: string,
	text: string,
): Promise<{ readonly outcome: Promise<SendResult> }> {
	const deadline = Date.now() + ROUTING_STARTED_WAIT_MS;
	for (;;) {
		const attempt = sender.client.send(target, { text });
		const settled = await within(attempt, HELD_PROBE_MS);
		if (settled === undefined) return { outcome: attempt };
		assert.equal(settled.reason, "Session not found", `unexpected answer to ${target}: ${settled.reason}`);
		assert.ok(Date.now() < deadline, `${target} was never held through the other broker`);
	}
}

test(
	"a send between sessions on one broker is delivered once while its shared storage is still opening",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const sender = await harness.connect("a", unique("local-sender"));
		const recipient = await harness.connect("a", unique("local-recipient"));
		const sent = await within(
			sender.client.send(recipient.name, { text: "local during startup" }),
			LOCAL_SEND_WAIT_MS,
		);
		assert.ok(sent !== undefined, "the local send waited for the shared storage to open");
		assert.equal(sent.delivered, true, JSON.stringify(sent));

		harness.setStorageOpening("open");
		const remote = await harness.connect("b", unique("remote-sender"));
		await vi.waitFor(
			async () => {
				const routed = await remote.client.send(recipient.name, { text: "routing started" });
				assert.equal(routed.delivered, true, JSON.stringify(routed));
			},
			{ timeout: ROUTING_STARTED_WAIT_MS, interval: 200 },
		);
		await sleep(SETTLE_MS);
		assert.equal(recipient.messagesWithId(sent.id).length, 1, "startup dispatched the local send again");
	},
	REAL_BROKERS_TIMEOUT_MS,
);

test(
	"a restoring reservation made while shared storage was opening holds remote sends once routing starts after a failed attempt",
	async () => {
		await harness.stopBroker("a", "SIGTERM");
		harness.setStorageOpening("held");
		await harness.startBroker("a");

		const supervisor = await harness.connect("a", unique("supervisor"), { supervisorOwnerToken: randomUUID() });
		const childName = unique("restoring-child");
		const reserved = await supervisor.client.authorizeSupervisorChild(childName);
		await supervisor.client.reserveRestoringRecipient(reserved.capability, { group: "default" });
		const releasedName = unique("released-child");
		const released = await supervisor.client.authorizeSupervisorChild(releasedName);
		await supervisor.client.reserveRestoringRecipient(released.capability, { group: "default" });
		await supervisor.client.releaseRestoringRecipient(released.capability);

		harness.setStorageOpening("fail");
		await sleep(SETTLE_MS);
		harness.setStorageOpening("open");

		const sender = await harness.connect("b", unique("remote-sender"));
		const held = await sendUntilHeld(sender, childName, "held for the restored child");
		const refused = await sender.client.send(releasedName, { text: "released before routing started" });
		assert.equal(refused.reason, "Session not found");

		const child = await harness.connect("a", childName, { supervisor: reserved });
		const delivered = await held.outcome;
		assert.equal(delivered.delivered, true, JSON.stringify(delivered));
		await sleep(SETTLE_MS);
		assert.deepEqual(
			child.received.map((frame) => frame.message.content.text),
			["held for the restored child"],
		);
	},
	REAL_BROKERS_TIMEOUT_MS,
);
