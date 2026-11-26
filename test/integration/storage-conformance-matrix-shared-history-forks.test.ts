import assert from "node:assert/strict";
import { describe, test } from "vitest";
import "../../packages/coding-agent/src/core/session-open-markers.js";
import type { SqliteDatabase, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	renderStorageIdentifiers,
	storageMigrationTable,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	schemaCatalogOf,
	withStorageSchemaCatalog,
} from "../../packages/coding-agent/src/core/storage/schema-catalog.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	bytesOf,
	header,
	SERVER_TIMEOUT_MS,
	seedSource,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * Forks share their parent's history by themselves (#6560): a session store's open, and `atomic storage migrate`,
 * switch the sessions schema to 3, with the fork tables, in one transaction. The switch waits while a session of an
 * older Atomic runs on the database, and forks copy meanwhile; once the database is switched, a build that does not
 * read schema 3 refuses it instead of reading a fork's own rows as its whole history. Runs on every backend of the
 * storage matrix.
 */

/**
 * The transactions a new store's first open runs, as many as an open before shared-history forks runs, none of them a
 * switch: on SQLite and libSQL the sessions schema with its fork tables, the snapshot tables, their index and the
 * search index; on PostgreSQL also the read-only reads of the schema catalog and of the snapshot index's state, then
 * the sessions, open-session and fillfactor steps, the snapshot tables with their index, and the search index.
 */
const TRANSACTIONS_OF_A_NEW_STORE: Record<string, number> = { sqlite: 4, postgres: 7 };

/**
 * What the open of a store already switched sends, as an open before shared-history forks does, nothing of it for the
 * switch: on SQLite and libSQL the schema catalog and the session versions, then the snapshot and search index probes,
 * each a statement of its own; on PostgreSQL the schema catalog and the snapshot index's state, each read in a
 * read-only transaction of its own.
 */
const WARM_OPEN: Record<string, { readonly transactions: number; readonly statements: number }> = {
	sqlite: { transactions: 0, statements: 6 },
	postgres: { transactions: 2, statements: 0 },
};

/** A heartbeat older than any marker counts for. */
const LONG_AGO_MS = 3_600_000;

const tables = (prefix: string) => renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);

async function schemaVersion(database: SqliteDatabase, prefix: string): Promise<number> {
	const row = await database.get(`SELECT schema_version FROM ${tables(prefix).meta}`);
	return Number(row?.schema_version);
}

async function tableExists(database: SqliteDatabase, table: string): Promise<boolean> {
	const probe = dialectOf(database).tableExists(table);
	return (await database.get(probe.sql, ...probe.params)) !== undefined;
}

/** The versions the migration ledger records for the sessions domain, where the dialect keeps one. */
async function ledger(database: SqliteDatabase, prefix: string): Promise<number[] | undefined> {
	if (!dialectOf(database).versionedMigrations) return undefined;
	const rows = await database.all(
		`SELECT version FROM ${storageMigrationTable(prefix)} WHERE domain = 'sessions' ORDER BY version`,
	);
	return rows.map((row) => Number(row.version));
}

/** Whether every fork table exists, the fork segments' first. */
async function forkTablesExist(database: SqliteDatabase, prefix: string): Promise<boolean> {
	for (const table of Object.values(sessionForkTables(prefix)))
		if (!(await tableExists(database, table))) return false;
	return true;
}

/** What `forkTo` does for a whole-session fork in one store: `createFork` with the complete feed. */
async function fork(store: SqlSessionStore, sourceId: string, child: SessionRecordHeader) {
	const head = await store.readEntrySizes(sourceId, 1, 0);
	const created = await store.createFork(child, completeSessionForkStream(sourceId, head.epoch, head.lastSeq), {
		store,
		sessionId: sourceId,
		epoch: head.epoch,
		hashes: [],
		receipts: new Map(),
	});
	assert.ok(created, "the store takes the fork");
	return created;
}

async function ownEntryRows(database: SqliteDatabase, prefix: string, id: string): Promise<number> {
	const row = await database.get(`SELECT COUNT(*) AS n FROM ${tables(prefix).entries} WHERE session_id = ?`, id);
	return Number(row?.n);
}

/**
 * A store at schema 2, as an older Atomic left it: opened while that build's session ran, with a chunked entry, then
 * that session ended. Its next open switches it.
 */
async function schemaTwoStore(database: SqliteDatabase, prefix: string): Promise<void> {
	const older = await holdOlderBuildMarker(database, prefix);
	const store = await SqlSessionStore.open(database, { prefix });
	await seedSource(store, "src", "older");
	await store.close();
	assert.equal(await schemaVersion(database, prefix), 2);
	await older.release();
}

