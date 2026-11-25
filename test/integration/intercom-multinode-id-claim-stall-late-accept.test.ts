import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import type { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { IntercomWireProxy } from "../helpers/intercom-wire-proxy.js";
import {
	BUSY_BEFORE_ACCEPT_MS,
	IdClaimStallSupport,
	PAST_CLAIM_BOUND_STALL_MS,
	REAL_BROKERS_HOOK_TIMEOUT_MS,
	unique,
} from "./intercom-multinode-id-claim-stall-helpers.js";

const TEST_TIMEOUT_MS = 60_000;

let support: IdClaimStallSupport;
let harness: TwoBrokerHarness;

beforeAll(async () => {
	support = await IdClaimStallSupport.start();
	harness = support.harness;
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => support?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"a returning session keeps the id the database wrote for it when another overdue callback stalls the broker after the id deadline (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, observer);

		harness.stallIdClaim(original.returnAddress, 2_800, 3_200);
		harness.holdRegistration(original.name);
		try {
			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});
				assert.ok(harness.idClaimStalled(original.returnAddress));
				await harness.registrationParked(original.name);
				assert.equal(back.sessionId, id, "the database wrote the id for this registration");
			});
		} finally {
			harness.releaseRegistration();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps the id the database wrote for it while its broker is still recording the departure of its earlier connection (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		// The departure's last write, the record of the session that left, waits on the database: the broker is still
		// working through that departure when the session comes back.
		harness.holdRegistration(original.name);
		try {
			await original.client.disconnect({ resumable: true });
			original.disconnected = true;
			await harness.registrationParked(original.name);
			await support.presenceReleased(original.returnAddress);
			harness.stallIdClaim(original.returnAddress, PAST_CLAIM_BOUND_STALL_MS);

			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});
				assert.ok(harness.idClaimStalled(original.returnAddress));
				assert.equal(back.sessionId, id, "the database wrote the id for this registration");
			});
		} finally {
			harness.releaseRegistration();
		}
	},
	TEST_TIMEOUT_MS,
);

const slowWrites = ["fresh binding", "serial bindings", "known session"] as const;

test.each(slowWrites)(
	"a late-accepted registration keeps the id the database wrote for it and finishes before the client deadline with a slow %s write (#5607)",
	async (slowWrite) => {
		const socketPath = getBrokerSocketPath(process.platform, join(harness.root, "front"));
		const proxy = new IntercomWireProxy(socketPath, harness.socketPath("a"));
		await proxy.listen();
		try {
			proxy.hold(() => true);
			await Promise.all([
				support.reconnectWithSlowWrite(slowWrite, socketPath),
				(async () => {
					await vi.waitFor(() => assert.equal(proxy.heldConnections(), 1), { interval: 10, timeout: 15_000 });
					await delay(2_600);
					proxy.release();
				})(),
			]);
		} finally {
			await proxy.close();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps the id the database wrote for it when its broker accepts late, stalls during the id check and waits for presence (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, observer);

		// The client starts its 10 s wait while the broker is busy with an unrelated registration.
		const other = randomUUID();
		harness.stallIdClaim(other, BUSY_BEFORE_ACCEPT_MS);
		const busy = harness.connect("a", unique("other"), { returnAddress: other, preferredSessionId: randomUUID() });
		try {
			await vi.waitFor(() => assert.ok(harness.idClaimStalled(other)), { timeout: 15_000, interval: 10 });
			harness.stallIdClaim(original.returnAddress, PAST_CLAIM_BOUND_STALL_MS);
			harness.holdRegistration(original.name);
			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});
				assert.ok(harness.idClaimStalled(original.returnAddress));
				await harness.registrationParked(original.name);
				assert.equal(back.sessionId, id, "the database wrote the id for this registration");
			});
		} finally {
			harness.releaseRegistration();
			await busy;
		}
	},
	TEST_TIMEOUT_MS,
);
