import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import { fencedPath } from "../../packages/coding-agent/src/core/storage/fenced-paths.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
	reservationKeyFor,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { sleep } from "../helpers/runtime.js";

const pgbouncerUrl = process.env.ATOMIC_TEST_PGBOUNCER_URL || undefined;
if (
	pgbouncerUrl === undefined &&
	postgresSkipReason === undefined &&
	process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1"
)
	throw new Error("ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ATOMIC_TEST_PGBOUNCER_URL is not set");

interface PostgresRoute {
	readonly name: string;
	readonly skipReason: string | undefined;
	open(scope: PostgresScope): ReturnType<PostgresScope["open"]>;
}

const postgresRoutes: readonly PostgresRoute[] = [
	{
		name: "direct",
		skipReason: postgresSkipReason,
		open: (scope) => scope.open(),
	},
	{
		name: "through PgBouncer in transaction mode",
		skipReason:
			postgresSkipReason ?? (pgbouncerUrl === undefined ? "ATOMIC_TEST_PGBOUNCER_URL is not set" : undefined),
		open: (scope) => {
			const url = new URL(pgbouncerUrl!);
			url.pathname = `/${scope.name}`;
			return openPostgresDatabase({
				url: url.href,
				...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
			});
		},
	},
];

/**
 * Counts the round trips and SQL statements sent to the server: round trips are queries a connection sent while none of
 * its own were unanswered; statements count every non-control query (excluding `BEGIN` and `COMMIT`). The adapter's pg
 * is this one, so patching the client prototype reaches the adapter's connections.
 */
