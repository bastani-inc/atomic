import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { IntercomDeliveryFrame } from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore, readLiveBrokerNodes } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { ensureRetentionIndexes } from "../../packages/intercom/broker/sql-retention.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

import { interceptingDatabase } from "../helpers/intercepting-database.js";
import { makeTempDirectory, moduleDir, readJson, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Characterization of the run journal's and Intercom routing's SQL on SQLite, pinned before their statements moved to
 * the portable subset and the storage dialect (#4793): the schema text stays byte-identical, so an older Atomic keeps
 * sharing the database, and each rewritten statement keeps its observable behavior.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("portable-sql-4793-");
	const db = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		await db.close();
		removeTempDirectory(directory);
	});
	return db;
}

const SCHEMA_FIXTURE = join(moduleDir(import.meta.url), "../fixtures/portable-sql-4793-sqlite-schema.json");
/**
 * The tables and indexes this slice owns. The snapshot blob tables and the triggers on the journal tables belong to the
 * snapshot blob store.
 */
const OWNED_TABLE = /^(team_)?intercom_.+$/;

async function openEveryOwnedStore(db: SqliteDatabase): Promise<void> {
	for (const prefix of ["", "team_"]) {
		const options = { database: db, prefix };
		await openSqlBrokerLeaseStore(options);
		await openSqlOutboxStore(options);
		await openSqlHeldSendStore(options);
		await openSqlRestoringReservationStore(options);
		await openSqlPendingAskStore(options);
		await openSqlReleasedAskStore(options);
		await openSqlSentMessageAuthority(options);
		await openSqlKnownSessionStore(options);
		// As a broker's open ends, once every table is there.
		await ensureRetentionIndexes(db, prefix);
		const bus = await openDatabaseWakeUpBus({ openDatabase: async () => db, prefix });
		cleanups.push(() => bus.close());
	}
}

async function ownedSchema(db: SqliteExecutor): Promise<SqliteRow[]> {
	const rows = await db.all<SqliteRow & { tbl_name: string }>(
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
	);
	return rows.filter((row) => OWNED_TABLE.test(row.tbl_name));
}

test("the SQLite schema of Intercom routing tables is byte-identical to the pinned one (#4793)", async () => {
	const db = await database();
	await openEveryOwnedStore(db);
	const schema = await ownedSchema(db);
	assert.ok(schema.length > 20, "every owned table and index was created");
	assert.deepEqual(
		schema,
		(await readJson<(SqliteRow & { tbl_name: string })[]>(SCHEMA_FIXTURE)).filter((row) =>
			OWNED_TABLE.test(row.tbl_name),
		),
	);
	// Opening again, as a second broker or journal does, changes nothing.
	await openEveryOwnedStore(db);
	assert.deepEqual(await ownedSchema(db), schema);
});

/** A facade whose `batch` runs every statement in one transaction, as a driver that sends a batch in one request. */
function batchingFacade(source: SqliteDatabase): SqliteDatabase {
	return {
		exec: (sql) => source.exec(sql),
		run: (sql, ...params) => source.run(sql, ...params),
		get: (sql, ...params) => source.get(sql, ...params),
		all: (sql, ...params) => source.all(sql, ...params),
		descriptor: { adapter: "test-sqlite", location: "test database" },
		transaction: (callback) => source.transaction(callback),
		batch: (statements) =>
			source.transaction(async (tx) => {
				const rows: SqliteRow[][] = [];
				for (const { sql, params } of statements) rows.push(await tx.all(sql, ...params));
				return rows;
			}),
		close: () => source.close(),
	};
}

const reservation = {
	reservationKey: "released:child",
	ownerSessionId: "owner",
	ownerBrokerId: "broker-a",
	childName: "child",
	childTarget: "child",
	aliases: [] as string[],
	group: "crew",
	dormant: false,
	wake: true,
};

