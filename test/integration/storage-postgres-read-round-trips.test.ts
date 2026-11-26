import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	FORK_VIEW_END,
	forkView,
	withForkViews,
} from "../../packages/coding-agent/src/core/storage/session/fork-view.js";
import {
	SESSION_SCHEMA_VERSION,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { sleep } from "../helpers/runtime.js";

/** Long enough for a local server to answer a read's commit, which the read itself does not wait for. */
const COMMIT_SETTLE_MS = 200;

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Counts the round trips to the server until the test ends. */
function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

/** Counts the connections opened to the server until the test ends. */
function countConnections() {
	const connect = pg.Client.prototype.connect;
	let opened = 0;
	pg.Client.prototype.connect = function (this: pg.Client, ...args: unknown[]) {
		opened += 1;
		return Reflect.apply(connect, this, args);
	} as pg.Client["connect"];
	restores.push(() => {
		pg.Client.prototype.connect = connect;
	});
	return {
		take() {
			const counted = opened;
			opened = 0;
			return counted;
		},
	};
}

interface PostgresRoute {
	readonly name: string;
	readonly skipReason: string | undefined;
	open(scope: PostgresScope): Promise<SqliteDatabase>;
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
		open: (scope) => scope.open(),
	},
	{
		name: "through PgBouncer in transaction mode",
		skipReason:
			postgresSkipReason ?? (pgbouncerUrl === undefined ? "ATOMIC_TEST_PGBOUNCER_URL is not set" : undefined),
		open: (scope) => {
			const url = new URL(pgbouncerUrl!);
			url.pathname = `/${scope.name}`;
			return openPostgresDatabase({
				url: url.href,
				...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
			});
		},
	},
];