/** Every statement `database` is sent, and every transaction it starts, until `stop`. */
function recording(database: SqliteDatabase) {
	const statements: string[] = [];
	let transactions = 0;
	const recorded = new Proxy(database, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver) as unknown;
			if (key === "transaction") {
				return (...args: unknown[]) => {
					transactions++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			if (key === "get" || key === "all" || key === "run" || key === "exec")
				return (sql: string, ...params: SqliteValue[]) => {
					statements.push(sql);
					return (value as (sql: string, ...p: SqliteValue[]) => unknown).call(target, sql, ...params);
				};
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
		},
	});
	return { database: recorded, statements, transactions: () => transactions };
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`the switch to shared-history forks on ${name} (#6560)`, () => {
		test(
			"a new store is at schema 3, with the fork tables and their snapshot links, from its first open, which takes no switch",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const first = recording(await scope.connect());
					await (await SqlSessionStore.open(first.database, { prefix: scope.prefix })).close();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });

					for (const sql of first.statements) {
						assert.ok(!/max\(schema_version\)/i.test(sql), `a new store's open read the version again: ${sql}`);
						assert.ok(!/schema_version IS NULL OR/.test(sql), `a new store's open read the markers: ${sql}`);
					}
					assert.equal(first.transactions(), TRANSACTIONS_OF_A_NEW_STORE[dialectOf(database).name]);
					const links = dialectOf(database).schemaObjects([`${tables(scope.prefix).entries}_fork_links_v1`]);
					assert.equal(
						(await database.all(links.sql, ...links.params)).length,
						1,
						"the fork links trigger exists",
					);
					assert.equal(await schemaVersion(database, scope.prefix), 3);
					assert.equal(await forkTablesExist(database, scope.prefix), true);
					assert.equal(await database.transaction((tx) => store.sharedHistoryForks(tx)), true);
					const recorded = await ledger(database, scope.prefix);
					if (recorded !== undefined) assert.deepEqual(recorded, [1, 2, 3]);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a store at schema 2 switches at its next open, its history unchanged",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					await schemaTwoStore(database, scope.prefix);
					const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });

					assert.equal(await schemaVersion(database, scope.prefix), 3, "that open switched it");
					assert.equal(await forkTablesExist(database, scope.prefix), true);
					const recorded = await ledger(database, scope.prefix);
					if (recorded !== undefined) assert.deepEqual(recorded, [1, 2, 3]);
					assert.equal((await store.load("src")).entries.length, 13, "the history is unchanged");
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"an open that switches the database refreshes the schema catalog it read, so stores it opens next see the fork tables",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					await schemaTwoStore(database, scope.prefix);
					const segments = sessionForkTables(scope.prefix).forkSegments;

					const seen = await withStorageSchemaCatalog(database, storageMigrationTable(scope.prefix), async () => {
						assert.equal((await schemaCatalogOf(database))?.hasTable(segments), false, "read before the switch");
						await SqlSessionStore.open(database, { prefix: scope.prefix });
						return (await schemaCatalogOf(database))?.hasTable(segments);
					});

					assert.equal(seen, true);
					assert.equal(await schemaVersion(database, scope.prefix), 3);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"while a session of an older Atomic runs, opens leave the schema alone and forks copy; once it ends, the next open switches",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const older = await holdOlderBuildMarker(database, scope.prefix, { pid: 4101 });
					const unmarked = await holdOlderBuildMarker(database, scope.prefix, {
						sessionId: "before-5065",
						pid: 4102,
						schemaVersion: null,
					});
					const crashed = await holdOlderBuildMarker(database, scope.prefix, {
						sessionId: "crashed",
						pid: 4103,
					});
					await crashed.age(LONG_AGO_MS);
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await seedSource(store, "src", "copy");

					const created = await fork(store, "src", header("child", "src"));
					assert.equal(created.lastSeq, 13);
					assert.equal(await ownEntryRows(database, scope.prefix, "child"), 13, "the fork copied its history");
					assert.equal(await schemaVersion(database, scope.prefix), 2, "neither the open nor the fork switched");
					assert.equal(await tableExists(database, sessionForkTables(scope.prefix).forkSegments), false);
					assert.equal(await database.transaction((tx) => store.sharedHistoryForks(tx)), false);

					await older.release();
					await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					assert.equal(
						await schemaVersion(database, scope.prefix),
						2,
						"a build that records no version still runs",
					);

					await unmarked.age(LONG_AGO_MS);
					await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					assert.equal(await schemaVersion(database, scope.prefix), 3, "no older session runs any more");
					assert.equal(await database.transaction((tx) => store.sharedHistoryForks(tx)), true);
					assert.deepEqual((await store.load("child")).entries, (await store.load("src")).entries);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a fork on schema 3 shares the parent's rows: it stores none of them, and reads as its parent does",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await seedSource(store, "src", "shared");

					const created = await fork(store, "src", header("child", "src"));

					assert.equal(created.lastSeq, 13);
					assert.deepEqual(created.remainingBlobs, []);
					assert.equal(await ownEntryRows(database, scope.prefix, "child"), 0, "the child stores no entry");
					const segments = await database.all(
						`SELECT source_id, from_seq, to_seq, base_seq FROM ${sessionForkTables(scope.prefix).forkSegments} WHERE session_id = ?`,
						"child",
					);
					assert.deepEqual(
						segments.map((row) => [
							row.source_id,
							Number(row.from_seq),
							Number(row.to_seq),
							Number(row.base_seq),
						]),
						[["src", 1, 13, 0]],
					);
					assert.equal(await schemaVersion(database, scope.prefix), 3);
					assert.deepEqual((await store.load("child")).entries, (await store.load("src")).entries);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a session of this release does not hold the switch back",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const older = await holdOlderBuildMarker(database, scope.prefix);
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await store.create(header("s"), [user("e1", null, "hello", 1)]);
					await store.openMarkers.put("s", { token: "4301-0123456789abcdef", pid: 4301, host: "this-release" });
					await older.release();

					await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });

					assert.equal(await schemaVersion(database, scope.prefix), 3);
					await store.append("s", [user("e2", "e1", "after", 2)], { expectSeq: 1 });
					assert.equal((await store.load("s")).entries.length, 2);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"two hosts opening a store at schema 2 at once both end on schema 3, beside a writer that keeps committing",
			() =>
				withBackendScope(backend, async (scope) => {
					const writerDb = await scope.connect();
					await schemaTwoStore(writerDb, scope.prefix);
					const writer = await SqlSessionStore.open(writerDb, { prefix: scope.prefix });
					await writer.create(header("w"), [user("e1", null, "hello", 1)]);
					const hosts = await Promise.all([scope.connect(), scope.connect()]);

					const appends = (async () => {
						for (let seq = 1; seq <= 6; seq++)
							await writer.append("w", [user(`e${seq + 1}`, `e${seq}`, `more ${seq}`, seq + 1)], {
								expectSeq: seq,
							});
					})();
					const opened = await Promise.all(
						hosts.map((host) => SqlSessionStore.open(host, { prefix: scope.prefix })),
					);
					await appends;

					assert.equal(await schemaVersion(writerDb, scope.prefix), 3);
					for (const store of opened)
						assert.equal(await writerDb.transaction((tx) => store.sharedHistoryForks(tx)), true);
					assert.equal((await writer.load("w")).entries.length, 7);
					const recorded = await ledger(writerDb, scope.prefix);
					if (recorded !== undefined) assert.deepEqual(recorded, [1, 2, 3], "one ledger row for version 3");
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"opening a switched store reads nothing more for the switch: no marker or version read, and no transaction of its own",
			() =>
				withBackendScope(backend, async (scope) => {
					await (await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix })).close();
					const warm = recording(await scope.connect());

					await (await SqlSessionStore.open(warm.database, { prefix: scope.prefix })).close();

					const open = `${scope.prefix}session_open`;
					for (const sql of warm.statements) {
						assert.ok(!sql.includes(open), `a warm open read the markers: ${sql}`);
						assert.ok(!/max\(schema_version\)/i.test(sql), `a warm open read the version again: ${sql}`);
					}
					assert.deepEqual(
						{ transactions: warm.transactions(), statements: warm.statements.length },
						WARM_OPEN[dialectOf(warm.database).name],
						`a warm open sent ${warm.statements.join(" | ")}`,
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a store refuses, in every read and write, a sessions schema newer than it reads, as an older Atomic refuses schema 3",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await seedSource(store, "src", "newer");
					// What this build is to a schema after it is what an Atomic without shared-history forks is to 3.
					await database.run(`UPDATE ${tables(scope.prefix).meta} SET schema_version = 4`);
					if (dialectOf(database).versionedMigrations)
						await database.run(
							`INSERT INTO ${storageMigrationTable(scope.prefix)} (domain, version, applied_at) VALUES ('sessions', 4, 0)`,
						);

					const operations: Record<string, () => Promise<unknown>> = {
						load: () => store.load("src"),
						readEntrySizes: () => store.readEntrySizes("src", 1, 13),
						readTail: () => store.readTail("src", 0),
						list: async () => {
							for await (const _ of store.list({})) break;
						},
						readRange: () => store.readRange("src", 1, 13),
						readEntryRange: () => store.readEntryRange("src", { fromSeq: 1, toSeq: 13 }),
						findEntrySeq: () => store.findEntrySeq("src", "e2"),
						getBlob: () => store.getBlob("src", "0".repeat(64)),
						readResume: () => store.readResume("src"),
						findLatestCompaction: () => store.findLatestCompaction("src"),
						putBlob: () => store.putBlob("src", bytesOf(50, 5)),
						create: () => store.create(header("new"), [user("e1", null, "hi", 1)]),
						append: () => store.append("src", [user("e14", "e13", "more", 14)], { expectSeq: 13 }),
						delete: () => store.delete("src"),
						fork: () => fork(store, "src", header("child", "src")),
					};
					const accepted: string[] = [];
					for (const [operation, run] of Object.entries(operations))
						await run().then(
							() => accepted.push(operation),
							(error) => {
								if (!(error instanceof StorageSchemaVersionError)) accepted.push(`${operation}: ${error}`);
							},
						);
					assert.deepEqual(accepted, [], "every operation refuses the newer schema");
					await assert.rejects(
						SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix }),
						StorageSchemaVersionError,
						"a new open refuses it before anything else opens",
					);
					await database.run(`UPDATE ${tables(scope.prefix).meta} SET schema_version = 3`);
					assert.equal((await store.load("src")).entries.length, 13, "nothing was written meanwhile");
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
