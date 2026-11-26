import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

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

function send(messageId: string) {
	return [
		{ messageId, digest: messageId, targetIdentity: "target-a" },
		{
			targetIdentity: "target-a",
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

	test("a send costs three round trips: its reads with the start, its row, its reservation with the commit (#6560)", async () => {
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
				assert.equal(sendTrips, 3);
				assert.equal(renewTrips, 2);
				assert.equal((await state.outbox.read("m-1")).status, "found");
				assert.equal((await state.sentMessages.lookup({ messageId: "m-1", digest: "m-1" })).status, "match");
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});
});
