import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import {
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type OutboxClaim,
	type OutboxDeliveredResult,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, isExec, requestSql } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function brokerPath(): string {
	const directory = makeTempDirectory("atomic-outbox-delivery-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "broker.sqlite");
}

async function openBroker(path = brokerPath()): Promise<IntercomBrokerStateStore> {
	const { state, bus } = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
	await bus.close();
	cleanups.push(() => state.close());
	return state;
}

/** Every request sent to a connection's thread, and the waits: requests sent while none was out. */
function recordRequests() {
	const sent: ConnectionRequest[] = [];
	let inFlight = 0;
	let waits = 0;
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		if (inFlight === 0) waits += 1;
		inFlight += 1;
		return send(request).finally(() => {
			inFlight -= 1;
		});
	});
	cleanups.push(() => interception.restore());
	return {
		take() {
			const taken = { sent: [...sent], waits };
			sent.length = 0;
			waits = 0;
			return taken;
		},
	};
}

/** Every SQL text carried by `request`, including statements bundled with `BEGIN` when supported (#6698). */
const statementSqls = (request: ConnectionRequest): readonly string[] => {
	const sql = requestSql(request);
	if (sql !== undefined) return [sql];
	const statements = (request as { readonly statements?: readonly { readonly sql: string }[] }).statements;
	return statements === undefined ? [] : statements.map((statement) => statement.sql);
};

/** Expected requests per fully-matched batch: 2 when `BEGIN` bundles the leading UPDATE (#6698), else 3. */
const requestsPerBatch = (sent: readonly ConnectionRequest[]): number =>
	sent.some((request) => request.kind === "begin" && statementSqls(request).length > 0) ? 2 : 3;

/** The requests that take the database's write lock: a `BEGIN IMMEDIATE`, or a write statement run on its own. */
const writeLocks = (sent: readonly ConnectionRequest[]) =>
	sent.filter(
		(request) =>
			request.kind === "begin" || statementSqls(request).some((sql) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)),
	);

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

const summarize = (result: OutboxDeliveredResult): string =>
	"row" in result ? `${result.status} ${result.row.messageId} ${result.row.state}` : result.status;

test("same-turn markDelivered calls on a SQLite file settle in 3 requests with one write lock (#6716)", async () => {
	const path = brokerPath();
	const state = await openBroker(path);
	const reader = await openBroker(path);
	const updateTexts = new Set<string>();
	const ids = ["m-1", "m-2", "m-3", "m-4", "m-5"];
	for (const id of ids) await enqueue(state, id, "target-a");
	const claimed = await claim(state, "broker-b", "target-a");
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	assert.equal(claimed.rows.length, ids.length);

	const requests = recordRequests();
	const delivered = await Promise.all(claimed.rows.map(({ claim: entry }) => state.outbox.markDelivered(entry)));
	const { sent, waits } = requests.take();

	assert.deepEqual(
		delivered.map((result) => (result.status === "delivered" ? result.row.messageId : result.status)),
		ids,
	);
	// Before: 3N + 2 = 17 requests (BEGIN, N * (SAVEPOINT, UPDATE, RELEASE), COMMIT).
	// After: 3 requests (BEGIN IMMEDIATE, one batched UPDATE ... RETURNING, COMMIT) — or 2 with #6698 — and 1 write lock.
	const perBatch = requestsPerBatch(sent);
	assert.equal(sent.length, perBatch);
	assert.equal(waits, perBatch);
	assert.equal(writeLocks(sent).length, 1);
	assert.equal(sent.flatMap(statementSqls).filter((sql) => /^\s*(SAVEPOINT|RELEASE)\b/i.test(sql)).length, 0);
	for (const sql of sent.flatMap(statementSqls)) {
		if (sql.includes("'delivered'")) updateTexts.add(sql);
	}

	// Settling one message uses the exact same statement text as settling five.
	await enqueue(state, "m-solo", "target-solo");
	const solo = await claim(state, "broker-b", "target-solo");
	assert.equal(solo.status, "claimed");
	if (solo.status !== "claimed") return;
	requests.take();
	assert.equal((await state.outbox.markDelivered(solo.rows[0]!.claim)).status, "delivered");
	const soloBatch = requests.take();
	assert.equal(soloBatch.sent.length, perBatch);
	assert.equal(writeLocks(soloBatch.sent).length, 1);
	for (const sql of soloBatch.sent.flatMap(statementSqls)) {
		if (sql.includes("'delivered'")) updateTexts.add(sql);
	}
	assert.equal(updateTexts.size, 1);

	// Every row is durably visible as delivered from an independent connection.
	for (const id of [...ids, "m-solo"]) {
		const found = await reader.outbox.read(id);
		assert.equal(found.status === "found" ? found.row.state : found.status, "delivered");
	}
});

