import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { rowTransaction } from "../../packages/intercom/broker/sql-outbox-store.js";
import { checkClaimantlessRow } from "../helpers/outbox-claimantless-row.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

async function enqueue(state: IntercomBrokerStateStore, messageId: string, targetIdentity: string) {
	const queued = await state.outbox.enqueue({
		targetIdentity,
		originBrokerId: "broker-a",
		digest: messageId,
		frame: { type: "message", from, message: { id: messageId, timestamp: 1, content: { text: messageId } } },
	});
	assert.equal(queued.status, "inserted");
}

const claim = (state: IntercomBrokerStateStore, claimantId: string, targetIdentity: string) =>
	state.outbox.claim({ claimantId, targetIdentity, staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS });

const claimedIds = (claimed: Awaited<ReturnType<typeof claim>>) =>
	claimed.status === "claimed" ? claimed.rows.map(({ row }) => row.messageId) : claimed;

/**
 * How the brokers of the claim order and claim race tests reach the server: directly, and through PgBouncer in
 * transaction mode at `ATOMIC_TEST_PGBOUNCER_URL` (a URL without a password, whose database part is replaced), which
 * CI's storage conformance job runs beside PostgreSQL. PgBouncer passes no connection-time setting on and lends one
 * server connection to many clients, so the stalling broker is told apart by a role of its own, whose setting the
 * test sets on the role once.
 */
interface PostgresRoute {
	readonly name: string;
	readonly skipReason: string | undefined;
	/** The URL of database `database` as `user` on this route. */
	url(scope: PostgresScope, database: string, user: string): string;
}

const pgbouncerUrl = process.env.ATOMIC_TEST_PGBOUNCER_URL || undefined;
if (
	pgbouncerUrl === undefined &&
	postgresSkipReason === undefined &&
	process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1"
)
	throw new Error("ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ATOMIC_TEST_PGBOUNCER_URL is not set");

const postgresRoutes: readonly PostgresRoute[] = [
	{
		name: "direct",
		skipReason: postgresSkipReason,
		url: (scope, database, user) => {
			const url = new URL(scope.url);
			url.pathname = `/${database}`;
			url.username = user;
			return url.href;
		},
	},
	{
		name: "through PgBouncer in transaction mode",
		skipReason:
			postgresSkipReason ?? (pgbouncerUrl === undefined ? "ATOMIC_TEST_PGBOUNCER_URL is not set" : undefined),
		url: (_scope, database, user) => {
			const url = new URL(pgbouncerUrl!);
			url.pathname = `/${database}`;
			url.username = user;
			return url.href;
		},
	},
];

/**
 * Counts the round trips to the server: queries a connection sent while none of its own were unanswered. The adapter's
 * pg is this one, so patching the client prototype reaches the adapter's connections.
 */
