import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, requestSql } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(name: string): string {
	const directory = makeTempDirectory("atomic-schema-catalog-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, name);
}

/** Every request sent to a connection's thread until the test ends, and the waits: requests sent while none was out. */
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
		sent,
		take() {
			const taken = { sent: [...sent], waits };
			sent.length = 0;
			waits = 0;
			return taken;
		},
	};
}

/** The requests that ask whether one table, column or object exists. */
const probes = (sent: readonly ConnectionRequest[]) =>
	sent.filter((request) =>
		/sqlite_master WHERE type = 'table' AND name = \?|pragma_table_info\(\?\)|pragma_table_xinfo\(\?\)/.test(
			requestSql(request) ?? "",
		),
	);

async function openBroker(path: string) {
	const { state, bus } = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
	await bus.close();
	await state.close();
}

test("a broker reopened on a SQLite file whose schema is current takes the write lock once, not once per store (#6560)", async () => {
	const path = databasePath("broker.sqlite");
	await openBroker(path);
	const requests = recordRequests();
	await openBroker(path);
	const { sent, waits } = requests.take();
	const begins = sent.filter((request) => request.kind === "begin");
	// The restoring reservations' counters are seeded on every open: an insert that may write is still run. The other
	// stores' setups only create tables and indexes the schema holds, and each took the write lock: 30 times, in 97 waits.
	assert.equal(begins.length, 1, `${begins.length} write transactions`);
	assert.deepEqual(probes(sent), [], "no table or column was probed on its own");
	assert.ok(waits <= 12, `${waits} waits for the connection's thread`);
});

test("a broker reopened after a table or index of its schema was dropped creates it again", async () => {
	const path = databasePath("broker.sqlite");
	await openBroker(path);
	const database = await openNodeSqliteDatabase(path);
	await database.exec("DROP INDEX intercom_outbox_target_bytes; DROP TABLE intercom_pending_asks");
	await database.close();
	await openBroker(path);
	const reopened = await openNodeSqliteDatabase(path);
	cleanups.push(() => reopened.close());
	const names = await reopened.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE name IN ('intercom_outbox_target_bytes', 'intercom_pending_asks') ORDER BY name",
	);
	assert.deepEqual(
		names.map((row) => row.name),
		["intercom_outbox_target_bytes", "intercom_pending_asks"],
	);
});

test("a session store reopened on a SQLite file whose schema is current reads it in one statement, not a probe per table (#6560)", async () => {
	const path = databasePath("store.sqlite");
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	await (await SqlSessionStore.open(database)).close();
	const requests = recordRequests();
	await (await SqlSessionStore.open(database)).close();
	const { sent, waits } = requests.take();
	// 42 requests before, 33 of them a probe of one table or column each, which a server answers one request each.
	assert.deepEqual(probes(sent), []);
	assert.ok(sent.length <= 10, `${sent.length} requests`);
	// The schema with the versions, then the snapshot index; three before.
	assert.equal(waits, 2);
});

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
function thread(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= count; i++)
		entries.push({
			type: "message",
			id: `m${i}`,
			parentId: i === 1 ? null : `m${i - 1}`,
			timestamp: "2026-11-25T00:00:01.000Z",
			message: { role: "user", content: `entry ${i}`, timestamp: 1 },
		} as SessionEntry);
	return entries;
}

async function storeWith(entries: readonly SessionEntry[]): Promise<{ store: SqlSessionStore; db: SqliteDatabase }> {
	const db = await openNodeSqliteDatabase(databasePath("store.sqlite"));
	const store = await SqlSessionStore.open(db);
	cleanups.push(async () => {
		await store.close();
		await db.close();
	});
	await store.create(header("s1"), entries);
	return { store, db };
}

test("a page of entries is read with the session's watermark in one statement (#6560)", async () => {
	const { store } = await storeWith(thread(12));
	const requests = recordRequests();
	const page = await store.readEntryRange("s1", { fromSeq: 3, toSeq: 50 });
	const { sent } = requests.take();
	assert.equal(sent.length, 1, sent.map((request) => requestSql(request) ?? request.kind).join(" | "));
	assert.equal(page.lastSeq, 12);
	assert.equal(page.throughSeq, 12);
	assert.deepEqual(
		page.entries.map(({ seq, entry }) => [seq, entry.id]),
		Array.from({ length: 10 }, (_, index) => [index + 3, `m${index + 3}`]),
	);
	const empty = await store.readEntryRange("s1", { fromSeq: 13, toSeq: 20 });
	assert.deepEqual(empty, { lastSeq: 12, entries: [], throughSeq: 12 });
	await assert.rejects(store.readEntryRange("missing", { fromSeq: 1, toSeq: 2 }), /missing/);
});

test("the tail of a session whose resume index is current is read in one transaction, with no read before it (#6560)", async () => {
	const { store } = await storeWith(thread(12));
	// The first read after the create may compute the index; the next finds it current.
	await store.readTail("s1", 10);
	const requests = recordRequests();
	const tail = await store.readTail("s1", 10);
	const { sent } = requests.take();
	const begins = (request: ConnectionRequest) =>
		request.kind === "begin" || /^\s*BEGIN\b/i.test(requestSql(request) ?? "");
	assert.equal(sent.filter(begins).length, 1, sent.map((request) => requestSql(request) ?? request.kind).join(" | "));
	assert.deepEqual(sent.slice(0, sent.findIndex(begins)), [], "nothing was read before the transaction");
	assert.deepEqual(
		tail.entries.map((entry) => entry.id),
		["m10", "m11", "m12"],
	);
});