test("repeated message ids split batches, resolve in call order, and report mixed outcomes on SQLite (#6716)", async () => {
	const state = await openBroker();
	for (const id of ["m-1", "m-2", "m-3", "m-4", "m-5"]) await enqueue(state, id, "target-a");
	const claimed = await claim(state, "broker-b", "target-a");
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	const [first, second, third, fourth, fifth] = claimed.rows.map(({ claim: entry }) => entry);
	assert.ok(first && second && third && fourth && fifth);
	assert.equal((await state.outbox.markFailed(third, "refused")).status, "failed");

	// Verify strictly one transaction at a time: no BEGIN while a prior transaction has not ended.
	let activeTransactions = 0;
	let maxActiveTransactions = 0;
	let beginCount = 0;
	const overlapCheck = interceptConnectionRequests((request, send) => {
		if (request.kind === "begin") {
			beginCount += 1;
			activeTransactions += 1;
			if (activeTransactions > maxActiveTransactions) maxActiveTransactions = activeTransactions;
		}
		const answer = send(request);
		if (isExec(request, "COMMIT") || isExec(request, "ROLLBACK")) {
			return answer.finally(() => {
				activeTransactions -= 1;
			});
		}
		return answer;
	});
	cleanups.push(() => overlapCheck.restore());

	const calls: readonly OutboxClaim[] = [
		first,
		{ ...first, token: "wrong-token" },
		first,
		{ ...second, token: "an-earlier-claim" },
		second,
		third,
		{ ...first, claimantId: "other-broker" },
		{ ...first, messageId: "never-queued" },
		// Swapped tokens across two live rows: neither row matches a single triple.
		{ ...fourth, token: fifth.token },
		{ ...fifth, token: fourth.token },
	];

	const resolvedOrder: number[] = [];
	const results = await Promise.all(
		calls.map((entry, index) =>
			state.outbox.markDelivered(entry).then((result) => {
				resolvedOrder.push(index);
				return result;
			}),
		),
	);

	assert.deepEqual(results.map(summarize), [
		"delivered m-1 delivered",
		"settled m-1 delivered",
		"settled m-1 delivered",
		"stale",
		"delivered m-2 delivered",
		"settled m-3 failed",
		"settled m-1 delivered",
		"unknown",
		"stale",
		"stale",
	]);
	assert.deepEqual(
		resolvedOrder,
		calls.map((_, index) => index),
	);
	assert.equal(maxActiveTransactions, 1);
	// Calls cut at each repeated message id: [0], [1], [2,3], [4,5,6,7,8,9] => 4 batches, never 10.
	assert.equal(beginCount, 4);

	// The swapped-token rows stay claimed and can still be delivered with their real claims.
	const r4 = await state.outbox.read("m-4");
	const r5 = await state.outbox.read("m-5");
	assert.equal(r4.status === "found" ? r4.row.state : r4.status, "claimed");
	assert.equal(r5.status === "found" ? r5.row.state : r5.status, "claimed");
	assert.deepEqual(
		(await Promise.all([state.outbox.markDelivered(fourth), state.outbox.markDelivered(fifth)])).map(summarize),
		["delivered m-4 delivered", "delivered m-5 delivered"],
	);
});

test("special JSON characters in ids and claimants round-trip accurately through SQLite batch delivery (#6716)", async () => {
	const state = await openBroker();
	const weirdIds = ['quote"\\$0\n\t', "123", "null", "true", '["a","b"]', "emoji🚀"];
	for (const id of weirdIds) await enqueue(state, id, "target-weird");
	const claimed = await claim(state, 'broker"\\$[0]', "target-weird");
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	const [first, ...rest] = claimed.rows.map(({ claim: entry }) => entry);
	assert.ok(first);
	const results = await Promise.all([
		...rest.map((entry) => state.outbox.markDelivered(entry)),
		state.outbox.markDelivered({ ...first, token: 'wrong"\\token' }),
		state.outbox.markDelivered({ ...first, messageId: 'missing"\\$0' }),
	]);
	assert.deepEqual(
		results.map((result) => result.status),
		[...rest.map(() => "delivered"), "stale", "unknown"],
	);
	assert.equal((await state.outbox.markDelivered(first)).status, "delivered");
});

