import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import {
	type TwoBrokerClient,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * #5607: with multi-node routing, an Intercom id has one live registration. A second registration of the same session
 * while the first is live gets a fresh id; once the first has left, the session gets its id back on any broker.
 */

/** Spawning a real broker process is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs();
const TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 15_000, interval: 25 };

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

async function idsListedBy(client: TwoBrokerClient): Promise<string[]> {
	return (await client.client.listSessions()).map((session) => session.id);
}

for (const sameGroup of [true, false]) {
	test(
		`a session that registers on another broker while it is live gets a fresh id, not the one it holds (${sameGroup ? "same" : "another"} group) (#5607)`,
		async () => {
			assert.equal(harness.multiNodeRouting, true);
			const live = await harness.connect("a", unique("live"));
			const id = live.sessionId;

			const twin = await harness.connect("b", live.name, {
				...(sameGroup ? {} : { group: unique("group") }),
				returnAddress: live.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});

			assert.notEqual(twin.sessionId, id);
			assert.equal(live.sessionId, id);
			await harness.disconnect(twin);
		},
		TEST_TIMEOUT_MS,
	);
}

test(
	"a session gets its id back on another broker once its registration on the first has left (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;

		const back = await harness.connect("b", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});

		assert.equal(back.sessionId, id);
		await vi.waitFor(async () => assert.ok((await idsListedBy(observer)).includes(id)), WAIT);
	},
	TEST_TIMEOUT_MS,
);