function countPostgresRoundTrips() {
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

/**
 * Runs `poll` while the first `COMMIT` the adapter sends is held back, and counts the advisory locks the sessions of
 * the database at `url` hold meanwhile, from a connection of the test's own: the locks of the poll's transaction, kept
 * open at its end.
 */
async function locksHeldBy<T>(url: string, poll: () => Promise<T>) {
	const query = pg.Client.prototype.query;
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let arrived!: () => void;
	const committing = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let held = false;
	const holding = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		if (args[0] !== "COMMIT" || held) return Reflect.apply(query, this, args);
		held = true;
		arrived();
		return gate.then(() => Reflect.apply(query, this, args));
	};
	pg.Client.prototype.query = holding as pg.Client["query"];
	const restore = () => {
		pg.Client.prototype.query = query;
		open();
	};
	restores.push(restore);
	const { hostname, port, pathname, username } = new URL(url);
	const counter = new pg.Client({
		host: hostname,
		port: Number(port),
		database: pathname.slice(1),
		user: decodeURIComponent(username),
		...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
	});
	try {
		await counter.connect();
		const answer = poll();
		await Promise.race([committing, answer]);
		const { rows } = await counter.query<{ locks: string }>(
			`SELECT count(*) AS locks FROM pg_locks JOIN pg_database ON pg_database.oid = pg_locks.database
			WHERE pg_locks.locktype = 'advisory' AND pg_database.datname = current_database()`,
		);
		restore();
		return { locks: Number(rows[0]?.locks), answer: await answer };
	} finally {
		restore();
		await counter.end();
	}
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom outbox claims on PostgreSQL (#6560)", () => {
	test("an empty poll, a claim of queued messages and a held claim each take one round trip (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			// Only the outbox's calls are counted: the wake-up bus, which polls on its own, is closed first.
			await bus.close();
			try {
				// The connection is opened and the outbox's tables exist before counting starts.
				await enqueue(state, "m-warm", "target-w");
				assert.deepEqual(claimedIds(await claim(state, "broker-b", "target-w")), ["m-warm"]);
				const trips = countPostgresRoundTrips();
				assert.deepEqual(claimedIds(await claim(state, "broker-b", "target-a")), []);
				const emptyTrips = trips.take();
				for (const id of ["m-1", "m-2", "m-3"]) await enqueue(state, id, "target-a");
				trips.take();
				const claimed = await claim(state, "broker-b", "target-a");
				const claimTrips = trips.take();
				assert.deepEqual(claimedIds(claimed), ["m-1", "m-2", "m-3"]);
				assert.deepEqual(await claim(state, "broker-c", "target-a"), { status: "held", claimantId: "broker-b" });
				const heldTrips = trips.take();
				// Three round trips before for a claim of queued messages: the empty check, the locked read, the writes.
				assert.equal(emptyTrips, 1);
				assert.equal(claimTrips, 1);
				assert.equal(heldTrips, 1);
				if (claimed.status !== "claimed") return;
				assert.deepEqual(
					await Promise.all(
						claimed.rows.map(async ({ claim }) => (await state.outbox.markDelivered(claim)).status),
					),
					["delivered", "delivered", "delivered"],
				);
			} finally {
				await state.close();
			}
		});
	});

	test("an empty poll takes no lock, and a poll that finds messages takes the database's and its recipient's (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => scope.open() });
			await bus.close();
			try {
				await enqueue(state, "m-warm", "target-w");
				assert.deepEqual(claimedIds(await claim(state, "broker-b", "target-w")), ["m-warm"]);
				// Each poll's transaction is kept open at its COMMIT while another session counts the locks it holds.
				const empty = await locksHeldBy(scope.url, () => claim(state, "broker-b", "target-a"));
				for (const id of ["m-1", "m-2"]) await enqueue(state, id, "target-a");
				const waiting = await locksHeldBy(scope.url, () => claim(state, "broker-b", "target-a"));
				const held = await locksHeldBy(scope.url, () => claim(state, "broker-c", "target-a"));
				assert.deepEqual(claimedIds(empty.answer), []);
				// Before, the empty poll took both with its BEGIN.
				assert.equal(empty.locks, 0);
				assert.deepEqual(claimedIds(waiting.answer), ["m-1", "m-2"]);
				assert.equal(waiting.locks, 2);
				assert.deepEqual(held.answer, { status: "held", claimantId: "broker-b" });
				assert.equal(held.locks, 2);
			} finally {
				await state.close();
			}
		});
	});

	test("a claim waiting for a row lock holds the rows before it, and nothing else waits for it (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			const claimer = await openIntercomBrokerState({ openDatabase: () => open() });
			const blocker = await open();
			const watcher = await open();
			try {
				for (const [id, target] of [
					["m-a", "target-a"],
					["m-a1", "target-a"],
					["m-b", "target-b"],
				] as const)
					await enqueue(state, id, target);
				// Another session locks target-a's second row, so the claim locks the first and waits there.
				let release!: () => void;
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				let locked!: () => void;
				const holding = new Promise<void>((resolve) => {
					locked = resolve;
				});
				// A transaction that locks its rows itself, as the outbox's row writes do, so it takes no lock domain.
				const blocking = blocker.transaction(async (tx) => {
					await tx.get("SELECT message_id FROM intercom_outbox WHERE message_id = ? FOR UPDATE", "m-a1");
					locked();
					await released;
				}, rowTransaction());
				await holding;
				const stalled = claim(claimer.state, "broker-a", "target-a");
				await waitForLockWaiter(watcher);
				try {
					const within = <T>(write: Promise<T>, what: string) =>
						Promise.race([
							write,
							new Promise<never>((_, reject) =>
								setTimeout(() => reject(new Error(`${what} waited behind the claim`)), UNBLOCKED_MS),
							),
						]);
					await within(enqueue(state, "m-a2", "target-a"), "a send to the same recipient");
					await within(enqueue(state, "m-c", "target-c"), "a send to another recipient");
					const other = await within(claim(state, "broker-b", "target-b"), "another recipient's claim");
					assert.deepEqual(claimedIds(other), ["m-b"]);
					if (other.status !== "claimed") return;
					const delivered = await within(state.outbox.markDelivered(other.rows[0]!.claim), "another delivery");
					assert.equal(delivered.status, "delivered");
				} finally {
					release();
					await blocking;
				}
				// The claim took the rows it locked, in order; the one queued meanwhile waits for the next claim.
				assert.deepEqual(claimedIds(await stalled), ["m-a", "m-a1"]);
				assert.deepEqual(await state.outbox.undeliveredPosition("target-a", "m-a2"), {
					status: "positioned",
					position: 3,
				});
			} finally {
				await watcher.close();
				await blocker.close();
				await claimer.bus.close();
				await claimer.state.close();
				await bus.close();
				await state.close();
			}
		});
	});
});