test("markDelivered waits for COMMIT durability, coalesces arrivals during flight, and recovers after batch errors (#6716)", async () => {
	const path = brokerPath();
	const state = await openBroker(path);
	const reader = await openBroker(path);
	for (const id of ["b1-1", "b1-2", "b1-3", "b2-1", "b2-2", "b2-3", "b2-4"]) await enqueue(state, id, "target-a");
	const claimed = await claim(state, "broker-b", "target-a");
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	const batch1Claims = claimed.rows.slice(0, 3).map(({ claim: entry }) => entry);
	const batch2Claims = claimed.rows.slice(3).map(({ claim: entry }) => entry);

	// Hold the first batch's COMMIT to verify durability-before-resolution and in-flight coalescing.
	const commitArrived = Promise.withResolvers<void>();
	const releaseCommit = Promise.withResolvers<void>();
	let heldFirstCommit = false;
	const batch2Requests: ConnectionRequest[] = [];
	const gate = interceptConnectionRequests((request, send) => {
		if (heldFirstCommit) batch2Requests.push(request);
		if (!heldFirstCommit && isExec(request, "COMMIT")) {
			heldFirstCommit = true;
			commitArrived.resolve();
			return releaseCommit.promise.then(() => send(request));
		}
		return send(request);
	});
	cleanups.push(() => gate.restore());

	let batch1Resolved = 0;
	const batch1Promises = batch1Claims.map((entry) =>
		state.outbox.markDelivered(entry).then((result) => {
			batch1Resolved += 1;
			return result;
		}),
	);

	await commitArrived.promise;
	// Give microtasks a chance to run: no caller may resolve before COMMIT completes.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(batch1Resolved, 0);
	for (const id of ["b1-1", "b1-2", "b1-3"]) {
		const read = await reader.outbox.read(id);
		assert.equal(read.status === "found" ? read.row.state : read.status, "claimed");
	}

	// Queue 4 new calls while batch 1 is still in flight; they must coalesce into ONE next batch (3 requests).
	const batch2Promises = batch2Claims.map((entry) => state.outbox.markDelivered(entry));
	batch2Requests.length = 0;
	releaseCommit.resolve();

	const [batch1Results, batch2Results] = await Promise.all([Promise.all(batch1Promises), Promise.all(batch2Promises)]);
	gate.restore();

	assert.deepEqual(
		batch1Results.map((result) => result.status),
		["delivered", "delivered", "delivered"],
	);
	assert.deepEqual(
		batch2Results.map((result) => result.status),
		["delivered", "delivered", "delivered", "delivered"],
	);
	assert.equal(batch2Requests.length, requestsPerBatch(batch2Requests));
	assert.equal(writeLocks(batch2Requests).length, 1);

	for (const id of ["b1-1", "b1-2", "b1-3", "b2-1", "b2-2", "b2-3", "b2-4"]) {
		const read = await reader.outbox.read(id);
		assert.equal(read.status === "found" ? read.row.state : read.status, "delivered");
	}

	// Failure isolation: a failed first batch rejects its callers without stranding the next batch.
	await enqueue(state, "f-1", "target-fail");
	await enqueue(state, "f-2", "target-fail");
	const failClaimed = await claim(state, "broker-b", "target-fail");
	assert.equal(failClaimed.status, "claimed");
	if (failClaimed.status !== "claimed") return;
	const [failFirst, failSecond] = failClaimed.rows.map(({ claim: entry }) => entry);
	assert.ok(failFirst && failSecond);

	let failedOnce = false;
	const failCommit = interceptConnectionRequests((request, send) => {
		if (!failedOnce && isExec(request, "COMMIT")) {
			failedOnce = true;
			return Promise.reject(new Error("simulated commit failure"));
		}
		return send(request);
	});
	cleanups.push(() => failCommit.restore());

	// Batch 1 = [failFirst], Batch 2 = [failFirst, failSecond] (split because failFirst repeats).
	const [firstAttempt, secondAttempt, thirdAttempt] = await Promise.allSettled([
		state.outbox.markDelivered(failFirst),
		state.outbox.markDelivered(failFirst),
		state.outbox.markDelivered(failSecond),
	]);
	failCommit.restore();

	assert.equal(firstAttempt.status, "rejected");
	assert.equal(secondAttempt.status, "fulfilled");
	assert.equal(thirdAttempt.status, "fulfilled");
	if (secondAttempt.status === "fulfilled") assert.equal(secondAttempt.value.status, "delivered");
	if (thirdAttempt.status === "fulfilled") assert.equal(thirdAttempt.value.status, "delivered");
});

test("more than 100 same-turn markDelivered calls split cleanly into sequential batches in call order (#6716)", async () => {
	const state = await openBroker();
	const count = 105;
	for (let index = 0; index < count; index++) await enqueue(state, `bulk-${index}`, "target-bulk");
	const claimed = await claim(state, "broker-b", "target-bulk");
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	assert.equal(claimed.rows.length, count);

	const requests = recordRequests();
	const order: number[] = [];
	const results = await Promise.all(
		claimed.rows.map(({ claim: entry }, index) =>
			state.outbox.markDelivered(entry).then((result) => {
				order.push(index);
				return result;
			}),
		),
	);
	const { sent } = requests.take();

	assert.deepEqual(
		results.map((result) => result.status),
		Array(count).fill("delivered"),
	);
	assert.deepEqual(
		order,
		Array.from({ length: count }, (_, index) => index),
	);
	// 100 + 5 = 2 batches, 3 requests per batch (2 with #6698), 1 write lock per batch.
	assert.equal(sent.length, 2 * requestsPerBatch(sent));
	assert.equal(writeLocks(sent).length, 2);
});
