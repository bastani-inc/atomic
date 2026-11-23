import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dialectOf, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import {
	PRESENCE_REGISTRATION_BOUND_MS,
	SESSION_ID_CLAIM_BOUND_MS,
	SESSION_ID_CLAIM_PROGRESS_CAP_MS,
} from "../../packages/intercom/broker/multinode-router.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	SHARED_LEASES_TABLE,
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
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
 * A registration that waits out both its claim and its presence bound leaves its client this much of its wait for
 * everything else: the broker's store I/O, message handling and IPC, which take far longer on a loaded runner.
 */
const REAL_WORK_HEADROOM_MS = 2_000;
/**
 * The broker stops running for this long right after the database wrote the id: far longer than the claim may wait, even
 * when it moves its deadline on (`SESSION_ID_CLAIM_PROGRESS_CAP_MS`), and short enough that a broker that decides once it
 * runs again still has the real work's headroom left of its client's own wait.
 */
const BROKER_STALL_MS = BROKER_CONNECT_TIMEOUT_MS - REAL_WORK_HEADROOM_MS;
/** A claim stalled just past its own bound, so that it gives up on its deadline when the broker runs again. */
const PAST_CLAIM_BOUND_STALL_MS = SESSION_ID_CLAIM_BOUND_MS + 100;
/**
 * How long the broker is busy before it accepts a registration that then stalls past its claim bound and waits its whole
 * presence bound: what the client's wait leaves of those and of the real work's headroom.
 */
const BUSY_BEFORE_ACCEPT_MS =
	BROKER_CONNECT_TIMEOUT_MS - PAST_CLAIM_BOUND_STALL_MS - PRESENCE_REGISTRATION_BOUND_MS - REAL_WORK_HEADROOM_MS;
const TEST_TIMEOUT_MS = 60_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

let sharedDatabase: SqliteDatabase | undefined;

/**
 * Resolves once no broker holds the presence lease of a session with `returnAddress` in the shared database. A departing
 * session's broker gives up the session's id before it releases that lease, so a registration that brings it back
 * finds the id free. Another node's `list` cannot tell: when the database is slow to answer, it answers without any
 * remote session.
 */
async function presenceReleased(returnAddress: string): Promise<void> {
	sharedDatabase ??= await harness.openSharedStorage("b");
	const database = sharedDatabase;
	// The start of every delivery identity of that session, whatever its group, as the presence lease's key writes it.
	const identities = `${JSON.stringify(["return", returnAddress]).slice(0, -1)},`;
	await vi.waitFor(
		async () => {
			const row = await database.get<{ live: number | bigint }>(
				`SELECT count(*) AS live FROM "${SHARED_LEASES_TABLE}"
				 WHERE kind = 'presence' AND holder_id IS NOT NULL AND substr(key, 1, length(?)) = ?`,
				identities,
				identities,
			);
			assert.equal(Number(row?.live ?? 0), 0, "a broker still presents the session that left");
		},
		{ timeout: 15_000 },
	);
}

/**
 * What the shared database holds for a session that returns with id `id` from `returnAddress`, for a failure to name: the
 * bindings of the id and of any fresh id the session got (the claim that last bound each, its owner, and when that owner
 * last renewed it), the presence leases of the return address, the session's known-session rows and the brokers'
 * membership leases, with the database's clock. The claim of the id, the reclaim of an unanswered claim and the departure
 * of the session's earlier registration each decide from these rows (#5607).
 */
