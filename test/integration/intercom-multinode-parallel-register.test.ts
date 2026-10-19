import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/** A zero-delay timer per database call: every call crosses a macrotask, as a remote database's does. */
const DATABASE_CALL_DELAY_MS = 0;
const PARALLEL_SESSIONS = 6;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ databaseCallDelayMs: DATABASE_CALL_DELAY_MS });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test("same-group sessions connecting in parallel to a multi-node broker all register and are routable at once", async () => {
	assert.equal(harness.multiNodeRouting, true);
	const group = unique("parallel");
	const names = Array.from({ length: PARALLEL_SESSIONS }, (_, index) => unique(`parallel-${index}`));
	const results = await Promise.allSettled(names.map((name) => harness.connect("a", name, { group })));
	const failures = results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []));
	assert.deepEqual(failures, []);
	const connected = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	for (const session of connected) assert.deepEqual(session.errors.map(String), [], session.name);

	// Registration still completes only once the presence lease is written: another node delivers at once.
	const sender = await harness.connect("b", unique("parallel-sender"), { group });
	for (const session of connected) {
		const result = await sender.client.send(session.name, { text: "reachable right after registering" });
		assert.equal(result.delivered, true, JSON.stringify(result));
	}
});