const header = (id: string, parentSessionId?: string) => ({
	id,
	version: 4 as const,
	cwd: "/work",
	createdAt: "2026-11-25T00:00:00.000Z",
	...(parentSessionId === undefined ? {} : { parentSessionId }),
});
function message(id: string, parentId: string | null, content = `entry ${id}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content, timestamp: 1 },
	} as SessionEntry;
}
function thread(count: number, prefix = "m"): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= count; i++) entries.push(message(`${prefix}${i}`, i === 1 ? null : `${prefix}${i - 1}`));
	return entries;
}

async function clone(store: SqlSessionStore, parent: string, child: string) {
	const head = await store.readEntrySizes(parent, 1, 0);
	const created = await store.createFork(
		header(child, parent),
		completeSessionForkStream(parent, head.epoch, head.lastSeq),
		{ store, sessionId: parent, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.equal(created?.lastSeq, head.lastSeq);
	return created!;
}

/** Reference two-statement seqOfEntry query for differential verification on PostgreSQL. */
async function referenceTwoStatementSeqOfEntry(
	database: SqliteDatabase,
	sessionId: string,
	entryId: string,
	sharedHistory: boolean,
): Promise<number | undefined> {
	const index = snapshotIndexTables("");
	const source = await database.get<SqliteRow & { complete: number }>(
		`SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END AS complete FROM ${index.sources} WHERE source = 'session-entries'`,
	);
	const table = Number(source?.complete) === 1 ? index.sessionLinks : "session_entries";
	const view = forkView(
		{ segments: sharedHistory ? sessionForkTables().forkSegments : undefined, dialect: dialectOf(database) },
		{
			name: "linked",
			table,
			columns: ["entry_id"],
			sessionId,
			after: 0,
			through: FORK_VIEW_END,
			match: { column: "entry_id", value: entryId },
		},
	);
	const row = await database.get<SqliteRow & { seq: number | null }>(
		withForkViews([view], "SELECT (SELECT seq FROM linked ORDER BY seq DESC LIMIT 1) AS seq"),
		...view.params,
	);
	return row?.seq == null ? undefined : Number(row.seq);
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session read round trips (#6560)", () => {
	test("reads made one after another reuse the reader connection: a read's commit does not hold it, so none opens another", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				// The first read opens the reader's connection.
				await store.load("s1");
				const connections = countConnections();
				for (let read = 0; read < 4; read++) {
					assert.equal((await store.load("s1")).entries.length, 12);
					assert.equal((await store.readTail("s1", 10)).entries.length, 3);
				}
				// Each read went on as soon as its rows came; its connection waited one more round trip for the commit's answer,
				// so the next read found it busy and opened a connection of its own.
				assert.equal(connections.take(), 0);
			} finally {
				await store.close();
			}
		});
	});

	test("the tail and the resume of a session whose index is current cost no round trip before their transaction", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				await store.readResume("s1");
				await store.readTail("s1", 10);
				// Each read's commit goes out behind its reads, and its answer comes after the read returned: the reads are
				// counted apart, once the commit before them was answered.
				await sleep(COMMIT_SETTLE_MS);
				const trips = countRoundTrips();
				const tail = await store.readTail("s1", 10);
				await sleep(COMMIT_SETTLE_MS);
				const tailTrips = trips.take();
				const resume = await store.readResume("s1");
				await sleep(COMMIT_SETTLE_MS);
				const resumeTrips = trips.take();
				assert.deepEqual(
					tail.entries.map((entry) => entry.id),
					["m10", "m11", "m12"],
				);
				assert.equal(resume.leafId, "m12");
				// The start with the schema check and the session's row, then the entries the row's index names, then the commit
				// the read does not wait for. Five and six before: the row was read once before the transaction too, on its own,
				// and the tail's state, the resume's branch and its leaf each waited for the read before them.
				assert.equal(tailTrips, 3);
				assert.equal(resumeTrips, 3);
			} finally {
				await store.close();
			}
		});
	});

	test("a page of entries costs one round trip with the session's watermark, not two", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				const trips = countRoundTrips();
				const page = await store.readEntryRange("s1", { fromSeq: 3, toSeq: Number.POSITIVE_INFINITY });
				assert.equal(trips.take(), 1);
				assert.equal(page.lastSeq, 12);
				assert.equal(page.throughSeq, 12);
				assert.equal(page.entries.length, 10);
				const past = await store.readEntryRange("s1", { fromSeq: 20, toSeq: 30 });
				assert.deepEqual(past, { lastSeq: 12, entries: [], throughSeq: 19 });
				await assert.rejects(store.readEntryRange("missing", { fromSeq: 1, toSeq: 2 }), /missing/);
			} finally {
				await store.close();
			}
		});
	});
});

for (const route of postgresRoutes) {
	describe.skipIf(route.skipReason !== undefined)(
		`PostgreSQL session read round-trip pins (${route.name}) (#6710)`,
		() => {
			test("load, list, findMostRecent, findEntrySeq, readEntrySizes, and readForkWindow hit pinned round-trip counts (#6710)", async () => {
				await withPostgresDatabase(async (scope) => {
					const database = await route.open(scope);
					const store = await SqlSessionStore.open(database);
					try {
						await store.create(header("s1"), thread(12));
						const forked = await clone(store, "s1", "f1");
						await store.append("f1", [message("f_child", "m12")], {
							expectSeq: forked.lastSeq,
							epoch: forked.epoch,
						});
						// Warm the reader connection once before counting.
						await store.load("s1");
						await sleep(COMMIT_SETTLE_MS);

						const trips = countRoundTrips();

						// Item 1: load takes 1 awaited round trip (+ 1 background commit = 2 total, down from 3).
						const loadedPlain = await store.load("s1");
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 2, "load(plain): 1 awaited + 1 background commit");
						assert.equal(loadedPlain.entries.length, 12);

						const loadedFork = await store.load("f1");
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 2, "load(fork): 1 awaited + 1 background commit");
						assert.equal(loadedFork.entries.length, 13);

						// Item 3: list({ cwd }) 3 -> 2, list({}) 2 -> 1, list({ withoutSearchText }) 3 -> 2, findMostRecent 3 -> 2.
						const listedCwd = [];
						for await (const s of store.list({ cwd: "/work" })) listedCwd.push(s.id);
						await sleep(COMMIT_SETTLE_MS);
						const listCwdTrips = trips.take();
						assert.ok(listCwdTrips >= 1 && listCwdTrips <= 2, `list({ cwd }) cold: ${listCwdTrips}`);
						assert.deepEqual(listedCwd.sort(), ["f1", "s1"]);

						const listedCwdWarm = [];
						for await (const s of store.list({ cwd: "/work" })) listedCwdWarm.push(s.id);
						await sleep(COMMIT_SETTLE_MS);
						const listCwdWarmTrips = trips.take();
						assert.ok(listCwdWarmTrips >= 1 && listCwdWarmTrips <= 2, `list({ cwd }) warm: ${listCwdWarmTrips}`);
						assert.deepEqual(listedCwdWarm.sort(), ["f1", "s1"]);

						const listedAll = [];
						for await (const s of store.list({})) listedAll.push(s.id);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "list({}) without cwd");
						assert.deepEqual(listedAll.sort(), ["f1", "s1"]);

						const listedLight = [];
						for await (const s of store.list({ withoutSearchText: true })) listedLight.push(s.id);
						await sleep(COMMIT_SETTLE_MS);
						const listLightTrips = trips.take();
						assert.ok(
							listLightTrips >= 1 && listLightTrips <= 2,
							`list({ withoutSearchText: true }): ${listLightTrips}`,
						);
						assert.deepEqual(listedLight.sort(), ["f1", "s1"]);

						const recent = await store.findMostRecent({ cwd: "/work" });
						await sleep(COMMIT_SETTLE_MS);
						const recentTrips = trips.take();
						assert.ok(recentTrips >= 1 && recentTrips <= 2, `findMostRecent({ cwd }): ${recentTrips}`);
						assert.ok(recent !== undefined);

						// Item 2 + 3: findEntrySeq 3 -> 1 round trip (plain, forked, missing entry, missing session).
						assert.equal(await store.findEntrySeq("s1", "m7"), 7);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq(plain hit)");
						assert.equal(await store.findEntrySeq("f1", "m7"), 7);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq(fork inherited hit)");
						assert.equal(await store.findEntrySeq("f1", "f_child"), 13);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq(fork own hit)");
						assert.equal(await store.findEntrySeq("s1", "missing"), undefined);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq(missing entry)");
						await assert.rejects(store.findEntrySeq("no-such", "m1"), SessionNotFoundError);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq(missing session)");

						// Item 7: readEntrySizes 3 -> 2 awaited (+ 1 background commit = 3 total, down from 4).
						const sizes = await store.readEntrySizes("s1", 1, 12);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 3, "readEntrySizes: 2 awaited + 1 background commit");
						assert.equal(sizes.sizes.length, 12);

						// Item 7: readForkWindow 3 -> 2 awaited (+ 1 background commit = 3 total, down from 4); miss 2 -> 1 awaited.
						const win = await store.readForkWindow("s1", "m6");
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 3, "readForkWindow(hit): 2 awaited + 1 background commit");
						assert.deepEqual(
							win?.entries.map((e) => e.id),
							["m1", "m2", "m3", "m4", "m5", "m6"],
						);

						const winMiss = await store.readForkWindow("s1", "no-such-entry");
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 2, "readForkWindow(miss): 1 awaited + 1 background commit");
						assert.equal(winMiss, undefined);
					} finally {
						await store.close();
						await database.close();
					}
				});
			});

			test("schema error wins over missing session, empty table, and dropped tables on pipelined reads (#6710)", async () => {
				await withPostgresDatabase(async (scope) => {
					const database = await route.open(scope);
					const store = await SqlSessionStore.open(database);
					try {
						await store.create(header("s1"), thread(4));
						await database.run("UPDATE session_meta SET schema_version = ?", SESSION_SCHEMA_VERSION + 1);

						const checkAllRefuse = async (label: string) => {
							const ops: Record<string, () => Promise<unknown>> = {
								"list({})": async () => {
									for await (const _ of store.list({})) break;
								},
								"list({ cwd })": async () => {
									for await (const _ of store.list({ cwd: "/work" })) break;
								},
								"list({ withoutSearchText })": async () => {
									for await (const _ of store.list({ withoutSearchText: true })) break;
								},
								findMostRecent: () => store.findMostRecent({ cwd: "/work" }),
								"findEntrySeq(existing)": () => store.findEntrySeq("s1", "m2"),
								"findEntrySeq(missing)": () => store.findEntrySeq("missing", "m2"),
								load: () => store.load("s1"),
								readEntrySizes: () => store.readEntrySizes("s1", 1, 4),
								readForkWindow: () => store.readForkWindow("s1", "m2"),
							};
							for (const [name, op] of Object.entries(ops)) {
								await assert.rejects(op(), StorageSchemaVersionError, `${label}: ${name}`);
							}
						};

						await checkAllRefuse("populated");
						await database.exec("DELETE FROM session_sessions");
						await checkAllRefuse("empty sessions");
						await database.exec("DROP TABLE session_sessions CASCADE; DROP TABLE snapshot_index_sources");
						await checkAllRefuse("dropped tables");
					} finally {
						await store.close();
						await database.close();
					}
				});
			});

			test("wrong-guess fallbacks (cached-plain recreated as fork) return identical results in load, findEntrySeq, readEntrySizes, and readForkWindow (#6710)", async () => {
				await withPostgresDatabase(async (scope) => {
					const database = await route.open(scope);
					const peerDb = await scope.open();
					const store = await SqlSessionStore.open(database);
					const peer = await SqlSessionStore.open(peerDb);
					try {
						await store.create(header("parent"), thread(5, "p"));
						await store.create(header("target"), thread(2, "old"));
						// Warm forkedSessions cache with target -> false.
						assert.equal((await store.load("target")).entries.length, 2);
						assert.equal(await store.findEntrySeq("target", "old2"), 2);

						// Peer deletes "target" and recreates it under the same ID as a fork of "parent".
						await peer.delete("target");
						const forked = await clone(peer, "parent", "target");
						await peer.append("target", [message("child1", "p5")], {
							expectSeq: forked.lastSeq,
							epoch: forked.epoch,
						});

						// Stale cached-plain guess in findEntrySeq falls back in <= 2 round trips.
						await sleep(COMMIT_SETTLE_MS);
						const trips = countRoundTrips();
						assert.equal(await store.findEntrySeq("target", "p3"), 3);
						await sleep(COMMIT_SETTLE_MS);
						const retryTrips = trips.take();
						assert.ok(retryTrips >= 1 && retryTrips <= 2, `findEntrySeq wrong plain guess: ${retryTrips}`);
						// Subsequent call is back to 1 round trip.
						assert.equal(await store.findEntrySeq("target", "child1"), 6);
						await sleep(COMMIT_SETTLE_MS);
						assert.equal(trips.take(), 1, "findEntrySeq after cache update");

						// Re-seed another cached-plain session to test load, readEntrySizes, readForkWindow fallbacks.
						await store.create(header("target2"), thread(2, "t"));
						assert.equal((await store.load("target2")).entries.length, 2);
						await peer.delete("target2");
						const forked2 = await clone(peer, "parent", "target2");
						await peer.append("target2", [message("c2", "p5")], {
							expectSeq: forked2.lastSeq,
							epoch: forked2.epoch,
						});

						const loaded = await store.load("target2");
						assert.deepEqual(
							loaded.entries.map((e) => e.id),
							["p1", "p2", "p3", "p4", "p5", "c2"],
						);
						assert.equal((await store.readEntrySizes("target2", 1, 6)).sizes.length, 6);
						assert.deepEqual(
							(await store.readForkWindow("target2", "p3"))?.entries.map((e) => e.id),
							["p1", "p2", "p3"],
						);
					} finally {
						await peer.close();
						await store.close();
						await database.close();
					}
				});
			});
		},
	);
}

