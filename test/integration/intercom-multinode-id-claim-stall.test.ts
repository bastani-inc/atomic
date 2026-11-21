import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	TWO_BROKER_STORAGE_PREFIX,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { IntercomWireProxy } from "../helpers/intercom-wire-proxy.js";

/**
 * #5607: with multi-node routing, a session that registers again asks for its Intercom id back, and its broker waits a
 * bounded time for the shared database to confirm the id. When the broker stalls past that bound, the binding write it
 * makes for the session in its place keeps the id if the database wrote it for this registration and no broker on
 * another node presents the session; otherwise the session gets a fresh id. The client's deadline also includes time
 * waiting for the broker to accept the socket, bind the chosen id and publish it for other brokers.
 */

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { stallableIdClaims: true, parkableRegistrations: true };
/** Spawning a real broker process is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/**
 * The broker stops running for this long right after the database wrote the id: far longer than the claim may wait, and
 * short enough that a broker that decides once it runs again still registers the session well within its client's own
 * wait.
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
	"a returning session whose broker stalls while the database's answer is held keeps the id the database wrote for it, before its client gives up (#5607)",
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
		assert.equal(back.sessionId, id, "the database wrote the id for this registration");
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps its id when its broker stalls past the claim deadline after the database answered (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		// The database binds the id at once; its answer is read only after the broker runs again, past the deadline.
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

		const back = await harness.connect("a", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});

		assert.equal(harness.idClaimStalled(original.returnAddress), true, "the broker stalled while it claimed the id");
		assert.equal(back.sessionId, id);
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session whose id the database has not bound when its broker stalls past the claim deadline gets a fresh id before its client gives up (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		// The binding is still being written when the broker stops; the database holds it, then refuses it.
		harness.stallIdClaim(original.returnAddress, 2_800, undefined, 6_000, "uncommitted");

		const back = await harness.connect("a", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});

		assert.equal(harness.idClaimStalled(original.returnAddress), true, "the broker stalled while it claimed the id");
		assert.notEqual(back.sessionId, id, "an id the database never bound for it is not granted");
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session whose broker stalls past the claim deadline gets a fresh id while a session on another broker presents its id (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;
		// The same session is back on the other broker first, and stays connected there.
		const live = await harness.connect("b", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
		});
		assert.equal(live.sessionId, id);
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

		const back = await harness.connect("a", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId: id,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});

		assert.equal(harness.idClaimStalled(original.returnAddress), true, "the broker stalled while it claimed the id");
		assert.notEqual(back.sessionId, id, "a live session on another broker presents the id");
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps the id the database wrote for it when another overdue callback stalls the broker after the id deadline (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const original = await harness.connect("a", unique("returning"));
		const id = original.sessionId;
		await original.client.disconnect({ resumable: true });
		original.disconnected = true;

		harness.stallIdClaim(original.returnAddress, 2_800, 3_200);
		harness.holdRegistration(original.name);
		try {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});
			assert.ok(harness.idClaimStalled(original.returnAddress));
			await harness.registrationParked(original.name);
			assert.equal(back.sessionId, id, "the database wrote the id for this registration");
		} finally {
			harness.releaseRegistration();
		}
	},
	TEST_TIMEOUT_MS,
);

type SlowWrite = "fresh binding" | "serial bindings" | "known session";

async function reconnectWithSlowWrite(slowWrite: SlowWrite, socketPath?: string) {
	const observer = await harness.connect("a", unique("observer"));
	const original = await harness.connect("b", unique("returning"));
	const preferredSessionId = original.sessionId;
	await original.client.disconnect({ resumable: true });
	original.disconnected = true;
	// Start on the other broker after the old lease is released. Otherwise the timed registration can wait on
	// the old connection's own departure instead of measuring the cost of the binding or the known-session write.
	await vi.waitFor(
		async () => {
			assert.ok(!(await observer.client.listSessions()).some((session) => session.id === preferredSessionId));
		},
		{ timeout: 15_000 },
	);
	if (slowWrite === "serial bindings")
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, 3_050, slowWrite);
	else harness.stallIdClaim(original.returnAddress, 2_800, 3_200, 3_050, slowWrite);
	const back = await harness.connect("a", original.name, {
		returnAddress: original.returnAddress,
		preferredSessionId,
		connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		socketPath,
	});
	assert.ok(harness.idClaimStalled(original.returnAddress));
	// The database wrote the id for this registration before the broker stalled, whichever write is slow after it.
	assert.equal(back.sessionId, preferredSessionId);
	return { back, preferredSessionId };
}

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
				reconnectWithSlowWrite(slowWrite, socketPath),
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

test.each(slowWrites)(
	"a peer can list and send to the acknowledged id, the one the database wrote, immediately with a slow %s write (#5607)",
	async (slowWrite) => {
		const peer = await harness.connect("b", unique("peer"));
		const { back, preferredSessionId } = await reconnectWithSlowWrite(slowWrite);
		const listed = await peer.client.listSessions();
		const sent = await peer.client.send(back.sessionId, { text: "at registration" });
		assert.equal(sent.delivered, true, sent.reason);
		assert.ok(listed.some((session) => session.id === back.sessionId));
		if (slowWrite === "serial bindings") {
			// Even when the peer saw the ID in time, an unused binding must not occupy the store's writer.
			const store = await harness.openSharedStorage("b");
			const unused = await store.all(
				`SELECT intercom_session_id FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_session_bindings
				 WHERE return_address = ? AND intercom_session_id NOT IN (?, ?)`,
				back.returnAddress,
				preferredSessionId,
				back.sessionId,
			);
			assert.deepEqual(unused, []);
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps the id the database wrote for it when its broker accepts late, stalls during the id check and waits for presence (#5607)",
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
			assert.equal(back.sessionId, id, "the database wrote the id for this registration");
		} finally {
			harness.releaseRegistration();
			await busy;
		}
	},
	TEST_TIMEOUT_MS,
);