test("reserving an ended reservation's key again starts it with no wake request, generation or end (#4793)", async () => {
	const db = await database();
	const store = await openSqlRestoringReservationStore({ database: db, prefix: "" });
	await store.reserve(reservation);
	await store.reserve({ ...reservation, ownerBrokerId: "broker-b" });
	assert.equal((await store.requestWake(reservation.reservationKey)).status, "requested");
	const held = await store.read(reservation.reservationKey);
	assert.equal(held.status, "active");
	if (held.status !== "active") return;
	assert.equal(held.reservation.wakeGeneration, 1);
	const lease = {
		reservationKey: reservation.reservationKey,
		ownerSessionId: "owner",
		fencingToken: held.reservation.fencingToken,
	};
	assert.deepEqual(await store.release(lease, { gone: "exited" }), { status: "gone" });
	assert.deepEqual(await store.release(lease), { status: "released" });

	const again = await store.reserve({ ...reservation, ownerSessionId: "next" });
	assert.equal(again.status, "reserved");
	assert.deepEqual(
		await db.all(
			`SELECT reservation_key, owner_session_id, wake, wake_requested, wake_generation, gone, end_json, ended_at
			FROM intercom_restoring_reservations`,
		),
		[
			{
				reservation_key: reservation.reservationKey,
				owner_session_id: "next",
				wake: 1,
				wake_requested: 0,
				wake_generation: 0,
				gone: null,
				end_json: null,
				ended_at: null,
			},
		],
	);
});

test("a wake claim is recorded once per message and fencing token (#4793)", async () => {
	const store = await openSqlRestoringReservationStore({ database: await database(), prefix: "" });
	await store.reserve(reservation);
	const read = await store.read(reservation.reservationKey);
	if (read.status !== "active") throw new Error("not active");
	const claim = { fencingToken: read.reservation.fencingToken, wakeGeneration: 0, messageId: "send" };
	assert.deepEqual(await store.requestWake(reservation.reservationKey, claim), { status: "requested" });
	assert.deepEqual(await store.requestWake(reservation.reservationKey, claim), { status: "not-wakeable" });
	assert.deepEqual(await store.requestWake(reservation.reservationKey, { ...claim, fencingToken: 99 }), {
		status: "not-wakeable",
	});
});

test("a released ask past its deadline reads as missing, one before it as found (#4793)", async () => {
	const store = await openSqlReleasedAskStore({ database: await database(), prefix: "" });
	const ask = {
		questionId: "q",
		replierSessionId: "replier",
		askerSessionId: "asker",
		childName: "child",
		ownerSessionId: "owner",
	};
	assert.deepEqual(await store.keep([ask], -1), { status: "kept", kept: 1 });
	assert.deepEqual(await store.lookup(ask), { status: "missing" });
	assert.deepEqual(await store.keep([{ ...ask, questionId: "live" }], 60_000), { status: "kept", kept: 1 });
	assert.equal((await store.lookup({ ...ask, questionId: "live" })).status, "found");
});

test("Intercom ages written in the future read as zero, never negative (#4793)", async () => {
	const db = await database();
	const leases = await openSqlBrokerLeaseStore({ database: db, prefix: "" });
	const known = await openSqlKnownSessionStore({ database: db, prefix: "" });
	const subject = { kind: "broker", brokerId: "b", nodeId: "node", startedAt: 0 } as const;
	assert.equal((await leases.acquire(subject, "holder", 1_000)).status, "acquired");
	await known.record({ targetIdentity: "t", intercomSessionId: "s", group: "g", groups: ["g"] });
	await db.run("UPDATE intercom_leases SET renewed_at = ?", Number.MAX_SAFE_INTEGER);
	await db.run("UPDATE intercom_known_sessions SET recorded_at = ?", Number.MAX_SAFE_INTEGER);
	const lease = await leases.read({ kind: "broker", brokerId: "b" });
	assert.equal(lease.status === "found" && lease.lease.ageMs, 0);
	assert.deepEqual(await readLiveBrokerNodes(db, "", 0), ["node"]);
	const found = await known.lookup("s", 0);
	assert.equal(found.status === "found" && found.sessions[0]?.ageMs, 0);
});

