import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
	TWO_BROKER_HARNESS_START_TIMEOUT_MS,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes sharing one SQLite file is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = TWO_BROKER_HARNESS_START_TIMEOUT_MS;
const GATED_STARTUP_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs({ gatedStorageOpening: "a" }) + 30_000;
const DELIVERY_WAIT_MS = 15_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test("two real brokers on one SQLite file preserve per-(sender, target) order across mixed local replies, plain sends, and address forms", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("local-order");
	const sender = await harness.connect("a", unique("sender"), { group });
	const targetName = unique("target");
	const targetOnB = await harness.connect("b", targetName, { group });
	const targetId = targetOnB.sessionId;
	const targetReturn = targetOnB.returnAddress;

	// Create two cross-node asks while target is on broker b, then move target to broker a so both ask routes live
	// in shared pendingAsks (forcing extra shared-DB round trips for replies relative to concurrent plain sends).
	const ask1 = await targetOnB.client.send(sender.sessionId, { text: "ask-1", expectsReply: true });
	const ask2 = await targetOnB.client.send(sender.sessionId, { text: "ask-2", expectsReply: true });
	assert.equal(ask1.delivered, true, ask1.reason);
	assert.equal(ask2.delivered, true, ask2.reason);
	await vi.waitFor(() => assert.equal(sender.received.length, 2), { timeout: DELIVERY_WAIT_MS, interval: 20 });
	await targetOnB.client.disconnect({ resumable: true });
	targetOnB.disconnected = true;

	const target = await harness.connect("a", targetName, {
		group,
		returnAddress: targetReturn,
		preferredSessionId: targetId,
	});
	// Keep a live peer on broker b so both brokers actively share the SQLite store.
	const peerB = await harness.connect("b", unique("peer-b"), { group });

	const expected: string[] = [];
	const sends: Promise<unknown>[] = [];
	for (let i = 0; i < 16; i++) {
		const text = `local-seq-${i}`;
		expected.push(text);
		const address = i % 3 === 0 ? target.name : i % 3 === 1 ? target.sessionId : target.sessionId.slice(0, 8);
		if (i === 0) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask1.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else if (i === 5) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask2.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else {
			sends.push(sender.client.send(address, { text }));
		}
	}
	await Promise.all(sends);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				target.received.map((frame) => frame.message.content.text),
				expected,
			),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 20,
		},
	);
	await harness.disconnect(peerB);
	await harness.disconnect(sender);
	await harness.disconnect(target);
});

test("two real brokers on one SQLite file preserve per-(sender, target) send order across nodes with mixed replies and address forms", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("cross-order");
	const sender = await harness.connect("a", unique("sender"), { group });
	const target = await harness.connect("b", unique("target"), { group });

	// Establish a cross-node ask so sender interleaves a correlated reply with plain sends.
	const ask = await target.client.send(sender.sessionId, { text: "cross-ask", expectsReply: true });
	assert.equal(ask.delivered, true, ask.reason);
	await vi.waitFor(() => assert.equal(sender.received.length, 1), { timeout: DELIVERY_WAIT_MS, interval: 20 });

	const expected: string[] = [];
	const sends: Promise<unknown>[] = [];
	for (let i = 0; i < 12; i++) {
		const text = `cross-seq-${i}`;
		expected.push(text);
		const address = i % 3 === 0 ? target.name : i % 3 === 1 ? target.sessionId : target.sessionId.slice(0, 8);
		if (i === 0) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else {
			sends.push(sender.client.send(address, { text }));
		}
	}
	await Promise.all(sends);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				target.received.map((frame) => frame.message.content.text),
				expected,
			),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		},
	);
	await harness.disconnect(sender);
	await harness.disconnect(target);
});

test("two real brokers on one SQLite file deliver offline outbox rows before immediate local sends after target moves to sender's broker", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("offline-to-local");
	const sender = await harness.connect("a", unique("sender"), { group });
	const targetName = unique("mover");
	const initialOnB = await harness.connect("b", targetName, { group });
	const targetId = initialOnB.sessionId;
	const targetReturn = initialOnB.returnAddress;
	await harness.disconnect(initialOnB);

	// Queue 4 messages in the shared outbox while target is offline.
	const queuedTexts = ["queued-0", "queued-1", "queued-2", "queued-3"];
	for (const text of queuedTexts) {
		const res = await sender.client.send(targetId, { text });
		assert.equal(res.queued, true, `expected queued for ${text}: ${JSON.stringify(res)}`);
	}

	// Target reconnects on broker a (same broker as sender); sender immediately fires 4 local sends.
	const returnedOnA = await harness.connect("a", targetName, {
		group,
		returnAddress: targetReturn,
		preferredSessionId: targetId,
	});
	const localTexts = ["local-0", "local-1", "local-2", "local-3"];
	await Promise.all(localTexts.map((text) => sender.client.send(targetId, { text })));

	await vi.waitFor(
		() =>
			assert.deepEqual(
				returnedOnA.received.map((frame) => frame.message.content.text),
				[...queuedTexts, ...localTexts],
			),
		{ timeout: DELIVERY_WAIT_MS, interval: 25 },
	);
	await harness.disconnect(sender);
	await harness.disconnect(returnedOnA);
});

test(
	"sends arriving while multi-node startup transitions from starting to on preserve FIFO order",
	async () => {
		const gated = await TwoBrokerHarness.start({ gatedStorageOpening: "a" });
		cleanups.push(() => gated.cleanup());
		const group = unique("startup-order");
		const sender = await gated.connect("a", unique("sender"), { group });
		const target = await gated.connect("a", unique("target"), { group });

		const firstBatch = ["start-0", "start-1", "start-2"];
		const pending = firstBatch.map((text) => sender.client.send(target.sessionId, { text }));
		gated.setStorageOpening("open");
		const secondBatch = ["after-0", "after-1", "after-2"];
		const after = secondBatch.map((text) => sender.client.send(target.sessionId, { text }));
		await Promise.all([...pending, ...after]);

		await vi.waitFor(
			() =>
				assert.deepEqual(
					target.received.map((frame) => frame.message.content.text),
					[...firstBatch, ...secondBatch],
				),
			{ timeout: DELIVERY_WAIT_MS, interval: 20 },
		);
	},
	GATED_STARTUP_TIMEOUT_MS,
);
