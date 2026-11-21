import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import {
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * #5607: a returning session whose claim of its id went unanswered keeps the id its binding write took, even while
 * another session of it on the same broker asks for that id meanwhile: one live registration per id, so that other one
 * gets a fresh id. The returning session is answered within its registration's usual time, and listed under its id.
 */

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = {
	storageAdapter: resolve(import.meta.dirname, "../fixtures/intercom-local-claim-race.ts"),
};
/** Spawning a real broker process is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
const TEST_TIMEOUT_MS = 60_000;
const WAIT = { interval: 20, timeout: 15_000 };

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"a returning session whose claim went unanswered keeps the id its binding write took, and another session of it asking for that id on the same broker meanwhile gets a fresh id (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const marker = `${harness.sharedDatabasePath}.race`;
		const watcher = await harness.connect("b", "watcher", { group: "one" });
		const original = await harness.connect("b", "original", { group: "one" });
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		await vi.waitFor(
			async () =>
				assert.equal(
					(await watcher.client.listSessions()).some((session) => session.id === id),
					false,
				),
			WAIT,
		);
		writeFileSync(marker, "");
		try {
			const started = performance.now();
			const returning = harness.connect("a", "returning", {
				group: "one",
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			returning.catch(() => {});
			// Its binding write has kept the id; before that write answers, another session of it asks for the id here.
			await vi.waitFor(() => assert.ok(existsSync(`${marker}.selected`)), WAIT);
			const other = await harness.connect("a", "other", {
				group: "two",
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			assert.notEqual(other.sessionId, id, "the id is the returning session's");
			writeFileSync(`${marker}.resume`, "");

			const back = await returning;
			assert.ok(performance.now() - started < BROKER_CONNECT_TIMEOUT_MS, "answered within its client's own wait");
			assert.equal(back.sessionId, id);
			writeFileSync(`${marker}.allow-fresh`, "");
			await vi.waitFor(
				async () => assert.ok((await watcher.client.listSessions()).some((session) => session.id === id)),
				WAIT,
			);
		} finally {
			writeFileSync(`${marker}.resume`, "");
			writeFileSync(`${marker}.allow-fresh`, "");
		}
	},
	TEST_TIMEOUT_MS,
);
