import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { PRESENCE_REGISTRATION_BOUND_MS } from "../../packages/intercom/broker/multinode-router.js";
import {
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * With multi-node routing, a broker asks the shared database whether another broker still has a session that ended for
 * good here before it closes that identity's return paths. A slow answer must not hold up that identity's next
 * registration on this broker.
 */

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { parkablePresenceRead: "a" };
/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/**
 * A registration queued behind the parked read is answered only when its shared registration gives up waiting, after
 * `PRESENCE_REGISTRATION_BOUND_MS`; one that is not queued behind it is answered well within half of that.
 */
const PROMPT_REGISTRATION_BOUND_MS = PRESENCE_REGISTRATION_BOUND_MS / 2;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test("a stalled presence read after a session ends for good does not hold up that identity's next registration", async ({
	annotate,
}) => {
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const group = unique("stalled-read-group");
	const first = await harness.connect("a", unique("stalled-read-sender"), { group });
	const peer = await harness.connect("b", unique("stalled-read-peer"), { group });
	const firstId = first.sessionId;
	harness.holdPresenceRead(first.returnAddress);
	try {
		// It ends for good; its broker's read of the identity's presence on other brokers does not answer.
		await harness.disconnect(first);
		await harness.presenceReadParked(first.returnAddress);
		// It comes back under a new id on the same broker while that read is still unanswered.
		const started = performance.now();
		const back = await harness.connect("a", first.name, { group, returnAddress: first.returnAddress });
		const registrationMs = performance.now() - started;
		assert.notEqual(back.sessionId, firstId);
		assert.ok(registrationMs < PROMPT_REGISTRATION_BOUND_MS, `registration took ${Math.round(registrationMs)} ms`);
		// The other broker reaches it under its new id.
		const sent = await peer.client.send(back.sessionId, { text: "to the new id" });
		assert.equal(sent.delivered, true, JSON.stringify(sent));
		await vi.waitFor(() => assert.equal(back.messagesWithId(sent.id).length, 1));
	} finally {
		harness.releasePresenceRead();
	}
});
