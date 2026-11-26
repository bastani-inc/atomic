import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { sessionOpenMarkerRuns } from "../../packages/coding-agent/src/core/session-open-markers.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	renderStorageIdentifiers,
	storageMigrationTable,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_PRESENCE_TABLES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";
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
 * Forks that share their parent's history are opt-in (#6560): only `atomic storage migrate
 * --enable-shared-history-forks` raises the sessions schema to 3, never a fork. It refuses while sessions of an older
 * Atomic run there, and once it is done a build that does not read the new schema refuses the store instead of reading
 * a fork's own rows as its whole history. Runs on every backend of the storage matrix.
 */

const OLD_HOST = "older-atomic-host";
/** A heartbeat older than any marker of another host counts for. */
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

/**
 * The marker an Atomic release from before shared-history forks keeps for a session it runs, as its own statement writes
 * it: the sessions schema it reads (2, or none before #5065) and no Atomic version. `ageMs` back-dates its heartbeat.
 */
async function olderBuildMarker(
	database: SqliteDatabase,
	prefix: string,
	marker: { sessionId: string; pid: number; schemaVersion: number | null; ageMs?: number },
): Promise<void> {
	const open = renderStorageIdentifiers("sessions", SESSION_PRESENCE_TABLES, prefix).open;
	await database.run(
		`INSERT INTO ${open} (session_id, token, pid, host, heartbeat_at, schema_version) VALUES (?, ?, ?, ?, ${dialectOf(database).nowMs} - ?, ?)`,
		marker.sessionId,
		`${marker.pid}-0123456789abcdef`,
		marker.pid,
		OLD_HOST,
		marker.ageMs ?? 0,
		marker.schemaVersion,
	);
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

const enable = (store: SqlSessionStore, force = false) =>
	store.enableSharedHistoryForks({ force, live: sessionOpenMarkerRuns });

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`turning on shared-history forks on ${name} (#6560)`, () => {
		test(
			"a fork on schema 2 copies the parent's rows and leaves the schema where it was",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await seedSource(store, "src", "copy");
					assert.equal(await schemaVersion(database, scope.prefix), 2, "a chunked entry raised it to 2");

					const created = await fork(store, "src", header("child", "src"));

					assert.equal(created.lastSeq, 13);
					assert.equal(await ownEntryRows(database, scope.prefix, "child"), 13, "the child holds its own rows");
					assert.equal(await schemaVersion(database, scope.prefix), 2, "a fork never raises the schema");
					assert.equal(await tableExists(database, sessionForkTables(scope.prefix).forkSegments), false);
					assert.equal(await database.transaction((tx) => store.sharedHistoryForks(tx)), false);
					assert.deepEqual((await store.load("child")).entries, (await store.load("src")).entries);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"turning them on is refused while a session of an older Atomic runs, and goes ahead once it stopped",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await store.create(header("s"), [user("e1", null, "hello", 1)]);
					await olderBuildMarker(database, scope.prefix, { sessionId: "s", pid: 4101, schemaVersion: 2 });
					await olderBuildMarker(database, scope.prefix, { sessionId: "t", pid: 4102, schemaVersion: null });
					await olderBuildMarker(database, scope.prefix, {
						sessionId: "u",
						pid: 4103,
						schemaVersion: 2,
						ageMs: LONG_AGO_MS,
					});

					const refused = await enable(store);

					assert.equal(refused.status, "refused");
					assert.deepEqual(
						refused.status === "refused"
							? refused.holders.map(({ host, pid, sessionId, build }) => ({ host, pid, sessionId, build }))
							: [],
						[
							{ host: OLD_HOST, pid: 4101, sessionId: "s", build: undefined },
							{ host: OLD_HOST, pid: 4102, sessionId: "t", build: undefined },
						],
						"the two running older sessions, not the one whose process stopped long ago",
					);
					assert.equal(await schemaVersion(database, scope.prefix), 1, "nothing changed");
					assert.equal(await tableExists(database, sessionForkTables(scope.prefix).forkSegments), false);

					const open = renderStorageIdentifiers("sessions", SESSION_PRESENCE_TABLES, scope.prefix).open;
					await database.run(`UPDATE ${open} SET heartbeat_at = heartbeat_at - ?`, LONG_AGO_MS);
					assert.deepEqual(await enable(store), { status: "enabled", bypassed: [] });
					assert.equal(await schemaVersion(database, scope.prefix), 3);
					for (const table of Object.values(sessionForkTables(scope.prefix)))
						assert.equal(await tableExists(database, table), true, `${table} exists`);
					assert.deepEqual(await enable(store), { status: "already" });
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"--force turns them on while a session of an older Atomic runs, and names it",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await store.create(header("s"), [user("e1", null, "hello", 1)]);
					await olderBuildMarker(database, scope.prefix, { sessionId: "s", pid: 4201, schemaVersion: 2 });

					const forced = await enable(store, true);

					assert.equal(forced.status, "enabled");
					assert.deepEqual(
						forced.status === "enabled" ? forced.bypassed.map(({ pid }) => pid) : [],
						[4201],
						"the bypassed session is reported",
					);
					assert.equal(await schemaVersion(database, scope.prefix), 3);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a session of this release does not hold the switch back, and a store opened before it sees it in its next transaction",
			() =>
				withBackendScope(backend, async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await store.create(header("s"), [user("e1", null, "hello", 1)]);
					await store.openMarkers.put("s", { token: "4301-0123456789abcdef", pid: 4301, host: OLD_HOST });
					const before = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					assert.equal(await database.transaction((tx) => before.sharedHistoryForks(tx)), false);

					const operator = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					assert.deepEqual(await enable(operator), { status: "enabled", bypassed: [] });

					assert.equal(await database.transaction((tx) => before.sharedHistoryForks(tx)), true);
					await before.append("s", [user("e2", "e1", "after", 2)], { expectSeq: 1 });
					assert.equal((await before.load("s")).entries.length, 2);
					const reopened = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					assert.equal((await reopened.load("s")).entries.length, 2, "this release opens the store at 3");
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"two hosts turning them on at once: one does it, the other finds it done, and writers beside them commit",
			() =>
				withBackendScope(backend, async (scope) => {
					const writerDb = await scope.connect();
					const writer = await SqlSessionStore.open(writerDb, { prefix: scope.prefix });
					await writer.create(header("w"), [user("e1", null, "hello", 1)]);
					const hosts = await Promise.all(
						[0, 1].map(async () => SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix })),
					);

					const appends = (async () => {
						for (let seq = 1; seq <= 6; seq++)
							await writer.append("w", [user(`e${seq + 1}`, `e${seq}`, `more ${seq}`, seq + 1)], {
								expectSeq: seq,
							});
					})();
					const outcomes = await Promise.all(hosts.map((host) => enable(host)));
					await appends;

					assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["already", "enabled"]);
					assert.equal(await schemaVersion(writerDb, scope.prefix), 3);
					assert.equal((await writer.load("w")).entries.length, 7);
					if (dialectOf(writerDb).versionedMigrations) {
						const ledger = await writerDb.all(
							`SELECT version FROM ${storageMigrationTable(scope.prefix)} WHERE domain = 'sessions' ORDER BY version`,
						);
						assert.deepEqual(
							ledger.map((row) => Number(row.version)),
							[1, 2, 3],
							"one ledger row for version 3",
						);
					}
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
					await database.run(`UPDATE ${tables(scope.prefix).meta} SET schema_version = 2`);
					assert.equal((await store.load("src")).entries.length, 13, "nothing was written meanwhile");
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
