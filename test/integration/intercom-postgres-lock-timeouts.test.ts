import assert from "node:assert/strict";
import pg from "pg";
import { describe, test } from "vitest";
import type { StorageTransientError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";

/**
 * A busy shared PostgreSQL database ends a transaction that waited for a lock past its lock timeout (55P03). Nothing of
 * it was written, so Intercom runs it again instead of failing the send, renewal, claim or delivery that made it.
 */

/**
 * The lock timeout of the brokers' connections: their statement timeout, as the adapter sets it. A wait for a lock that
 * goes with a transaction's start ends with the lock timeout; a wait inside a statement ends with the statement's
 * timeout, as long and started first. Either ends the transaction before it wrote anything.
 */
const LOCK_TIMEOUT_MS = 300;
/** A statement timeout past a lease write's own lock wait (2 s), so the lock timeout ends a renewal's wait. */
const LEASE_STATEMENT_TIMEOUT_MS = 4_000;

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

/** A session of the test's own on the scope's database, which holds the locks a statement takes until `release`. */
async function holder(scope: PostgresScope) {
	const { hostname, port, pathname, username } = new URL(scope.url);
	const client = new pg.Client({
		host: hostname,
		port: Number(port),
		database: pathname.slice(1),
		user: decodeURIComponent(username),
		...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
	});
	await client.connect();
	return {
		async hold(sql: string, params: readonly unknown[] = []) {
			await client.query("BEGIN");
			await client.query(sql, [...params]);
		},
		async release() {
			await client.query("ROLLBACK");
		},
		end: () => client.end(),
	};
}

/**
 * Resolves with the first transient failure a database reports as a warning, which it does once, when it first runs a
 * transaction again.
 */
function nextTransientFailure(): Promise<StorageTransientError> {
	return new Promise((resolve) => {
		const listener = (warning: Error) => {
			const transient = warning as StorageTransientError;
			if (transient.name !== "StorageTransientError") return;
			process.off("warning", listener);
			resolve(transient);
		};
		process.on("warning", listener);
	});
}

/**
 * Runs `call` while the holder keeps the lock `held` takes, past the lock timeout: the call's first run fails with it,
 * and the holder lets go once it has. Resolves with the call's answer and the failure it outlived.
 */
async function outlivingLockTimeout<T>(
	scope: PostgresScope,
	held: { sql: string; params?: readonly unknown[] },
	call: () => Promise<T>,
) {
	const session = await holder(scope);
	try {
		await session.hold(held.sql, held.params);
		const timedOut = nextTransientFailure();
		const answer = call();
		answer.catch(() => {});
		// A call that fails, or answers while the lock is held, ends the test here.
		const failure = await Promise.race([
			timedOut,
			answer.then((answered) => {
				throw new Error(`answered while the lock was held: ${JSON.stringify(answered)}`);
			}),
		]);
		await session.release();
		return { answer: await answer, failure };
	} finally {
		await session.end();
	}
}

async function withBroker<T>(
	scope: PostgresScope,
	body: (state: IntercomBrokerStateStore) => Promise<T>,
	statementTimeoutMs = LOCK_TIMEOUT_MS,
) {
	const { state, bus } = await openIntercomBrokerState({ openDatabase: () => scope.open({ statementTimeoutMs }) });
	try {
		return await body(state);
	} finally {
		await bus.close();
		await state.close();
	}
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom on PostgreSQL outlives a lock timeout", () => {
	test("a send whose recipient's lock is held past the lock timeout is queued once the lock is free", async () => {
		await withPostgresDatabase(async (scope) => {
			await withBroker(scope, async (state) => {
				assert.equal((await state.reserveAndEnqueue!(...send("m-warm"))).status, "inserted");
				const { answer, failure } = await outlivingLockTimeout(
					scope,
					// The lock domain of the recipient's sends, in the adapter's default schema.
					{ sql: "SELECT pg_advisory_xact_lock(hashtextextended('atomic:intercom_outbox:target-a', 0))" },
					() => state.reserveAndEnqueue!(...send("m-1")),
				);
				assert.deepEqual([failure.code, failure.outcome], ["lock-conflict", "not-applied"]);
				assert.equal(answer.status, "inserted");
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.deepEqual(claimed.status === "claimed" ? claimed.rows.map(({ row }) => row.messageId) : claimed, [
					"m-warm",
					"m-1",
				]);
				assert.equal((await state.sentMessages.lookup({ messageId: "m-1", digest: "m-1" })).status, "match");
			});
		});
	});

	test("a presence lease renewal outlives a lock timeout on its row, and the session never goes stale", async () => {
		await withPostgresDatabase(async (scope) => {
			await withBroker(
				scope,
				async (state) => {
					const subject = {
						kind: "presence",
						targetIdentity: "target-a",
						session: { ...from, id: "target-a" },
					} as const;
					const acquired = await state.leases.acquire(subject, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
					assert.equal(acquired.status, "acquired");
					if (acquired.status !== "acquired") return;
					const { answer, failure } = await outlivingLockTimeout(
						scope,
						{
							sql: "SELECT 1 FROM atomic.intercom_leases WHERE kind = 'presence' AND key = 'target-a' FOR UPDATE",
						},
						() => state.leases.renewMany!([{ lease: acquired.lease, subject }]),
					);
					assert.deepEqual([failure.code, failure.outcome], ["lock-conflict", "not-applied"]);
					assert.deepEqual(answer, [{ status: "renewed" }]);
					const live = await state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS);
					assert.deepEqual(
						live.map((lease) => [lease.holderId, lease.fencingToken]),
						[["broker-a", acquired.lease.fencingToken]],
					);
					// Renewed when the lock was let go, not when the renewal began.
					assert.ok(live[0]!.ageMs < 1_000, `${live[0]!.ageMs} ms since the renewal`);
				},
				LEASE_STATEMENT_TIMEOUT_MS,
			);
		});
	});

	test("a claim that waits for a queued row past the lock timeout claims it once the row is free", async () => {
		await withPostgresDatabase(async (scope) => {
			await withBroker(scope, async (state) => {
				for (const id of ["m-1", "m-2"])
					assert.equal((await state.reserveAndEnqueue!(...send(id))).status, "inserted");
				const { answer, failure } = await outlivingLockTimeout(
					scope,
					{ sql: "SELECT 1 FROM atomic.intercom_outbox WHERE message_id = 'm-2' FOR UPDATE" },
					() =>
						state.outbox.claim({
							claimantId: "broker-b",
							targetIdentity: "target-a",
							staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
						}),
				);
				// The claim's statement waits for the row lock: its timeout ends the wait.
				assert.deepEqual([failure.code, failure.outcome], ["transaction-timeout", "not-applied"]);
				assert.deepEqual(
					answer.status === "claimed" ? answer.rows.map(({ row }) => [row.messageId, row.claimAttempts]) : answer,
					[
						["m-1", 1],
						["m-2", 1],
					],
				);
			});
		});
	});

	test("a delivery that waits for its claimed row past the lock timeout settles it once the row is free", async () => {
		await withPostgresDatabase(async (scope) => {
			await withBroker(scope, async (state) => {
				assert.equal((await state.reserveAndEnqueue!(...send("m-1"))).status, "inserted");
				const claimed = await state.outbox.claim({
					claimantId: "broker-b",
					targetIdentity: "target-a",
					staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
				});
				assert.equal(claimed.status, "claimed");
				if (claimed.status !== "claimed") return;
				const { answer, failure } = await outlivingLockTimeout(
					scope,
					// The database's lock, as a whole-database writer such as snapshot garbage collection holds it: a delivery
					// waits for it with its start.
					{ sql: "SELECT pg_advisory_xact_lock(hashtextextended('atomic:atomic', 0))" },
					() => state.outbox.markDelivered(claimed.rows[0]!.claim),
				);
				assert.deepEqual([failure.code, failure.outcome], ["lock-conflict", "not-applied"]);
				assert.equal(answer.status === "delivered" ? answer.row.state : answer.status, "delivered");
			});
		});
	});
});
