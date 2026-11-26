import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { rowTransaction } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

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

/** Counts the HTTP requests sent to a libSQL server until the test ends. */
function countRequests() {
	const original = globalThis.fetch;
	let sent = 0;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		sent += 1;
		return original(input, init);
	}) as typeof fetch;
	restores.push(() => {
		globalThis.fetch = original;
	});
	return {
		take() {
			const counted = sent;
			sent = 0;
			return counted;
		},
	};
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom outbox claims on PostgreSQL (#6560)", () => {
	test("an empty poll, a claim of queued messages and a held claim each take one round trip (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: () => open() });
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
				await bus.close();
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

describe.skipIf(postgresSkipReason !== undefined)("Intercom outbox claim order on PostgreSQL (#6560)", () => {
	test("a claim that takes over a late claimant's row waits for that claimant's newer claim, so one session's messages stay in order (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			// A role that owns the database, so the row policy below applies to it (a superuser would bypass it).
			const owner = `atomic_claim_order_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
			const password = `pw-${randomUUID()}`;
			await scope.admin.exec(`CREATE ROLE ${owner} LOGIN PASSWORD '${password}'`);
			try {
				await scope.admin.exec(`GRANT ${owner} TO CURRENT_USER`);
				await scope.admin.exec(`ALTER DATABASE ${scope.name} OWNER TO ${owner}`);
				const urlFor = (stalls: boolean) => {
					const url = new URL(scope.url);
					url.username = owner;
					// The claimant whose claim statement stalls is told apart by a setting of its connections.
					if (stalls) url.searchParams.set("options", "-c atomic_test.stall_claim=on");
					return url.href;
				};
				const openAs = (stalls: boolean) => scope.open({ url: urlFor(stalls), password });
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
			} finally {
				await scope.admin.exec(`DROP DATABASE IF EXISTS ${scope.name} WITH (FORCE)`);
				await scope.admin.exec(`DROP ROLE IF EXISTS ${owner}`);
			}
		});
	});
});

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

const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;

describe.skipIf(serverUrl === undefined)("Intercom outbox claims on a libSQL server (#6560)", () => {
	test("an empty poll is one request, and a claim of queued messages two, with one write (#6560)", async () => {
		const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
		const open = () => openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
		const prefix = `claim_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
		try {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: open, prefix });
			try {
				await enqueue(state, "m-warm", "target-w");
				assert.deepEqual(claimedIds(await claim(state, "broker-b", "target-w")), ["m-warm"]);
				const requests = countRequests();
				assert.deepEqual(claimedIds(await claim(state, "broker-b", "target-a")), []);
				const emptyRequests = requests.take();
				for (const id of ["m-1", "m-2", "m-3"]) await enqueue(state, id, "target-a");
				requests.take();
				const claimed = await claim(state, "broker-b", "target-a");
				const claimRequests = requests.take();
				assert.deepEqual(claimedIds(claimed), ["m-1", "m-2", "m-3"]);
				assert.deepEqual(await claim(state, "broker-c", "target-a"), { status: "held", claimantId: "broker-b" });
				const heldRequests = requests.take();
				// Three requests before for a claim of queued messages and for a held claim.
				assert.equal(emptyRequests, 1);
				assert.equal(claimRequests, 2);
				assert.equal(heldRequests, 1);
			} finally {
				await bus.close();
				await state.close();
			}
		} finally {
			const database = await open();
			await dropLibsqlScope(database, prefix);
			await database.close();
		}
	});
});