describe.skipIf(postgresSkipReason !== undefined)("Intercom outbox claims of a row without a claimant (#6560)", () => {
	test("on PostgreSQL, a claimed row without a claimant is not held, and is taken over once stale (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
			try {
				await checkClaimantlessRow(state, await open(), "intercom_outbox");
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});
});

for (const route of postgresRoutes) {
	describe.skipIf(route.skipReason !== undefined)(
		`Intercom outbox claim order on PostgreSQL, ${route.name} (#6560)`,
		() => {
			test("a claim that takes over a late claimant's row waits for that claimant's newer claim, so one session's messages stay in order (#6560)", async () => {
				await withPostgresDatabase((scope) =>
					withTestRoles(scope, route, "atomic_test.stall_claim", async (openAs) => {
						const late = await openIntercomBrokerState({ openDatabase: () => openAs(false) });
						const takeover = await openIntercomBrokerState({ openDatabase: () => openAs(true) });
						const control = await openAs(false);
						try {
							// The test's hook into the server: while the test holds advisory lock 6560, the stalling claimant's claim
							// statement waits as it reads row m-1, after it took its snapshot and before it locks the row. Nothing else
							// waits: other connections, and the stalling claimant's other statements, pass.
							await control.exec(`
							CREATE FUNCTION atomic_test_claim_stall(id text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
							BEGIN
								IF id = 'm-1' AND current_setting('atomic_test.stall_claim', true) = 'on'
									AND current_query() LIKE '%FOR UPDATE%' THEN
									PERFORM pg_advisory_xact_lock_shared(6560);
								END IF;
								RETURN true;
							END $$;
							ALTER TABLE intercom_outbox ENABLE ROW LEVEL SECURITY;
							ALTER TABLE intercom_outbox FORCE ROW LEVEL SECURITY;
							CREATE POLICY atomic_test_claim_stall ON intercom_outbox USING (atomic_test_claim_stall(message_id));
						`);
							await enqueue(late.state, "m-1", "target-a");
							assert.deepEqual(claimedIds(await claim(late.state, "broker-late", "target-a")), ["m-1"]);
							let release!: () => void;
							const released = new Promise<void>((resolve) => {
								release = resolve;
							});
							let held!: () => void;
							const holding = new Promise<void>((resolve) => {
								held = resolve;
							});
							const stall = control.transaction(async (tx) => {
								await tx.get("SELECT pg_advisory_xact_lock(6560)::text AS locked");
								held();
								await released;
							}, rowTransaction());
							await holding;
							// To this claimant, a claim unrenewed for 50 ms is stale: broker-late is late to renew m-1.
							const takingOver = takeover.state.outbox.claim({
								claimantId: "broker-takeover",
								targetIdentity: "target-a",
								staleAfterMs: 50,
							});
							await waitForLockWaiter(control, "advisory");
							// m-2 is queued after the takeover's statement took its snapshot, and broker-late, which still holds m-1 live
							// by its own count, claims it.
							await enqueue(late.state, "m-2", "target-a");
							const newer = claim(late.state, "broker-late", "target-a");
							await Promise.race([newer, new Promise((resolve) => setTimeout(resolve, 500))]);
							release();
							await stall;
							const [taken, newest] = [claimedIds(await takingOver), await newer];
							assert.deepEqual(taken, ["m-1"]);
							// Before the fix broker-late claimed m-2 while the takeover claimed m-1: two brokers held one session's
							// messages at once, and broker-late could deliver m-2 before m-1 arrived.
							assert.deepEqual(newest, { status: "held", claimantId: "broker-takeover" });
						} finally {
							await control.close();
							await takeover.bus.close();
							await takeover.state.close();
							await late.bus.close();
							await late.state.close();
						}
					}),
				);
			});
		},
	);
}

