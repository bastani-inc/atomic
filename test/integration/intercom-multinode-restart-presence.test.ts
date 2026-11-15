import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/** Spawning two real broker processes (and restarting one) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/**
 * #5038: once a session re-registers on its restarted broker, a send from the other broker reaches it within a few
 * seconds, far inside the 30 s window the crashed instance's presence lease would otherwise stay live.
 */
const RESTARTED_DELIVERY_BOUND_MS = 5_000;
/** Settle time after delivery in which a duplicate frame would have arrived. */
const DUPLICATE_WINDOW_MS = 1_000;
const TEST_TIMEOUT_MS = 60_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

interface Registration {
	readonly name: string;
	readonly returnAddress: string | undefined;
	readonly sessionId: string;
}

/** What a session needs to come back as itself; read while it is still registered. */
const registrationOf = (client: TwoBrokerClient): Registration => ({
	name: client.name,
	returnAddress: client.returnAddress,
	sessionId: client.sessionId,
});

async function reconnect(registration: Registration, node: "a" | "b", group: string): Promise<TwoBrokerClient> {
	const back = await harness.connect(node, registration.name, {
		group,
		returnAddress: registration.returnAddress,
		preferredSessionId: registration.sessionId,
	});
	assert.equal(back.sessionId, registration.sessionId);
	return back;
}

test(
	"a session that re-registers on its restarted broker receives cross-broker sends at once (#5038)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const group = unique("restart");
		const recipient = registrationOf(await harness.connect("b", unique("restart-recipient"), { group }));
		const sender = registrationOf(await harness.connect("b", unique("restart-sender"), { group }));
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");
		const back = await reconnect(recipient, "b", group);
		const moved = await reconnect(sender, "a", group);

		const started = Date.now();
		const result = await moved.client.send(back.sessionId, { text: "after restart" });
		const elapsed = Date.now() - started;
		assert.equal(result.delivered, true, JSON.stringify(result));
		assert.ok(elapsed < RESTARTED_DELIVERY_BOUND_MS, `delivered after ${elapsed} ms`);
		await vi.waitFor(() => assert.equal(back.messagesWithId(result.id).length, 1), {
			timeout: RESTARTED_DELIVERY_BOUND_MS,
			interval: 25,
		});
		await sleep(DUPLICATE_WINDOW_MS);
		assert.equal(back.messagesWithId(result.id).length, 1);
	},
	TEST_TIMEOUT_MS,
);

test(
	"a session that has not re-registered after its broker restarted is queued, then delivered once (#5038)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const group = unique("restart-away");
		const recipient = registrationOf(await harness.connect("b", unique("away-recipient"), { group }));
		const sender = await harness.connect("a", unique("away-sender"), { group });
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");

		const started = Date.now();
		const queued = await sender.client.send(recipient.sessionId, { text: "while away" });
		const elapsed = Date.now() - started;
		assert.equal(queued.delivered, false, JSON.stringify(queued));
		assert.equal(queued.queued, true, JSON.stringify(queued));
		assert.ok(elapsed < RESTARTED_DELIVERY_BOUND_MS, `queued after ${elapsed} ms`);

		const back = await reconnect(recipient, "b", group);
		await vi.waitFor(() => assert.equal(back.messagesWithId(queued.id).length, 1), {
			timeout: RESTARTED_DELIVERY_BOUND_MS,
			interval: 25,
		});
		await sleep(DUPLICATE_WINDOW_MS);
		assert.equal(back.messagesWithId(queued.id).length, 1);
	},
	TEST_TIMEOUT_MS,
);
