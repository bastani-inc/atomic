import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import {
	type IntercomBrokerStateStore,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, requestSql } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openBroker(): Promise<IntercomBrokerStateStore> {
	const directory = makeTempDirectory("atomic-outbox-claim-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "broker.sqlite");
	const { state, bus } = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
	// Only the outbox's calls are counted: the wake-up bus, which polls on its own, is closed first.
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

/** The requests that take the database's write lock: a `BEGIN IMMEDIATE`, or a write statement run on its own. */
const writeLocks = (sent: readonly ConnectionRequest[]) =>
	sent.filter(
		(request) => request.kind === "begin" || /^\s*(UPDATE|INSERT|DELETE)\b/i.test(requestSql(request) ?? ""),
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

test("an empty outbox poll on a SQLite file is one read and takes no write lock (#6560)", async () => {
	const state = await openBroker();
	const requests = recordRequests();
	assert.deepEqual(await claim(state, "broker-b", "target-a"), { status: "claimed", rows: [] });
	const { sent, waits } = requests.take();
	assert.equal(waits, 1);
	assert.deepEqual(writeLocks(sent), []);
});

test("a claim of queued messages on a SQLite file is one read and one write, not a transaction (#6560)", async () => {
	const state = await openBroker();
	for (const id of ["m-1", "m-2", "m-3"]) await enqueue(state, id, "target-a");
	const requests = recordRequests();
	const claimed = await claim(state, "broker-b", "target-a");
	const { sent, waits } = requests.take();
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") return;
	assert.deepEqual(
		claimed.rows.map(({ row, claim }) => [
			row.messageId,
			row.state,
			row.claimAttempts,
			claim.claimantId,
			claim.attempt,
		]),
		[
			["m-1", "claimed", 1, "broker-b", 1],
			["m-2", "claimed", 1, "broker-b", 1],
			["m-3", "claimed", 1, "broker-b", 1],
		],
	);
	// Five waits before, nine for five rows: the read, then a transaction with a write for each row.
	assert.equal(waits, 2);
	assert.equal(writeLocks(sent).length, 1);
	assert.deepEqual(
		await Promise.all(claimed.rows.map(async ({ claim }) => (await state.outbox.markDelivered(claim)).status)),
		["delivered", "delivered", "delivered"],
	);
});

test("a claim another broker holds, or of the claimant's own rows in flight, is one read without a write lock (#6560)", async () => {
	const state = await openBroker();
	await enqueue(state, "m-1", "target-a");
	const first = await claim(state, "broker-b", "target-a");
	assert.equal(first.status, "claimed");
	await enqueue(state, "m-2", "target-a");
	const requests = recordRequests();
	assert.deepEqual(await claim(state, "broker-c", "target-a"), { status: "held", claimantId: "broker-b" });
	const held = requests.take();
	assert.equal(held.waits, 1);
	assert.deepEqual(writeLocks(held.sent), []);
	// The claimant's own live claim stays in flight; the row queued behind it is its own to take next.
	const again = await claim(state, "broker-b", "target-a");
	assert.equal(again.status, "claimed");
	if (again.status !== "claimed") return;
	assert.deepEqual(
		again.rows.map(({ row }) => row.messageId),
		["m-2"],
	);
	requests.take();
	assert.deepEqual(await claim(state, "broker-b", "target-a"), { status: "claimed", rows: [] });
	const inFlight = requests.take();
	assert.equal(inFlight.waits, 1);
	assert.deepEqual(writeLocks(inFlight.sent), []);
});