async function sharedRowsFor(id: string, returnAddress: string): Promise<string> {
	sharedDatabase ??= await harness.openSharedStorage("b");
	const database = sharedDatabase;
	const { nowMs } = dialectOf(database);
	const identities = `${JSON.stringify(["return", returnAddress]).slice(0, -1)},`;
	const [clock, bindings, presence, known, brokers] = await Promise.all([
		database.get(`SELECT ${nowMs} AS now`),
		database.all(
			`SELECT * FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_session_bindings WHERE intercom_session_id = ? OR return_address = ?`,
			id,
			returnAddress,
		),
		database.all(
			`SELECT key, holder_id, fencing_token, renewed_at FROM "${SHARED_LEASES_TABLE}"
			 WHERE kind = 'presence' AND substr(key, 1, length(?)) = ?`,
			identities,
			identities,
		),
		database.all(
			`SELECT * FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_known_sessions WHERE intercom_session_id = ? OR atomic_session_id = ?`,
			id,
			returnAddress,
		),
		database.all(`SELECT key, holder_id, renewed_at FROM "${SHARED_LEASES_TABLE}" WHERE kind = 'broker'`),
	]);
	return JSON.stringify({ clock, bindings, presence, known, brokers }, (_key, value: unknown) =>
		typeof value === "bigint" ? Number(value) : value,
	);
}

/**
 * Runs `region`, the return of the session with id `id` from `returnAddress`: one that fails says how long it ran and what
 * the shared database held for the session then, so a failure on a loaded runner can be told apart from a lost id.
 */
async function explained(id: string, returnAddress: string, region: () => Promise<void>): Promise<void> {
	const started = performance.now();
	try {
		await region();
	} catch (error) {
		const elapsedMs = Math.round(performance.now() - started);
		const rows = await sharedRowsFor(id, returnAddress).catch((read: Error) => `(unreadable: ${read.message})`);
		if (error instanceof Error) error.message = `${error.message}\nafter ${elapsedMs} ms; shared rows: ${rows}`;
		throw error;
	}
}

/** The database's clock, and when it last recorded the session with id `id` as known (undefined: never). */
async function knownRecord(id: string): Promise<{ now: number; recordedAt: number | undefined }> {
	sharedDatabase ??= await harness.openSharedStorage("b");
	const database = sharedDatabase;
	const row = await database.get<{ now: number | bigint; recorded_at: number | bigint | null }>(
		`SELECT ${dialectOf(database).nowMs} AS now,
			(SELECT max(recorded_at) FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_known_sessions WHERE intercom_session_id = ?) AS recorded_at`,
		id,
	);
	assert.ok(row !== undefined);
	return { now: Number(row.now), recordedAt: row.recorded_at === null ? undefined : Number(row.recorded_at) };
}

/**
 * `original` leaves as a session that will return, and this resolves once its broker has finished its departure (its
 * presence is gone from `observer`'s list and from the shared database, and the departure has recorded the session, its
 * last write), so the registration that brings it back does not queue behind that work, and `holdRegistration` parks
 * that registration's record of the session, never the departure's.
 */
async function leaveAway(original: TwoBrokerClient, observer: TwoBrokerClient): Promise<string> {
	const id = original.sessionId;
	// The departure's record of the session is told from its registration's by a later time on the database's clock.
	const registeredAt = await vi.waitFor(
		async () => {
			const { recordedAt } = await knownRecord(id);
			assert.ok(recordedAt !== undefined, "the registration has not recorded the session yet");
			return recordedAt;
		},
		{ timeout: 15_000 },
	);
	await vi.waitFor(async () => assert.ok((await knownRecord(id)).now > registeredAt), { timeout: 15_000 });
	await original.client.disconnect({ resumable: true });
	original.disconnected = true;
	await vi.waitFor(
		async () => assert.ok(!(await observer.client.listSessions()).some((session) => session.id === id)),
		{ timeout: 15_000 },
	);
	await presenceReleased(original.returnAddress);
	await vi.waitFor(
		async () => {
			const { recordedAt } = await knownRecord(id);
			assert.ok(
				recordedAt !== undefined && recordedAt > registeredAt,
				"the departure has not recorded the session yet",
			);
		},
		{ timeout: 15_000 },
	);
	return id;
}

