import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { withStorageSchemaCatalog } from "../../packages/coding-agent/src/core/storage/schema-catalog.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { interceptingDatabase } from "../helpers/intercepting-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests, requestSql } from "../helpers/sqlite-connection-requests.js";

/** The Intercom broker state before #5218, vendored: creates tables in per-store transactions without stamps. */
const earlierBrokerPath = resolve(
	moduleDir(import.meta.url),
	"../fixtures/intercom-pre-5218/broker/open-broker-state.ts",
);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDbPath(name: string): string {
	const directory = makeTempDirectory("atomic-sqlite-open-batch-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, name);
}

/** Measures per-connection waits (requests sent with none of that connection's in flight) and `begin` lock counts. */
async function measureOpen(run: () => Promise<void>) {
	const sent: ConnectionRequest[] = [];
	const unanswered = new WeakMap<object, number>();
	let waits = 0;
	let locks = 0;
	const interception = interceptConnectionRequests((request, send, connection) => {
		sent.push(request);
		const pending = unanswered.get(connection) ?? 0;
		if (pending === 0) waits += 1;
		if (request.kind === "begin") locks += 1;
		unanswered.set(connection, pending + 1);
		return send(request).finally(() => {
			unanswered.set(connection, (unanswered.get(connection) ?? 1) - 1);
		});
	});
	try {
		await run();
	} finally {
		interception.restore();
	}
	return { waits, locks, sent };
}

test("SQLite open-scope batching pins waits and write locks on Node for store and broker opens (#6709)", async () => {
	const storePath = tempDbPath("store.sqlite");
	const openStore = async () => {
		const db = await openNodeSqliteDatabase(storePath);
		const store = await SqlSessionStore.open(db);
		await store.close();
		await db.close();
	};
	const storeNew = await measureOpen(openStore);
	assert.deepEqual({ waits: storeNew.waits, locks: storeNew.locks }, { waits: 7, locks: 1 }, "Store, new database");
	const storeWarm = await measureOpen(openStore);
	assert.deepEqual({ waits: storeWarm.waits, locks: storeWarm.locks }, { waits: 5, locks: 0 }, "Store, warm");

	const brokerPath = tempDbPath("broker.sqlite");
	const openBroker = async () => {
		const { state, bus } = await openIntercomBrokerState({
			openDatabase: () => openNodeSqliteDatabase(brokerPath),
		});
		await bus.close();
		await state.close();
	};
	const brokerNew = await measureOpen(openBroker);
	assert.deepEqual(
		{ waits: brokerNew.waits, locks: brokerNew.locks },
		{ waits: 10, locks: 1 },
		"Broker, new database",
	);
	const brokerSecond = await measureOpen(openBroker);
	assert.deepEqual(
		{ waits: brokerSecond.waits, locks: brokerSecond.locks },
		{ waits: 8, locks: 0 },
		"Broker, second open",
	);
	const brokerWarm = await measureOpen(openBroker);
	assert.deepEqual({ waits: brokerWarm.waits, locks: brokerWarm.locks }, { waits: 8, locks: 0 }, "Broker, warm");
});

test("no broker or snapshot store reads its own uncommitted tables before the batched setup transaction commits (#6709)", async () => {
	const brokerPath = tempDbPath("broker-no-self-read.sqlite");
	const brokerOpen = await measureOpen(async () => {
		const { state, bus } = await openIntercomBrokerState({
			openDatabase: () => openNodeSqliteDatabase(brokerPath),
		});
		await bus.close();
		await state.close();
	});
	const brokerBeginIndex = brokerOpen.sent.findIndex((request) => request.kind === "begin");
	assert.ok(brokerBeginIndex > 0);
	const beforeBrokerBegin = brokerOpen.sent.slice(0, brokerBeginIndex).map((request) => requestSql(request) ?? "");
	assert.deepEqual(
		beforeBrokerBegin.filter((sql) => /\bintercom_/.test(sql)),
		[],
		"no broker table is queried before the batched write transaction commits",
	);

	const storePath = tempDbPath("store-no-self-read.sqlite");
	const storeOpen = await measureOpen(async () => {
		const db = await openNodeSqliteDatabase(storePath);
		const store = await SqlSessionStore.open(db);
		await store.close();
		await db.close();
	});
	const storeBeginIndex = storeOpen.sent.findIndex((request) => request.kind === "begin");
	assert.ok(storeBeginIndex > 0);
	const beforeStoreBegin = storeOpen.sent.slice(0, storeBeginIndex).map((request) => requestSql(request) ?? "");
	assert.deepEqual(
		beforeStoreBegin.filter((sql) => /\bsnapshot_|\bsession_search_/.test(sql)),
		[],
		"no snapshot or search table is queried before the batched write transaction commits",
	);
});

test("concurrent sibling opens on the same SQLite handle each commit their own schema before returning (#6709)", async () => {
	const db = await openNodeSqliteDatabase(tempDbPath("sibling.sqlite"));
	cleanups.push(() => db.close());

	let releaseSlow!: () => void;
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	let slowEntered!: () => void;
	const slowStarted = new Promise<void>((resolve) => {
		slowEntered = resolve;
	});

	// Sibling A stays open inside withStorageSchemaCatalog while Sibling B opens and returns first.
	const slowSibling = withStorageSchemaCatalog(db, "atomic_migrations", async () => {
		const outbox = await openSqlOutboxStore({ database: db, prefix: "" });
		slowEntered();
		await slowGate;
		return outbox;
	});
	await slowStarted;

	// Sibling B must commit intercom_held_sends before openSqlHeldSendStore resolves, even while slowSibling is active.
	const heldSends = await openSqlHeldSendStore({ database: db, prefix: "" });
	const held = await heldSends.hold({
		reservationKey: "r1",
		originBrokerId: "b1",
		senderSessionId: "s1",
		request: {
			type: "send",
			to: "s2",
			message: { id: "m1", timestamp: 1, delivery: "steer", content: { text: "hi" } },
		},
	});
	assert.equal(held.status, "held");

	releaseSlow();
	const outbox = await slowSibling;
	const read = await outbox.read("missing");
	assert.equal(read.status, "missing");
});

test("a polling opener sees another host's batched commit and finishes with zero write locks (#6709)", async () => {
	const path = tempDbPath("poll-done.sqlite");
	const secondDb = await openNodeSqliteDatabase(path);
	cleanups.push(() => secondDb.close());

	let releaseWinnerCommit!: () => void;
	const holdWinnerCommit = new Promise<void>((resolve) => {
		releaseWinnerCommit = resolve;
	});
	let winnerHoldingLock!: () => void;
	const lockHeld = new Promise<void>((resolve) => {
		winnerHoldingLock = resolve;
	});

	// Pause the winner's batched setup right after BEGIN IMMEDIATE (before COMMIT), so it holds SQLite's write lock
	// while the second opener starts and enters its tryMaintenance poll loop.
	let pausedWinner = false;
	const interception = interceptConnectionRequests(async (request, send) => {
		if (!pausedWinner && request.kind === "sequence") {
			pausedWinner = true;
			winnerHoldingLock();
			await holdWinnerCommit;
		}
		return send(request);
	});
	cleanups.push(() => interception.restore());

	const winnerOpen = openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
	await lockHeld;

	// Second connection opens a broker while winner holds the write lock: tryMaintenance returns false and polls.
	let secondLocks = 0;
	let tryMaintenanceMisses = 0;
	const origTryMaintenance = secondDb.tryMaintenance!.bind(secondDb);
	secondDb.tryMaintenance = async (callback) => {
		const won = await origTryMaintenance(callback);
		if (won) secondLocks += 1;
		else tryMaintenanceMisses += 1;
		return won;
	};
	const origTx = secondDb.transaction.bind(secondDb);
	secondDb.transaction = ((callback, options) => {
		if (options?.readOnly !== true) secondLocks += 1;
		return origTx(callback, options);
	}) as SqliteDatabase["transaction"];

	const secondOpen = openIntercomBrokerState({ openDatabase: async () => secondDb });
	while (tryMaintenanceMisses === 0) await new Promise((resolve) => setTimeout(resolve, 10));

	// Release winner to commit all broker tables + stamps atomically; polling opener finishes with 0 write locks.
	releaseWinnerCommit();
	const winner = await winnerOpen;
	await winner.bus.close();
	await winner.state.close();

	const second = await secondOpen;
	assert.equal(secondLocks, 0, "polling opener took no write lock once winner committed");
	assert.ok(tryMaintenanceMisses >= 1);
	await second.bus.close();
	await second.state.close();
});

test("an opener falls back from tryMaintenance polling to a waiting transaction when an unrelated writer holds the lock (#6709)", async () => {
	const path = tempDbPath("poll-fallback.sqlite");
	const holder = await openNodeSqliteDatabase(path);
	const opener = await openNodeSqliteDatabase(path);
	cleanups.push(async () => {
		await opener.close();
		await holder.close();
	});

	let releaseHolder!: () => void;
	const holdLock = new Promise<void>((resolve) => {
		releaseHolder = resolve;
	});
	let holderEntered!: () => void;
	const holderReady = new Promise<void>((resolve) => {
		holderEntered = resolve;
	});

	const writerTx = holder.transaction(async (tx) => {
		await tx.exec("CREATE TABLE IF NOT EXISTS unrelated_work (id INTEGER PRIMARY KEY)");
		holderEntered();
		await holdLock;
	});
	await holderReady;

	let fallbackTxCalls = 0;
	const origTx = opener.transaction.bind(opener);
	opener.transaction = ((callback, options) => {
		if (options?.readOnly !== true) fallbackTxCalls += 1;
		return origTx(callback, options);
	}) as SqliteDatabase["transaction"];

	// Hold the write lock past SQLITE_BATCH_WAIT_MS (1000 ms) so opener falls back to database.transaction.
	const opening = SqlSessionStore.open(opener);
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	releaseHolder();
	await writerTx;

	const store = await opening;
	await store.close();
	assert.equal(fallbackTxCalls, 1, "fell back to one waiting serial transaction after poll deadline");
	const tables = await opener.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_meta', 'snapshot_blobs', 'session_search_state') ORDER BY name",
	);
	assert.deepEqual(
		tables.map((row) => row.name),
		["session_meta", "session_search_state", "snapshot_blobs"],
	);
});