describe.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL seqOfEntry differential equivalence and plan (#6710)",
	() => {
		test("one-statement seqOfEntry matches two-statement reference on PostgreSQL across all index states and skips session_entries when complete (#6710)", async () => {
			await withPostgresDatabase(async ({ open }) => {
				const database = await open();
				const store = await SqlSessionStore.open(database);
				try {
					const pEntries = [
						message("p1", null),
						message("dup", "p1"),
						message("p3", "dup"),
						message("dup", "p3"),
						message("p5", "dup"),
					];
					await store.create(header("plain"), pEntries);
					const f1 = await clone(store, "plain", "fork1");
					await store.append("fork1", [message("f1a", "p5"), message("dup", "f1a")], {
						expectSeq: f1.lastSeq,
						epoch: f1.epoch,
					});
					const f2 = await clone(store, "fork1", "fork2");
					await store.append("fork2", [message("f2a", "dup")], {
						expectSeq: f2.lastSeq,
						epoch: f2.epoch,
					});

					await database.run("DELETE FROM snapshot_session_links WHERE session_id = 'plain' AND seq = 5");
					await database.run(
						"INSERT INTO snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) VALUES ('plain', 99, 'orphan_link', NULL, NULL, 0, 0)",
					);
					await database.run(
						"INSERT INTO snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken) VALUES ('fork1', 98, 'orphan_fork_link', NULL, NULL, 0, 0)",
					);

					const sessions = ["plain", "fork1", "fork2"];
					const entryIds = ["p1", "dup", "p3", "p5", "f1a", "f2a", "orphan_link", "orphan_fork_link", "missing"];
					const sourceStates: readonly { label: string; apply: () => Promise<void> }[] = [
						{
							label: "complete (backfilled = watermark)",
							apply: async () => {
								await database.run(
									"INSERT INTO snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries', 100, 100) ON CONFLICT(source) DO UPDATE SET watermark = 100, backfilled_through = 100",
								);
							},
						},
						{
							label: "complete (0 >= 0)",
							apply: async () => {
								await database.run(
									"UPDATE snapshot_index_sources SET watermark = 0, backfilled_through = 0 WHERE source = 'session-entries'",
								);
							},
						},
						{
							label: "complete (-1 >= -1)",
							apply: async () => {
								await database.run(
									"UPDATE snapshot_index_sources SET watermark = -1, backfilled_through = -1 WHERE source = 'session-entries'",
								);
							},
						},
						{
							label: "partial (backfilled < watermark)",
							apply: async () => {
								await database.run(
									"UPDATE snapshot_index_sources SET watermark = 100, backfilled_through = 42 WHERE source = 'session-entries'",
								);
							},
						},
						{
							label: "missing source row",
							apply: async () => {
								await database.run("DELETE FROM snapshot_index_sources WHERE source = 'session-entries'");
							},
						},
					];

					for (const state of sourceStates) {
						await state.apply();
						for (const sessionId of sessions) {
							for (const entryId of entryIds) {
								const expected = await referenceTwoStatementSeqOfEntry(database, sessionId, entryId, true);
								const actual = await store.findEntrySeq(sessionId, entryId);
								assert.equal(actual, expected, `${state.label}: session=${sessionId}, entry=${entryId}`);
							}
						}
					}

					// Confirm short-circuit plan on PostgreSQL: when complete, session_entries branch is never executed.
					await sourceStates[0]!.apply();
					const planRows = await database.all<SqliteRow & { "QUERY PLAN": string }>(
						`EXPLAIN (ANALYZE)
					WITH linked AS NOT MATERIALIZED (
						SELECT session_id, seq, entry_id, session_id AS src_id, seq AS src_seq
						FROM snapshot_session_links WHERE session_id = ? AND seq > CAST(? AS BIGINT) AND seq <= CAST(? AS BIGINT) AND entry_id = ?
					), entries AS NOT MATERIALIZED (
						SELECT session_id, seq, entry_id, session_id AS src_id, seq AS src_seq
						FROM session_entries WHERE session_id = ? AND seq > CAST(? AS BIGINT) AND seq <= CAST(? AS BIGINT) AND entry_id = ?
					)
					SELECT CASE WHEN EXISTS (SELECT 1 FROM snapshot_index_sources WHERE source = 'session-entries' AND backfilled_through >= watermark)
						THEN (SELECT seq FROM linked ORDER BY seq DESC LIMIT 1)
						ELSE (SELECT seq FROM entries ORDER BY seq DESC LIMIT 1)
					END AS seq`,
						"plain",
						0,
						FORK_VIEW_END,
						"p3",
						"plain",
						0,
						FORK_VIEW_END,
						"p3",
					);
					const plan = planRows.map((row) => row["QUERY PLAN"]).join("\n");
					assert.match(plan, /session_entries[^\n]*\(never executed\)/, plan);
				} finally {
					await store.close();
				}
			});
		});

		test("stale sharedHistorySeen=false recovers cleanly on PostgreSQL across load, list, findEntrySeq, readEntrySizes, and readForkWindow after peer switches to shared history (#6710)", async () => {
			await withPostgresDatabase(async ({ open }) => {
				const setupDb = await open();
				const marker = await holdOlderBuildMarker(setupDb);
				const peer = await SqlSessionStore.open(setupDb);
				const readerLoad = await SqlSessionStore.open(await open());
				const readerSeq = await SqlSessionStore.open(await open());
				const readerList = await SqlSessionStore.open(await open());
				const readerSizes = await SqlSessionStore.open(await open());
				const readerForkWin = await SqlSessionStore.open(await open());
				try {
					await peer.create(header("parent"), thread(5, "p"));
					await marker.release();
					assert.equal((await peer.enableSharedHistoryForks()).status, "enabled");
					const forked = await clone(peer, "parent", "child");
					await peer.append("child", [message("c1", "p5", "child-only-text")], {
						expectSeq: forked.lastSeq,
						epoch: forked.epoch,
					});

					// Each reader opened before the switch (sharedHistorySeen === false).
					const loaded = await readerLoad.load("child");
					assert.deepEqual(
						loaded.entries.map((e) => e.id),
						["p1", "p2", "p3", "p4", "p5", "c1"],
					);

					assert.equal(await readerSeq.findEntrySeq("child", "p3"), 3);
					assert.equal(await readerSeq.findEntrySeq("child", "c1"), 6);

					const listed = [];
					for await (const s of readerList.list({})) listed.push(s);
					const childSummary = listed.find((s) => s.id === "child");
					assert.ok(childSummary !== undefined);
					assert.match(childSummary.searchText, /entry p1/);
					assert.match(childSummary.searchText, /child-only-text/);

					const sizes = await readerSizes.readEntrySizes("child", 1, 6);
					assert.equal(sizes.sizes.length, 6);

					const win = await readerForkWin.readForkWindow("child", "p3");
					assert.deepEqual(
						win?.entries.map((e) => e.id),
						["p1", "p2", "p3"],
					);
				} finally {
					await Promise.all([
						peer.close(),
						readerLoad.close(),
						readerSeq.close(),
						readerList.close(),
						readerSizes.close(),
						readerForkWin.close(),
					]);
				}
			});
		});
	},
);