test(
	"a returning session whose broker stalls while the database's answer is held keeps the id the database wrote for it, before its client gives up (#5607)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: no id is claimed through the shared database");
			return;
		}
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await leaveAway(original, observer);
		assert.ok(
			BROKER_STALL_MS > SESSION_ID_CLAIM_PROGRESS_CAP_MS,
			"the broker stalls past every deadline of the claim",
		);
		harness.stallIdClaim(original.returnAddress, BROKER_STALL_MS);

		// The client waits as long as a real session's does.
		await explained(id, original.returnAddress, async () => {
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
		const id = await leaveAway(original, observer);
		// The database binds the id at once; its answer is read only after the broker runs again, past the deadline.
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

		await explained(id, original.returnAddress, async () => {
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

		await explained(id, original.returnAddress, async () => {
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
			await presenceReleased(original.returnAddress);
			// The same session is back on the other broker first, and stays connected there.
			const live = await harness.connect("b", original.name, {
				...(group === undefined ? {} : { group: unique(group) }),
				returnAddress: original.returnAddress,
				preferredSessionId: id,
			});
			assert.equal(live.sessionId, id);
			harness.stallIdClaim(original.returnAddress, 3_500, undefined, undefined, "serial bindings");

			await explained(id, original.returnAddress, async () => {
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
	"a returning session keeps the id the database wrote for it when another overdue callback stalls the broker after the id deadline (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await leaveAway(original, observer);

		harness.stallIdClaim(original.returnAddress, 2_800, 3_200);
		harness.holdRegistration(original.name);
		try {
			await explained(id, original.returnAddress, async () => {
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
			await presenceReleased(original.returnAddress);
			harness.stallIdClaim(original.returnAddress, PAST_CLAIM_BOUND_STALL_MS);

			await explained(id, original.returnAddress, async () => {
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
	await presenceReleased(original.returnAddress);
	if (slowWrite === "serial bindings")
		harness.stallIdClaim(original.returnAddress, 3_500, undefined, 3_050, slowWrite);
	else harness.stallIdClaim(original.returnAddress, 2_800, 3_200, 3_050, slowWrite);
	let back: TwoBrokerClient | undefined;
	await explained(preferredSessionId, original.returnAddress, async () => {
		back = await harness.connect("a", original.name, {
			returnAddress: original.returnAddress,
			preferredSessionId,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			socketPath,
		});
		assert.ok(harness.idClaimStalled(original.returnAddress));
		// The database wrote the id for this registration before the broker stalled, whichever write is slow after it.
		assert.equal(back.sessionId, preferredSessionId);
	});
	assert.ok(back !== undefined);
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
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await leaveAway(original, observer);

		// The client starts its 10 s wait while the broker is busy with an unrelated registration.
		const other = randomUUID();
		harness.stallIdClaim(other, BUSY_BEFORE_ACCEPT_MS);
		const busy = harness.connect("a", unique("other"), { returnAddress: other, preferredSessionId: randomUUID() });
		try {
			await vi.waitFor(() => assert.ok(harness.idClaimStalled(other)), { timeout: 15_000, interval: 10 });
			harness.stallIdClaim(original.returnAddress, PAST_CLAIM_BOUND_STALL_MS);
			harness.holdRegistration(original.name);
			await explained(id, original.returnAddress, async () => {
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

test(
	"a returning session whose broker stalls for most of the client deadline still registers with its kept id even when recording and presence are slow (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const observer = await harness.connect("b", unique("observer"));
		const original = await harness.connect("a", unique("returning"));
		const id = await leaveAway(original, observer);
		// A 6 s claim stall leaves 4 s of the client's 10 s connect timeout: waiting a full 5 s presence bound after
		// reclaim already kept the id would exceed the client's 10 s deadline.
		const LONG_CLAIM_STALL_MS = 6_000;
		harness.stallIdClaim(original.returnAddress, LONG_CLAIM_STALL_MS);
		harness.holdRegistration(original.name);
		try {
			await explained(id, original.returnAddress, async () => {
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