test("concurrent new-build and older-build broker opens on a fresh SQLite file both succeed and converge cleanly (#6709)", async () => {
	const path = tempDbPath("mixed-builds.sqlite");
	const earlier = (await import(earlierBrokerPath)).openIntercomBrokerState as typeof openIntercomBrokerState;

	const [newerResult, olderResult] = await Promise.all([
		openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) }),
		earlier({ openDatabase: () => openNodeSqliteDatabase(path) }),
	]);
	try {
		const r1 = await newerResult.state.reservations.reserve({
			reservationKey: "k-new",
			ownerSessionId: "owner-new",
			ownerBrokerId: "broker-new",
			childName: "child-new",
			childTarget: "child-new",
			aliases: [],
			group: "g",
			dormant: false,
			wake: false,
		});
		const r2 = await olderResult.state.reservations.reserve({
			reservationKey: "k-old",
			ownerSessionId: "owner-old",
			ownerBrokerId: "broker-old",
			childName: "child-old",
			childTarget: "child-old",
			aliases: [],
			group: "g",
			dormant: false,
			wake: false,
		});
		assert.equal(r1.status, "reserved");
		assert.equal(r2.status, "reserved");
	} finally {
		await newerResult.bus.close();
		await newerResult.state.close();
		await olderResult.bus.close();
		await olderResult.state.close();
	}

	// Next new-build open brings stamps up to date if the older build ran DDL after it; the open after that takes 0 locks.
	const repair = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
	await repair.bus.close();
	await repair.state.close();

	const warm = await measureOpen(async () => {
		const broker = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
		await broker.bus.close();
		await broker.state.close();
	});
	assert.equal(warm.locks, 0);
	assert.equal(warm.waits, 8);
});

