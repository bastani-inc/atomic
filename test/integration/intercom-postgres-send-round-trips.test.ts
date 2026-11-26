import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import { fencedPath } from "../../packages/coding-agent/src/core/storage/fenced-paths.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { sleep } from "../helpers/runtime.js";

/**
 * Counts the round trips to the server: queries a connection sent while none of its own were unanswered. The adapter's
 * pg is this one, so patching the client prototype reaches the adapter's connections.
 */
function countRoundTrips() {
	const query = pg.Client.prototype.query;
	const unanswered = new WeakMap<pg.Client, number>();
	let trips = 0;
	const counting = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const pending = unanswered.get(this) ?? 0;
		if (pending === 0) trips += 1;
		unanswered.set(this, pending + 1);
		const answered = () => unanswered.set(this, (unanswered.get(this) ?? 1) - 1);
		const result = Reflect.apply(query, this, args) as unknown as Promise<unknown>;
		void result.then(answered, answered);
		return result;
	};
	pg.Client.prototype.query = counting as pg.Client["query"];
	restores.push(() => {
		pg.Client.prototype.query = query;
	});
	return {
		take() {
			const counted = trips;
			trips = 0;
			return counted;
		},
	};
}

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

function send(messageId: string, targetIdentity = "target-a") {
	return [
		{ messageId, digest: messageId, targetIdentity },
		{
			targetIdentity,
			originBrokerId: "broker-a",
			digest: messageId,
			frame: { type: "message", from, message: { id: messageId, timestamp: 1, content: { text: messageId } } },
		},
	] as const;
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom send round trips on PostgreSQL (#6560)", () => {
	test("a heartbeat renewing several leases sends their updates together, not one round trip each (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				const leases = [];
				for (const target of ["target-a", "target-b", "target-c", "target-d"]) {
					const presence = { kind: "presence", targetIdentity: target, session: { ...from, id: target } } as const;
					const acquired = await state.leases.acquire(presence, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
					assert.equal(acquired.status, "acquired");
					if (acquired.status === "acquired") leases.push({ lease: acquired.lease, subject: presence });
				}
				const trips = countRoundTrips();
				const renewed = await state.leases.renewMany!(leases);
				const renewTrips = trips.take();
				assert.deepEqual(
					renewed.map((result) => result.status),
					["renewed", "renewed", "renewed", "renewed"],
				);
				assert.ok(renewTrips <= 3, `${renewTrips} round trips for four renewals`);
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("claimed messages marked delivered at once settle in one transaction: two round trips, not two each (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				for (const id of ["m-1", "m-2", "m-3", "m-4"])
					assert.equal((await state.reserveAndEnqueue!(...send(id))).status, "inserted");
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(claimed.status, "claimed");
				if (claimed.status !== "claimed") return;
				assert.equal(claimed.rows.length, 4);
				const trips = countRoundTrips();
				const delivered = await Promise.all(claimed.rows.map(({ claim }) => state.outbox.markDelivered(claim)));
				const deliveredTrips = trips.take();
				assert.deepEqual(
					delivered.map((result) => (result.status === "delivered" ? result.row.messageId : result.status)),
					["m-1", "m-2", "m-3", "m-4"],
				);
				// The update with the transaction's start, then the commit. Eight before: two for each message.
				assert.equal(deliveredTrips, 2);
				for (const id of ["m-1", "m-2", "m-3", "m-4"]) {
					const read = await state.outbox.read(id);
					assert.equal(read.status === "found" ? read.row.state : read.status, "delivered");
				}
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("each of the deliveries settled together answers as if it ran alone, in the order made (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				for (const id of ["m-1", "m-2", "m-3"])
					assert.equal((await state.reserveAndEnqueue!(...send(id))).status, "inserted");
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(claimed.status, "claimed");
				if (claimed.status !== "claimed") return;
				const [first, second, third] = claimed.rows.map(({ claim }) => claim);
				assert.ok(first !== undefined && second !== undefined && third !== undefined);
				assert.equal((await state.outbox.markFailed(third, "refused")).status, "failed");
				const results = await Promise.all([
					state.outbox.markDelivered(first),
					// Another claim of the same row, made after: the row is delivered by then.
					state.outbox.markDelivered({ ...first, token: "another-claim" }),
					// The same claim again: delivered once, settled the second time.
					state.outbox.markDelivered(first),
					state.outbox.markDelivered({ ...second, token: "an-earlier-claim" }),
					state.outbox.markDelivered(second),
					state.outbox.markDelivered(third),
					state.outbox.markDelivered({ ...first, messageId: "never-queued" }),
				]);
				assert.deepEqual(
					results.map((result) =>
						"row" in result ? `${result.status} ${result.row.messageId} ${result.row.state}` : result.status,
					),
					[
						"delivered m-1 delivered",
						"settled m-1 delivered",
						"settled m-1 delivered",
						"stale",
						"delivered m-2 delivered",
						"settled m-3 failed",
						"unknown",
					],
				);
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("a send costs one round trip: its statements go with its start and its commit, decided by the database", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				// The connection is opened and the outbox's tables exist before counting starts.
				assert.equal((await state.reserveAndEnqueue!(...send("m-warm"))).status, "inserted");
				const trips = countRoundTrips();
				assert.equal((await state.reserveAndEnqueue!(...send("m-1"))).status, "inserted");
				const sendTrips = trips.take();
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(claimed.status, "claimed");
				if (claimed.status !== "claimed") return;
				trips.take();
				assert.equal((await state.outbox.renewClaim(claimed.rows[0]!.claim)).status, "renewed");
				const renewTrips = trips.take();
				// Three before: the reads with the start, the row, the reservation with the commit, the recipient's lock held
				// across the two round trips between them.
				assert.equal(sendTrips, 1);
				assert.equal(renewTrips, 2);
				assert.equal((await state.outbox.read("m-1")).status, "found");
				assert.equal((await state.sentMessages.lookup({ messageId: "m-1", digest: "m-1" })).status, "match");
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("a lease acquisition costs one round trip, and a presence one more to wait for the sends under way", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const broker = (brokerId: string) => ({ kind: "broker", brokerId, nodeId: "n", startedAt: 1 }) as const;
			const presence = { kind: "presence", targetIdentity: "target-a", session: { ...from, id: "r" } } as const;
			try {
				assert.equal(
					(await state.leases.acquire(broker("warm"), "warm", BROKER_LEASE_STALE_AFTER_MS)).status,
					"acquired",
				);
				const trips = countRoundTrips();
				const first = await state.leases.acquire(broker("broker-a"), "broker-a", BROKER_LEASE_STALE_AFTER_MS);
				assert.equal(first.status === "acquired" ? first.lease.fencingToken : first.status, 1);
				// Before: the start, the statement, the commit.
				assert.equal(trips.take(), 1);
				const held = await state.leases.acquire(broker("broker-a"), "broker-b", BROKER_LEASE_STALE_AFTER_MS);
				assert.deepEqual(held, { status: "held", holderId: "broker-a", fencingToken: 1 });
				assert.equal(trips.take(), 1);
				assert.equal(
					(await state.leases.acquire(presence, "broker-a", BROKER_LEASE_STALE_AFTER_MS)).status,
					"acquired",
				);
				assert.equal(trips.take(), 2);
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("a send to a recipient found offline costs one round trip too, its host's wake-up hint included", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const presence = { kind: "presence", targetIdentity: "target-a", session: { ...from, id: "r" } } as const;
			const offline = (messageId: string) => {
				const [reservation, request] = send(messageId);
				return [reservation, { ...request, wakeHostWithinMs: BROKER_LEASE_STALE_AFTER_MS }] as const;
			};
			try {
				assert.equal((await state.reserveAndEnqueue!(...offline("m-warm"))).status, "inserted");
				const trips = countRoundTrips();
				const unhosted = await state.reserveAndEnqueue!(...offline("m-unhosted"));
				assert.equal(unhosted.status === "inserted" ? (unhosted.woke ?? "none") : unhosted.status, "none");
				// Before: the reads with the start, the row with the presence read, the hint log's lock, the hint and its
				// notification, the reservation with the commit, the recipient's lock held across every round trip between.
				assert.equal(trips.take(), 1);
				assert.equal(
					(await state.leases.acquire(presence, "broker-host", BROKER_LEASE_STALE_AFTER_MS)).status,
					"acquired",
				);
				trips.take();
				const hosted = await state.reserveAndEnqueue!(...offline("m-hosted"));
				assert.equal(hosted.status === "inserted" ? hosted.woke : hosted.status, "broker-host");
				// One for the transaction; its notification goes once it committed, and the send does not wait for it.
				assert.equal(trips.take(), 1);
				await sleep(200);
				assert.equal(trips.take(), 1);
				const database = await open();
				try {
					const hints = await database.all<{ broker_id: string; version: number | bigint }>(
						"SELECT broker_id, version FROM intercom_wakeups ORDER BY id",
					);
					const read = await state.outbox.read("m-hosted");
					assert.deepEqual(
						hints.map((hint) => [hint.broker_id, Number(hint.version)]),
						[["broker-host", read.status === "found" ? read.row.sequence : -1]],
					);
					// Another session holds the hint log locked: the send queues its row at once, without its hint.
					let locked!: () => void;
					const holding = new Promise<void>((resolve) => {
						locked = resolve;
					});
					let release!: () => void;
					const released = new Promise<void>((resolve) => {
						release = resolve;
					});
					const holder = database.transaction(
						async (tx) => {
							await tx.exec("LOCK TABLE intercom_wakeups IN SHARE MODE");
							locked();
							await released;
						},
						{ concurrency: { kind: "fenced", audit: fencedPath("intercom-wakeup-hint") } },
					);
					await holding;
					try {
						trips.take();
						const sent = await state.reserveAndEnqueue!(...offline("m-locked"));
						assert.equal(sent.status === "inserted" ? (sent.woke ?? "none") : sent.status, "none");
						assert.equal(trips.take(), 1);
					} finally {
						release();
						await holder;
					}
					assert.equal((await database.all("SELECT id FROM intercom_wakeups")).length, 1);
				} finally {
					await database.close();
				}
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("a send in one round trip answers as one decided across round trips: full, resent, refused", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const database = await open();
			try {
				assert.equal((await state.reserveAndEnqueue!(...send("m-big"))).status, "inserted");
				// The recipient's queue holds as many bytes as it may.
				await database.run(
					"UPDATE intercom_outbox SET frame_bytes = ? WHERE message_id = 'm-big'",
					OUTBOX_TARGET_MAX_BYTES,
				);
				const full = { status: "full", limit: OUTBOX_TARGET_MAX_ROWS, byteLimit: OUTBOX_TARGET_MAX_BYTES };
				const reservation = (messageId: string, digest = messageId) =>
					state.sentMessages.lookup({ messageId, digest });
				// Refused, and its message stays unreserved.
				assert.deepEqual(await state.reserveAndEnqueue!(...send("m-new")), full);
				assert.equal((await reservation("m-new")).status, "miss");
				// A send whose message was reserved before is refused too, and its reservation goes.
				assert.equal((await state.sentMessages.reserve(send("m-earlier")[0])).status, "reserved");
				assert.deepEqual(await state.reserveAndEnqueue!(...send("m-earlier")), full);
				assert.equal((await reservation("m-earlier")).status, "miss");
				// A queued message sent again is answered with its row, full queue or not, and stays reserved.
				const resent = await state.reserveAndEnqueue!(...send("m-big"));
				assert.equal(resent.status === "duplicate" ? resent.row.messageId : resent.status, "m-big");
				assert.equal((await reservation("m-big")).status, "match");
				// Another digest's reservation refuses the send and is left as it was.
				assert.equal(
					(await state.sentMessages.reserve({ messageId: "m-rival", digest: "rival", targetIdentity: "target-c" }))
						.status,
					"reserved",
				);
				assert.deepEqual(await state.reserveAndEnqueue!(...send("m-rival", "target-c")), {
					status: "conflict",
					messageId: "m-rival",
				});
				assert.equal((await reservation("m-rival", "rival")).status, "match");
				assert.equal((await state.outbox.read("m-rival")).status, "missing");
				// Another recipient's row of the message, of another digest, refuses it, and no reservation of it is left.
				const elsewhere = send("m-shared", "target-b")[1];
				assert.equal((await state.outbox.enqueue({ ...elsewhere, digest: "elsewhere" })).status, "inserted");
				assert.deepEqual(await state.reserveAndEnqueue!(...send("m-shared", "target-c")), {
					status: "conflict",
					messageId: "m-shared",
				});
				assert.equal((await reservation("m-shared")).status, "miss");
				// Room again: the next send is queued behind the first.
				await database.run("UPDATE intercom_outbox SET frame_bytes = 1 WHERE message_id = 'm-big'");
				const queued = await state.reserveAndEnqueue!(...send("m-after"));
				assert.equal(queued.status, "inserted");
				const listed = await state.outbox.listUndelivered("target-a");
				assert.deepEqual(listed.status === "listed" ? listed.rows.map((row) => row.messageId) : listed, [
					"m-big",
					"m-after",
				]);
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});
});
