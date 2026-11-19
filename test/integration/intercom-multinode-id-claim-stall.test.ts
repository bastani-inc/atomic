import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import {
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * #5607: with multi-node routing, a session that registers again asks for its Intercom id back, and its broker waits a
 * bounded time for the shared database to confirm the id. A broker that stalls must read a ready confirmation,
 * but not delay a fresh id when there is no confirmation and the client's registration deadline is running.
 */

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { nodes: ["a"], stallableIdClaims: true, parkableRegistrations: true };
/** Spawning a real broker process is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/**
 * The broker stops running for this long right after it asks for the id: far longer than the claim may wait, and short
 * enough that a broker that decides once it runs again still registers the session well within its client's own wait.
 */
const BROKER_STALL_MS = 8_200;
const TEST_TIMEOUT_MS = 60_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"a returning session whose broker stalls while the database does not confirm its id still registers before its client gives up (#5607)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: no id is claimed through the shared database");
			return;
		}
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		harness.stallIdClaim(original.returnAddress, BROKER_STALL_MS);

		// The client waits as long as a real session's does.
		const back = await harness.connect("a", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});

		assert.equal(harness.idClaimStalled(original.returnAddress), true, "the broker stalled while it claimed the id");
		assert.notEqual(back.sessionId, id, "an id the database never confirmed is not granted");
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session still registers when its broker accepts late, stalls during the id check and waits for presence (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;

		// The client starts its 10 s wait while the broker is busy with an unrelated registration.
		const other = randomUUID();
		harness.stallIdClaim(other, 1_450);
		const busy = harness.connect("a", unique("other"), { returnAddress: other, preferredSessionId: randomUUID() });
		try {
			await vi.waitFor(() => assert.ok(harness.idClaimStalled(other)), { timeout: 15_000, interval: 10 });
			harness.stallIdClaim(original.returnAddress, 2_800);
			harness.holdRegistration(original.name);
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			assert.ok(harness.idClaimStalled(original.returnAddress));
			await harness.registrationParked(original.name);
			assert.notEqual(back.sessionId, id);
		} finally {
			harness.releaseRegistration();
			await busy;
		}
	},
	TEST_TIMEOUT_MS,
);