test("a mid-transaction abort rolls back the batched schema setup atomically and the next open recovers cleanly (#6709)", async () => {
	const path = tempDbPath("abort-recovery.sqlite");
	const db = await openNodeSqliteDatabase(path);
	cleanups.push(() => db.close());

	// Inject a failure during the batched commit sequence (simulating disk full / crash mid-transaction).
	let failedOnce = false;
	const failing = interceptConnectionRequests((request, send) => {
		if (!failedOnce && request.kind === "sequence") {
			failedOnce = true;
			return Promise.reject(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 }));
		}
		return send(request);
	});
	try {
		await assert.rejects(
			openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) }),
			/disk I\/O error/,
		);
	} finally {
		failing.restore();
	}
	assert.equal(failedOnce, true);

	// Zero partial tables were committed because all broker setups ran in one atomic write transaction.
	const partialTables = await db.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
	);
	assert.deepEqual(partialTables, []);

	// Next open recovers cleanly in one write transaction.
	const recovered = await measureOpen(async () => {
		const broker = await openIntercomBrokerState({ openDatabase: () => openNodeSqliteDatabase(path) });
		await broker.bus.close();
		await broker.state.close();
	});
	assert.equal(recovered.locks, 1);
	assert.equal(recovered.waits, 10);
});

test("a database initialized by a newer unsupported sessions schema refuses open without creating extra tables (#6709)", async () => {
	const path = tempDbPath("newer-version.sqlite");
	const db = await openNodeSqliteDatabase(path);
	cleanups.push(() => db.close());
	await db.exec(
		"CREATE TABLE session_meta (schema_version INTEGER NOT NULL) STRICT; INSERT INTO session_meta VALUES (99)",
	);

	await assert.rejects(SqlSessionStore.open(db), StorageSchemaVersionError);
	const tables = await db.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	assert.deepEqual(
		tables.map((row) => row.name),
		["session_meta"],
	);
});

test("a failure creating the optional FTS5 search table still commits sessions and snapshot tables cleanly (#6709)", async () => {
	const path = tempDbPath("fts5-failure.sqlite");
	const db = await openNodeSqliteDatabase(path);
	cleanups.push(() => db.close());

	const wrapped = interceptingDatabase(db, {
		exec: (sql, next) => (sql.includes("USING fts5") ? Promise.reject(new Error("no such module: fts5")) : next(sql)),
	});
	const store = await SqlSessionStore.open(wrapped);
	await store.close();

	const tables = await db.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_meta', 'session_sessions', 'snapshot_blobs', 'session_search_fts') ORDER BY name",
	);
	assert.deepEqual(
		tables.map((row) => row.name),
		["session_meta", "session_sessions", "snapshot_blobs"],
	);
});
