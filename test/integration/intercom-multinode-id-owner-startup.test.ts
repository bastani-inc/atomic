import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { queryIntercomBroker } from "../../packages/intercom/broker/control.js";
import {
	type TwoBrokerClient,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * #5607: broker "a" opens the shared storage only when the test lets it. A session it registered meanwhile under an id
 * that a live session on broker "b" holds is disconnected once a's routing across nodes is on: one live registration
 * per id once both brokers route across nodes.
 */

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs({ gatedStorageOpening: "a" });
const TEST_TIMEOUT_MS = 60_000;
/** Router startup after the gate opens includes reading the shared state; well above it on a loaded machine. */
const ROUTING_ON_WAIT = { timeout: 20_000, interval: 25 };

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ gatedStorageOpening: "a" });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	harness?.setStorageOpening("open");
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

async function routingOf(node: "a" | "b"): Promise<string | undefined> {
	const broker = await queryIntercomBroker(harness.agentDir(node));
	return broker.state === "running" ? broker.report.multiNode.status : undefined;
}

function disconnectedOnce(client: TwoBrokerClient): Promise<void> {
	return new Promise((resolve) => client.client.once("disconnected", () => resolve()));
}

test(
	"a session registered while its broker was still opening shared routing is disconnected once routing is on, when a session on another broker holds its id (#5607)",
	async () => {
		const id = randomUUID();
		const returnAddress = randomUUID();
		const owner = await harness.connect("b", unique("owner"), { preferredSessionId: id, returnAddress });
		assert.equal(owner.sessionId, id);
		assert.equal(await routingOf("a"), "starting");
		// Nothing shared to check against yet: broker a gives the id it was asked for, as before.
		const early = await harness.connect("a", unique("early"), { preferredSessionId: id, returnAddress });
		assert.equal(early.sessionId, id);
		const left = disconnectedOnce(early);

		harness.setStorageOpening("open");
		await vi.waitFor(async () => assert.equal(await routingOf("a"), "on"), ROUTING_ON_WAIT);
		await vi.waitFor(() => left, ROUTING_ON_WAIT);

		assert.equal(owner.client.isConnected(), true, "the session that held the id keeps it");
		assert.equal(owner.sessionId, id);
		const again = await harness.connect("a", early.name, {
			preferredSessionId: id,
			returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});
		assert.notEqual(again.sessionId, id, "while the other session is live, the returning one gets a fresh id");
	},
	TEST_TIMEOUT_MS,
);