test("a broker's live nodes are undefined before any broker created the lease table (#4793)", async () => {
	assert.equal(await readLiveBrokerNodes(await database(), "team_", 1_000), undefined);
});

test("an outbox claim's age is null while unclaimed and clamped to zero once claimed (#4793)", async () => {
	const db = await database();
	const outbox = await openSqlOutboxStore({ database: db, prefix: "" });
	const from: SessionInfo = { id: "sender", cwd: "/", model: "m", pid: 1, startedAt: 0, lastActivity: 0 };
	const frame: IntercomDeliveryFrame = {
		type: "message",
		from,
		message: { id: "m", timestamp: 0, content: { text: "hi" } },
	};
	await outbox.enqueue({ targetIdentity: "t", originBrokerId: "b", digest: "d", frame });
	const claimed = await outbox.claim({ claimantId: "c", targetIdentity: "t", staleAfterMs: 1_000 });
	assert.equal(claimed.status === "claimed" && claimed.rows.length, 1);
	if (claimed.status !== "claimed") return;
	await db.run("UPDATE intercom_outbox SET claim_renewed_at = ?", Number.MAX_SAFE_INTEGER);
	assert.equal((await outbox.reportSaving!(claimed.rows[0]!.claim)).status, "renewed");
	await db.run("UPDATE intercom_outbox SET saving_at = ?", Number.MAX_SAFE_INTEGER);
	const read = await outbox.read("m");
	assert.equal(read.status === "found" && read.row.savingAgeMs, 0);
	// A claim renewed "in the future" is live for any staleness bound, so another claimant is held off.
	assert.deepEqual(await outbox.claim({ claimantId: "other", targetIdentity: "t", staleAfterMs: 0 }), {
		status: "held",
		claimantId: "c",
	});
});

/** `db`, where every column probe finds nothing and every `ALTER TABLE` fails with `failure`. */
function failingAlters(db: SqliteDatabase, failure: Error): SqliteDatabase {
	return interceptingDatabase(
		{ ...batchingFacade(db), batch: undefined },
		{
			// The probes, and the schema catalog an open reads, which lists columns with pragma_table_xinfo, miss the columns.
			all: async (sql, params, next) => (/table_x?info/i.test(sql) ? [] : next(sql, ...params)),
			exec: (sql, next) => (sql.startsWith("ALTER TABLE") ? Promise.reject(failure) : next(sql)),
		},
	);
}

test("a column another broker added meanwhile is not an error in Postgres's wording either (#4793)", async () => {
	const db = await database();
	// Another broker opened the store first, so its columns exist although this broker's probe does not see them.
	await openSqlOutboxStore({ database: db, prefix: "" });
	const postgres = new Error('column "saving_at" of relation "intercom_outbox" already exists');
	await openSqlOutboxStore({ database: failingAlters(db, postgres), prefix: "" });
	const other = new Error('relation "intercom_outbox" already exists');
	await assert.rejects(openSqlOutboxStore({ database: failingAlters(db, other), prefix: "" }), other);
});

test("pruning known sessions removes only the records older than the bound (#4793)", async () => {
	const db = await database();
	const known = await openSqlKnownSessionStore({ database: db, prefix: "" });
	await known.record({ targetIdentity: "old", intercomSessionId: "a", group: "g", groups: ["g"] });
	await known.record({ targetIdentity: "new", intercomSessionId: "b", group: "g", groups: ["g"] });
	await db.run("UPDATE intercom_known_sessions SET recorded_at = 0 WHERE target_identity = 'old'");
	assert.equal(await known.prune(60_000), 1);
	assert.deepEqual(await db.all("SELECT target_identity FROM intercom_known_sessions"), [{ target_identity: "new" }]);
});