function countRoundTrips() {
	const query = pg.Client.prototype.query;
	const unanswered = new WeakMap<pg.Client, number>();
	let trips = 0;
	const sqls: string[] = [];
	const counting = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const pending = unanswered.get(this) ?? 0;
		if (pending === 0) trips += 1;
		unanswered.set(this, pending + 1);
		const first: string | pg.QueryConfig = args[0] as string | pg.QueryConfig;
		const text = typeof first === "string" ? first : first.text;
		sqls.push(text);
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
			sqls.length = 0;
			return counted;
		},
		takeWithStatements() {
			const counted = trips;
			const captured = sqls.splice(0);
			trips = 0;
			const statements = captured.filter((text) => !/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(text));
			return { trips: counted, statements };
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
	for (const route of postgresRoutes) {
		test.skipIf(route.skipReason !== undefined)(
			`a heartbeat renewing several leases and restoring reservations runs in one round trip and one update statement ${route.name} (#6560, #6714)`,
			async () => {
				await withPostgresDatabase(async (scope) => {
					// Open directly first so the database schema exists, then open through the tested route.
					const direct = await openIntercomBrokerState({ openDatabase: () => scope.open() });
					const { state, bus } = await openIntercomBrokerState({ openDatabase: () => route.open(scope) });
					try {
						const leases = [];
						for (const target of ["target-a", "target-b", "target-c", "target-d"]) {
							const presence = {
								kind: "presence",
								targetIdentity: target,
								session: { ...from, id: target },
							} as const;
							const acquired = await state.leases.acquire(presence, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
							assert.equal(acquired.status, "acquired");
							if (acquired.status === "acquired") leases.push({ lease: acquired.lease, subject: presence });
						}
						const trips = countRoundTrips();
						// Happy path: all 4 owned leases renewed in 1 round trip, 1 UPDATE + 1 gated follow-up read
						// (before #6714: 3 round trips and 4 UPDATE statements).
						const renewedAll = await state.leases.renewMany!(leases);
						const allMetrics = trips.takeWithStatements();
						assert.deepEqual(
							renewedAll.map((result) => result.status),
							["renewed", "renewed", "renewed", "renewed"],
						);
						assert.equal(allMetrics.trips, 1, `${allMetrics.trips} round trips for 4 lease renewals`);
						assert.equal(
							allMetrics.statements.filter((sql) => /\bUPDATE\b/i.test(sql)).length,
							1,
							"one UPDATE statement for all leases",
						);
						assert.equal(allMetrics.statements.length, 2, "one UPDATE plus one gated follow-up read");

						// Stale path: steal target-b on another broker and release target-d; still 1 round trip and
						// 2 statements (before #6714: 5 round trips and 6 statements — 4 UPDATEs + 2 sequential reads).
						const stolen = await direct.state.leases.acquire(leases[1]!.subject, "broker-b", -1);
						assert.equal(stolen.status, "acquired");
						assert.equal((await direct.state.leases.release(leases[3]!.lease)).status, "released");
						trips.takeWithStatements();
						const renewedMixed = await state.leases.renewMany!(leases);
						const mixedMetrics = trips.takeWithStatements();
						assert.deepEqual(renewedMixed, [
							{ status: "renewed" },
							{
								status: "stale",
								currentFencingToken: stolen.status === "acquired" ? stolen.lease.fencingToken : -1,
							},
							{ status: "renewed" },
							{ status: "stale" },
						]);
						assert.equal(mixedMetrics.trips, 1, `${mixedMetrics.trips} round trips for mixed lease renewals`);
						assert.equal(
							mixedMetrics.statements.filter((sql) => /\bUPDATE\b/i.test(sql)).length,
							1,
							"one UPDATE statement for mixed leases",
						);
						assert.equal(
							mixedMetrics.statements.length,
							2,
							"one UPDATE plus one follow-up read for missed leases",
						);

						// Swapped fencing tokens between target-a (token 1) and target-c (re-acquired with token 2).
						assert.equal((await state.leases.release(leases[2]!.lease)).status, "released");
						const targetCReacquired = await state.leases.acquire(
							leases[2]!.subject,
							"broker-a",
							BROKER_LEASE_STALE_AFTER_MS,
						);
						assert.equal(targetCReacquired.status, "acquired");
						if (targetCReacquired.status !== "acquired") return;
						assert.notEqual(leases[0]!.lease.fencingToken, targetCReacquired.lease.fencingToken);
						trips.takeWithStatements();
						const swappedLeases = await state.leases.renewMany!([
							{ lease: { ...leases[0]!.lease, fencingToken: targetCReacquired.lease.fencingToken } },
							{ lease: { ...targetCReacquired.lease, fencingToken: leases[0]!.lease.fencingToken } },
						]);
						const swappedMetrics = trips.takeWithStatements();
						assert.deepEqual(swappedLeases, [
							{ status: "stale", currentFencingToken: leases[0]!.lease.fencingToken },
							{ status: "stale", currentFencingToken: targetCReacquired.lease.fencingToken },
						]);
						assert.equal(swappedMetrics.trips, 1);

						// Restoring reservations: 4 reservations renewed in 1 round trip and 1 UPDATE statement
						// (before #6714: 16 round trips and 8 statements across 4 transactions).
						const reservations = [];
						for (const index of [0, 1, 2, 3]) {
							const reserved = await state.reservations.reserve({
								reservationKey: reservationKeyFor(`rt-resv-${index}`),
								ownerSessionId: "owner-1",
								ownerBrokerId: "broker-a",
								childName: `child-${index}`,
								childTarget: `child-${index}`,
								aliases: [],
								group: "team",
								dormant: false,
								wake: false,
							});
							assert.equal(reserved.status, "reserved");
							if (reserved.status === "reserved") reservations.push(reserved.lease);
						}
						trips.takeWithStatements();
						const renewedResvs = await state.reservations.renewMany!(reservations);
						const resvAllMetrics = trips.takeWithStatements();
						assert.deepEqual(
							renewedResvs.map((result) => result.status),
							["renewed", "renewed", "renewed", "renewed"],
						);
						assert.equal(
							resvAllMetrics.trips,
							1,
							`${resvAllMetrics.trips} round trips for 4 reservation renewals`,
						);
						assert.equal(
							resvAllMetrics.statements.filter((sql) => /\bUPDATE\b/i.test(sql)).length,
							1,
							"one UPDATE statement for all reservations",
						);
						assert.equal(resvAllMetrics.statements.length, 2, "one UPDATE plus one gated follow-up read");

						// Mixed reservations: mark #1 gone (still renewed!), release #2 (ended -> stale), steal #3 (stale with token).
						assert.equal(
							(await direct.state.reservations.release(reservations[1]!, { gone: "gone" })).status,
							"gone",
						);
						assert.equal((await direct.state.reservations.release(reservations[2]!)).status, "released");
						const takenResv = await direct.state.reservations.reserve({
							reservationKey: reservations[3]!.reservationKey,
							ownerSessionId: "owner-2",
							ownerBrokerId: "broker-b",
							childName: "child-3",
							childTarget: "child-3",
							aliases: [],
							group: "team",
							dormant: false,
							wake: false,
						});
						assert.equal(takenResv.status, "reserved");
						trips.takeWithStatements();
						const mixedResvs = await state.reservations.renewMany!(reservations);
						const resvMixedMetrics = trips.takeWithStatements();
						assert.deepEqual(mixedResvs, [
							{ status: "renewed" },
							{ status: "renewed" },
							{ status: "stale" },
							{
								status: "stale",
								currentFencingToken: takenResv.status === "reserved" ? takenResv.lease.fencingToken : -1,
							},
						]);
						assert.equal(resvMixedMetrics.trips, 1);
						assert.equal(resvMixedMetrics.statements.length, 2);
					} finally {
						await bus.close();
						await state.close();
						await direct.bus.close();
						await direct.state.close();
					}
				});
			},
		);
	}

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
				// The update, unmatched check and commit go together in one round trip. Eight before: two for each message.
				assert.equal(deliveredTrips, 1);
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

	test("settling with wakeOrigin writes the outcome hint atomically in one round trip, notifies after commit, skips same-broker hints, and survives a locked hint log (#6715)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const database = await open();
			try {
				// Warm up connection before counting.
				assert.equal((await state.reserveAndEnqueue!(...send("m-warm"))).status, "inserted");
				const warmClaim = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(warmClaim.status, "claimed");
				if (warmClaim.status !== "claimed") return;
				assert.equal((await state.outbox.markDelivered(warmClaim.rows[0]!.claim)).status, "delivered");

				// Queue 3 remote-origin messages (origin broker-a, claimed by broker-b) and 1 same-broker message
				// (origin broker-b, claimed by broker-b).
				for (const id of ["m-1", "m-2", "m-3"])
					assert.equal((await state.reserveAndEnqueue!(...send(id, "target-remote"))).status, "inserted");
				assert.equal(
					(
						await state.outbox.enqueue({
							targetIdentity: "target-local",
							originBrokerId: "broker-b",
							digest: "m-local",
							frame: {
								type: "message",
								from,
								message: { id: "m-local", timestamp: 1, content: { text: "m-local" } },
							},
						})
					).status,
					"inserted",
				);
				const remoteClaimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-remote",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				const localClaimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-local",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(remoteClaimed.status, "claimed");
				assert.equal(localClaimed.status, "claimed");
				if (remoteClaimed.status !== "claimed" || localClaimed.status !== "claimed") return;

				const trips = countRoundTrips();
				const statements: string[] = [];
				const query = pg.Client.prototype.query;
				pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
					const [first] = args as unknown[];
					statements.push(typeof first === "string" ? first : String((first as { text?: string }).text));
					return Reflect.apply(query, this, args);
				} as pg.Client["query"];
				restores.push(() => {
					pg.Client.prototype.query = query;
				});

				const settled = await Promise.all([
					...remoteClaimed.rows.map(({ claim }) => state.outbox.markDelivered(claim, { wakeOrigin: true })),
					state.outbox.markDelivered(localClaimed.rows[0]!.claim, { wakeOrigin: true }),
				]);
				const settleTrips = trips.take();
				assert.equal(settleTrips, 1, "settle + inline outcome hint runs in one round trip");
				const commitBeforeNotify = statements.indexOf("COMMIT");
				assert.ok(commitBeforeNotify >= 0, `expected COMMIT in ${JSON.stringify(statements)}`);
				const txStatements = statements.slice(0, commitBeforeNotify + 1);
				// BEGIN + UPDATE + DO(NOWAIT hint insert) + hint status read + unmatched lookup + COMMIT = 6 statements in 1 RT.
				assert.equal(
					txStatements.length,
					6,
					`expected 6 pipelined settlement statements, got ${txStatements.length}: ${JSON.stringify(txStatements)}`,
				);
				assert.deepEqual(
					settled.map((result) => (result.status === "delivered" ? [result.row.messageId, result.woke] : result)),
					[
						["m-1", "broker-a"],
						["m-2", "broker-a"],
						["m-3", "broker-a"],
						["m-local", undefined],
					],
				);
				// Post-commit notifications follow COMMIT (not before it).
				await sleep(200);
				const commit = statements.indexOf("COMMIT");
				const notify = statements.findIndex((text) => text.includes("pg_notify"));
				assert.ok(
					commit >= 0 && notify > commit,
					`notifications must run after COMMIT: ${JSON.stringify(statements)}`,
				);

				// Exactly one outcome hint for broker-a (with the max settled sequence), none for same-broker broker-b.
				const hints = await database.all<{ broker_id: string; reason: string; version: number | bigint }>(
					"SELECT broker_id, reason, version FROM intercom_wakeups ORDER BY id",
				);
				const maxSeq = Math.max(...remoteClaimed.rows.map(({ row }) => row.sequence));
				assert.deepEqual(
					hints.map((hint) => [hint.broker_id, hint.reason, Number(hint.version)]),
					[["broker-a", "outcome", maxSeq]],
				);

				// NOWAIT / lock_not_available fault injection: another session holds SHARE lock on intercom_wakeups.
				// Settlement must still succeed in one round trip, omitting `woke` so the router falls back.
				assert.equal((await state.reserveAndEnqueue!(...send("m-locked", "target-remote"))).status, "inserted");
				const lockedClaimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-remote",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(lockedClaimed.status, "claimed");
				if (lockedClaimed.status !== "claimed") return;

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
					const result = await state.outbox.markDelivered(lockedClaimed.rows[0]!.claim, { wakeOrigin: true });
					assert.equal(trips.take(), 1, "contended hint still settles in one round trip");
					assert.equal(result.status, "delivered");
					if (result.status === "delivered") assert.equal(result.woke, undefined);
				} finally {
					release();
					await holder;
				}
				const lockedRead = await state.outbox.read("m-locked");
				assert.equal(lockedRead.status === "found" ? lockedRead.row.state : lockedRead.status, "delivered");
				assert.equal(
					(await database.all("SELECT id FROM intercom_wakeups")).length,
					1,
					"no hint written while locked",
				);

				// Missing hint table fallback: settlement still succeeds without failing the delivery.
				assert.equal((await state.reserveAndEnqueue!(...send("m-dropped", "target-remote"))).status, "inserted");
				const droppedClaimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-remote",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(droppedClaimed.status, "claimed");
				if (droppedClaimed.status !== "claimed") return;
				await database.exec("DROP TABLE intercom_wakeups");
				const droppedResult = await state.outbox.markDelivered(droppedClaimed.rows[0]!.claim, { wakeOrigin: true });
				assert.equal(droppedResult.status, "delivered");
				if (droppedResult.status === "delivered") assert.equal(droppedResult.woke, undefined);
				const droppedRead = await state.outbox.read("m-dropped");
				assert.equal(droppedRead.status === "found" ? droppedRead.row.state : droppedRead.status, "delivered");
			} finally {
				await database.close();
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
				// One for the transaction. Its notifications go once it committed (the host's own channel, and the shared one a
				// host of an earlier release listens on, as no membership lease says this one has its own), and the send does
				// not wait for them.
				assert.equal(trips.take(), 1);
				await sleep(200);
				const notified = trips.take();
				assert.ok(notified >= 1 && notified <= 2, `${notified} round trips to notify`);
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