/**
 * Runs `body` with connections, on `route`, as a role that owns the scope's database, so a row policy applies to them
 * (a superuser would bypass it), or with `stalls` as a member of that role whose connections have `setting` on: the
 * test's hooks into the server stall only those.
 */
async function withTestRoles(
	scope: PostgresScope,
	route: PostgresRoute,
	setting: string,
	body: (openAs: (stalls: boolean) => Promise<SqliteDatabase>) => Promise<void>,
): Promise<void> {
	const owner = `atomic_claim_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const stalling = `${owner}_stall`;
	const password = `pw-${randomUUID()}`;
	await scope.admin.exec(`CREATE ROLE ${owner} LOGIN PASSWORD '${password}'`);
	try {
		await scope.admin.exec(`CREATE ROLE ${stalling} LOGIN PASSWORD '${password}' IN ROLE ${owner}`);
		await scope.admin.exec(`ALTER ROLE ${stalling} IN DATABASE ${scope.name} SET ${setting} = 'on'`);
		// The test watches the stalling role's sessions wait from the owner's.
		await scope.admin.exec(`GRANT pg_read_all_stats TO ${owner}`);
		await scope.admin.exec(`GRANT ${owner} TO CURRENT_USER`);
		await scope.admin.exec(`ALTER DATABASE ${scope.name} OWNER TO ${owner}`);
		await body((stalls) => scope.open({ url: route.url(scope, scope.name, stalls ? stalling : owner), password }));
	} finally {
		await scope.admin.exec(`DROP DATABASE IF EXISTS ${scope.name} WITH (FORCE)`);
		await scope.admin.exec(`DROP ROLE IF EXISTS ${stalling}`);
		await scope.admin.exec(`DROP ROLE IF EXISTS ${owner}`);
	}
}

/**
 * Runs `body` with brokers that connect on `route` as a role owning the scope's database, so a row policy applies to
 * them, and with the test's hooks into the server installed once the outbox exists. A hidden row `sentinel` of
 * target-a, which no statement sees: a poll's first read of target-a's rows stalls on it while the test holds advisory
 * lock 6561, after the read took its snapshot. A claim statement (`FOR UPDATE`) stalls as it reads m-1 while the test
 * holds 6560. Only brokers opened with `stalls` stall.
 */
async function withStallingPolls(
	scope: PostgresScope,
	route: PostgresRoute,
	body: (
		openBroker: (stalls: boolean) => Promise<IntercomBrokerStateStore>,
		holdLock: (key: number) => Promise<() => Promise<void>>,
		control: SqliteDatabase,
	) => Promise<void>,
): Promise<void> {
	const opened: Awaited<ReturnType<typeof openIntercomBrokerState>>[] = [];
	await withTestRoles(scope, route, "atomic_test.stall", async (openAs) => {
		try {
			const openBroker = async (stalls: boolean) => {
				const broker = await openIntercomBrokerState({ openDatabase: () => openAs(stalls) });
				opened.push(broker);
				await broker.bus.close();
				return broker.state;
			};
			const control = await openAs(false);
			await openBroker(false);
			await control.exec(`
				INSERT INTO intercom_outbox (message_id, target_identity, origin_broker_id, digest, frame_json, state)
				VALUES ('sentinel', 'target-a', 'broker-test', 'sentinel', '{}', 'queued');
				CREATE FUNCTION atomic_test_claim_stall(id text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
				BEGIN
					IF current_setting('atomic_test.stall', true) IS DISTINCT FROM 'on' THEN
						RETURN id <> 'sentinel';
					END IF;
					IF id = 'sentinel' THEN
						PERFORM pg_advisory_xact_lock_shared(6561);
						RETURN false;
					END IF;
					IF id = 'm-1' AND current_query() LIKE '%FOR UPDATE%' THEN
						PERFORM pg_advisory_xact_lock_shared(6560);
					END IF;
					RETURN true;
				END $$;
				ALTER TABLE intercom_outbox ENABLE ROW LEVEL SECURITY;
				ALTER TABLE intercom_outbox FORCE ROW LEVEL SECURITY;
				CREATE POLICY atomic_test_claim_stall ON intercom_outbox USING (atomic_test_claim_stall(message_id));
			`);
			const holdLock = async (key: number) => {
				let release!: () => void;
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				let held!: () => void;
				const holding = new Promise<void>((resolve) => {
					held = resolve;
				});
				const stall = control.transaction(async (tx) => {
					await tx.get(`SELECT pg_advisory_xact_lock(${key})::text AS locked`);
					held();
					await released;
				}, rowTransaction());
				await holding;
				return async () => {
					release();
					await stall;
				};
			};
			await body(openBroker, holdLock, control);
		} finally {
			for (const broker of opened) await broker.state.close();
		}
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const route of postgresRoutes)
	describe.skipIf(route.skipReason !== undefined)(
		`Intercom outbox: a send that lands during a PostgreSQL poll, ${route.name} (#6560)`,
		() => {
			test("a message queued after the poll's first read waits for the next poll, which claims it (#6560)", async () => {
				await withPostgresDatabase((scope) =>
					withStallingPolls(scope, route, async (openBroker, holdLock, control) => {
						const sender = await openBroker(false);
						const poller = await openBroker(true);
						const releaseRead = await holdLock(6561);
						const polling = claim(poller, "broker-b", "target-a");
						await waitForLockWaiter(control, "advisory");
						// The poll's read took its snapshot and found nothing yet; m-1 is queued before its claim statement runs.
						await enqueue(sender, "m-1", "target-a");
						await releaseRead();
						const first = claimedIds(await polling);
						const next = claimedIds(await claim(poller, "broker-b", "target-a"));
						// Either the poll claimed m-1, or it answered empty and the next poll claims it.
						assert.ok(
							(Array.isArray(first) && first.length === 0 && JSON.stringify(next) === '["m-1"]') ||
								(JSON.stringify(first) === '["m-1"]' && Array.isArray(next) && next.length === 0),
							`first poll ${JSON.stringify(first)}, next ${JSON.stringify(next)}`,
						);
					}),
				);
			});

			test("a poll whose first read found nothing never takes over an older row while another broker claims a newer one (#6560)", async () => {
				await withPostgresDatabase((scope) =>
					withStallingPolls(scope, route, async (openBroker, holdLock, control) => {
						const late = await openBroker(false);
						const poller = await openBroker(true);
						const releaseRead = await holdLock(6561);
						// To this poll, a claim unrenewed for 50 ms is stale.
						const polling = poller.outbox.claim({
							claimantId: "broker-poll",
							targetIdentity: "target-a",
							staleAfterMs: 50,
						});
						await waitForLockWaiter(control, "advisory");
						// After the poll's read took its snapshot: m-1 is queued and claimed by broker-late, which is then late to renew.
						await enqueue(late, "m-1", "target-a");
						assert.deepEqual(claimedIds(await claim(late, "broker-late", "target-a")), ["m-1"]);
						await sleep(100);
						// A claim statement that read m-1 now waits there, after its snapshot, until the test lets it go.
						const releaseClaim = await holdLock(6560);
						await releaseRead();
						await Promise.race([polling, sleep(500)]);
						// m-2 is queued after the poll's claim statement took its snapshot, and broker-late, which still holds m-1 live
						// by its own count, claims it.
						await enqueue(late, "m-2", "target-a");
						const newer = claim(late, "broker-late", "target-a");
						await Promise.race([newer, sleep(500)]);
						await releaseClaim();
						assert.deepEqual(claimedIds(await polling), []);
						assert.deepEqual(claimedIds(await newer), ["m-2"]);
						// Without the lock, the poll's claim statement took m-1 over while broker-late claimed m-2: two brokers held one
						// session's messages at once, and m-2 could arrive before m-1.
						const holders = await control.all<{ message_id: string; claimant_id: string }>(
							"SELECT message_id, claimant_id FROM intercom_outbox WHERE state = 'claimed' ORDER BY sequence",
						);
						assert.deepEqual(
							holders.map((row) => [row.message_id, row.claimant_id]),
							[
								["m-1", "broker-late"],
								["m-2", "broker-late"],
							],
						);
					}),
				);
			});
		},
	);

/** How long a write that does not wait for the claim may take, far below the time the claim is kept waiting. */
const UNBLOCKED_MS = 5_000;

/** Waits until a session of the database waits for a row lock, or with `advisory` for an advisory lock. */
async function waitForLockWaiter(watcher: SqliteDatabase, kind: "row" | "advisory" = "row"): Promise<void> {
	const events = kind === "row" ? "('transactionid', 'tuple')" : "('advisory')";
	for (;;) {
		const waiting = await watcher.get<{ waiting: number | string }>(
			`SELECT count(*) AS waiting FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ${events}`,
		);
		if (Number(waiting?.waiting) > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
