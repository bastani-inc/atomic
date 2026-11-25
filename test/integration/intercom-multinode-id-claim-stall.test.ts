import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { SESSION_ID_CLAIM_PROGRESS_CAP_MS } from "../../packages/intercom/broker/multinode-router.js";
import type { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import {
	BROKER_STALL_MS,
	IdClaimStallSupport,
	REAL_BROKERS_HOOK_TIMEOUT_MS,
	unique,
} from "./intercom-multinode-id-claim-stall-helpers.js";

/**
 * #5607: with multi-node routing, a session that registers again asks for its Intercom id back, and its broker waits a
 * bounded time for the shared database to confirm the id. When the broker stalls past that bound, the binding write it
 * makes for the session in its place keeps the id if the database wrote it for this registration and no broker on
 * another node presents the session; otherwise the session gets a fresh id. The client's deadline also includes time
 * waiting for the broker to accept the socket, bind the chosen id and publish it for other brokers.
 */

const TEST_TIMEOUT_MS = 60_000;

let support: IdClaimStallSupport;
let harness: TwoBrokerHarness;

beforeAll(async () => {
	support = await IdClaimStallSupport.start();
	harness = support.harness;
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => support?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

test(
	"a returning session whose broker stalls while the database's answer is held keeps the id the database wrote for it, before its client gives up (#5607)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: no id is claimed through the shared database");
			return;
		}
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, observer);
		assert.ok(
			BROKER_STALL_MS > SESSION_ID_CLAIM_PROGRESS_CAP_MS,
			"the broker stalls past every deadline of the claim",
		);
		harness.stallIdClaim(original.returnAddress, BROKER_STALL_MS);

		// The client waits as long as a real session's does.
		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});

			assert.equal(
				harness.idClaimStalled(original.returnAddress),
				true,
				"the broker stalled while it claimed the id",
			);
			assert.equal(back.sessionId, id, "the database wrote the id for this registration");
		});
	},
	TEST_TIMEOUT_MS,
);

test(
	"a returning session keeps its id when its broker stalls past the claim deadline after the database answered (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, observer);
		// The database binds the id at once; its answer is read only after the broker runs again, past the deadline.
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});

			assert.equal(
				harness.idClaimStalled(original.returnAddress),
				true,
				"the broker stalled while it claimed the id",
			);
			assert.equal(back.sessionId, id);
		});
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

		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			});

			assert.equal(
				harness.idClaimStalled(original.returnAddress),
				true,
				"the broker stalled while it claimed the id",
			);
			assert.notEqual(back.sessionId, id, "an id the database never bound for it is not granted");
		});
	},
	TEST_TIMEOUT_MS,
);

for (const group of [undefined, "other"] as const) {
	test(
		`a returning session whose broker stalls past the claim deadline gets a fresh id while a session on another broker presents its id (${group === undefined ? "same" : "another"} group) (#5607)`,
		async () => {
			assert.equal(harness.multiNodeRouting, true);
			const original = await harness.connect("a", unique("returning"));
			const id = original.sessionId;
			await original.client.disconnect({ resumable: true });
			original.disconnected = true;
			await support.presenceReleased(original.returnAddress);
			// The same session is back on the other broker first, and stays connected there.
			const live = await harness.connect("b", original.name, {
				...(group === undefined ? {} : { group: unique(group) }),
				returnAddress: original.returnAddress,
				preferredSessionId: id,
			});
			assert.equal(live.sessionId, id);
			harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});

				assert.equal(
					harness.idClaimStalled(original.returnAddress),
					true,
					"the broker stalled while it claimed the id",
				);
				assert.notEqual(back.sessionId, id, "a live session on another broker presents the id");
			});
		},
		TEST_TIMEOUT_MS,
	);
}

test(
	"a returning session whose broker stalls for most of the client deadline still registers with its kept id even when recording and presence are slow (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, observer);
		// A 6 s claim stall leaves 4 s of the client's 10 s connect timeout: waiting a full 5 s presence bound after
		// reclaim already kept the id would exceed the client's 10 s deadline.
		const LONG_CLAIM_STALL_MS = 6_000;
		harness.stallIdClaim(original.returnAddress, LONG_CLAIM_STALL_MS);
		harness.holdRegistration(original.name);
		try {
			await support.explained(id, original.returnAddress, async () => {
				const back = await harness.connect("a", original.name, {
					returnAddress: original.returnAddress,
					preferredSessionId: id,
					connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				});
				assert.equal(harness.idClaimStalled(original.returnAddress), true);
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
	"a returning session after a 9.6 s broker stall honours a custom 15 s connectTimeoutMs, keeping its claimed id and publishing presence (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const peer = await harness.connect("b", unique("peer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await support.leaveAway(original, peer);
		harness.stallIdClaim(original.returnAddress, 9_600);

		await support.explained(id, original.returnAddress, async () => {
			const back = await harness.connect("a", original.name, {
				returnAddress: original.returnAddress,
				preferredSessionId: id,
				connectTimeoutMs: 15_000,
			});
			assert.equal(harness.idClaimStalled(original.returnAddress), true);
			assert.equal(back.sessionId, id, "custom 15 s connect timeout gives reclaim and presence time to finish");
			const listed = await peer.client.listSessions();
			assert.ok(
				listed.some((session) => session.id === back.sessionId),
				"peer lists kept id immediately",
			);
		});
	},
	TEST_TIMEOUT_MS,
);
