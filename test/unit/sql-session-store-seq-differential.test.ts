import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
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
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { makeTempDirectory } from "../helpers/runtime.js";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const header = (id: string, parentSessionId?: string) => ({
	id,
	version: 4 as const,
	cwd: "/work",
	createdAt: "2026-11-26T00:00:00.000Z",
	...(parentSessionId === undefined ? {} : { parentSessionId }),
});

function message(id: string, parentId: string | null, content = `body ${id}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-26T00:00:01.000Z",
		message: { role: "user", content, timestamp: 1 },
	} as SessionEntry;
}

function thread(prefix: string, count: number, firstParent: string | null = null): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let i = 1; i <= count; i++) {
		out.push(message(`${prefix}${i}`, i === 1 ? firstParent : `${prefix}${i - 1}`));
	}
	return out;
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

/** Reference two-statement seqOfEntry implementation for differential verification. */
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

async function withTempSqlite<T>(body: (database: SqliteDatabase) => Promise<T>): Promise<T> {
	const dir = makeTempDirectory("atomic-6710-seq-diff-");
	tempDirs.push(dir);
	const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
	try {
		return await body(database);
	} finally {
		await database.close();
	}
}

describe("SqlSessionStore seqOfEntry differential equivalence and schema-error precedence on SQLite (#6710)", () => {
	test("one-statement seqOfEntry matches the two-statement reference across missing, partial, complete, orphaned, duplicate, plain, and multi-hop forked states (#6710)", async () => {
		await withTempSqlite(async (database) => {
			const store = await SqlSessionStore.open(database);
			try {
				// Seed plain session, 1-hop fork, and 2-hop fork (shared history enabled by default on new stores).
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

				// Inject an entry orphaned only in session_entries (missing from snapshot_session_links),
				// and an entry orphaned only in snapshot_session_links (missing from session_entries).
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
						label: "complete (backfilled > watermark)",
						apply: async () => {
							await database.run(
								"UPDATE snapshot_index_sources SET watermark = 50, backfilled_through = 75 WHERE source = 'session-entries'",
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
						label: "partial (backfilled = 0 < watermark = 1)",
						apply: async () => {
							await database.run(
								"UPDATE snapshot_index_sources SET watermark = 1, backfilled_through = 0 WHERE source = 'session-entries'",
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

				// Confirm orphaned entries actually diverged between partial and complete states (non-trivial test!).
				await sourceStates[0]!.apply();
				assert.equal(await store.findEntrySeq("plain", "p5"), undefined);
				assert.equal(await store.findEntrySeq("plain", "orphan_link"), 99);
				await sourceStates[4]!.apply();
				assert.equal(await store.findEntrySeq("plain", "p5"), 5);
				assert.equal(await store.findEntrySeq("plain", "orphan_link"), undefined);
				await sourceStates[6]!.apply();
				assert.equal(await store.findEntrySeq("plain", "p5"), 5);
				assert.equal(await store.findEntrySeq("plain", "orphan_link"), undefined);

				// Missing session still rejects with SessionNotFoundError.
				await assert.rejects(store.findEntrySeq("no-such-session", "p1"), SessionNotFoundError);
			} finally {
				await store.close();
			}
		});
	});

	test("schema error wins over missing session, empty table, and dropped tables on list, findMostRecent, findEntrySeq, load, readEntrySizes, and readForkWindow (#6710)", async () => {
		await withTempSqlite(async (database) => {
			const store = await SqlSessionStore.open(database);
			try {
				await store.create(header("s1"), thread("m", 4));
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
						"list({ cwd, withoutSearchText })": async () => {
							for await (const _ of store.list({ cwd: "/work", withoutSearchText: true })) break;
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
				await database.exec("DROP TABLE session_sessions; DROP TABLE snapshot_index_sources");
				await checkAllRefuse("dropped tables");
			} finally {
				await store.close();
			}
		});
	});

	test("cached-plain session recreated as a fork falls back cleanly in load, findEntrySeq, readEntrySizes, and readForkWindow (#6710)", async () => {
		await withTempSqlite(async (database) => {
			const store = await SqlSessionStore.open(database);
			try {
				await store.create(header("parent"), thread("p", 5));
				await store.create(header("target"), thread("old", 2));
				// Warm forkedSessions cache with target -> false.
				assert.equal((await store.load("target")).entries.length, 2);
				assert.equal(await store.findEntrySeq("target", "old2"), 2);

				// Another store deletes "target" and recreates it under the same ID as a fork of "parent".
				const peer = await SqlSessionStore.open(database);
				try {
					await peer.delete("target");
					const forked = await clone(peer, "parent", "target");
					await peer.append("target", [message("child1", "p5")], {
						expectSeq: forked.lastSeq,
						epoch: forked.epoch,
					});
				} finally {
					await peer.close();
				}

				// Stale cached-plain guess must detect forked=1 and return the full inherited + own history.
				const loaded = await store.load("target");
				assert.deepEqual(
					loaded.entries.map((e) => e.id),
					["p1", "p2", "p3", "p4", "p5", "child1"],
				);
				assert.equal(await store.findEntrySeq("target", "p3"), 3);
				assert.equal(await store.findEntrySeq("target", "child1"), 6);
				const sizes = await store.readEntrySizes("target", 1, 6);
				assert.equal(sizes.sizes.length, 6);
				const win = await store.readForkWindow("target", "p3");
				assert.ok(win !== undefined);
				assert.deepEqual(
					win.entries.map((e) => e.id),
					["p1", "p2", "p3"],
				);
			} finally {
				await store.close();
			}
		});
	});

	test("stale sharedHistorySeen=false recovers cleanly across load, list, findEntrySeq, readEntrySizes, and readForkWindow after peer switches to shared history (#6710)", async () => {
		await withTempSqlite(async (database) => {
			const marker = await holdOlderBuildMarker(database);
			const peer = await SqlSessionStore.open(database);
			const readerLoad = await SqlSessionStore.open(database);
			const readerSeq = await SqlSessionStore.open(database);
			const readerList = await SqlSessionStore.open(database);
			const readerSizes = await SqlSessionStore.open(database);
			const readerForkWin = await SqlSessionStore.open(database);
			try {
				await peer.create(header("parent"), thread("p", 5));
				await marker.release();
				assert.equal((await peer.enableSharedHistoryForks()).status, "enabled");
				const forked = await clone(peer, "parent", "child");
				await peer.append("child", [message("c1", "p5", "child-only-text")], {
					expectSeq: forked.lastSeq,
					epoch: forked.epoch,
				});

				// Each reader still has sharedHistorySeen === false before its first read!
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
				assert.match(childSummary.searchText, /body p1/);
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
});
