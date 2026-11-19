import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	BackgroundCollectionPace,
	SNAPSHOT_INDEX_BACKFILL_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { createSession, messageEntry, syntheticSnapshot } from "../helpers/snapshot-reference-index.js";

/** The snapshot blob store of Atomic 0.9.87, vendored unmodified (test/fixtures/snapshot-store-0.9.87/README.md). */
interface Release0987BlobStore {
	completeIndex(): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0987 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.87/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<Release0987BlobStore> } };

/**
 * The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89/README.md): a
 * released build that indexes degraded pins and keeps no progress row of its own backfill.
 */
interface Release0989BlobStore {
	completeIndex(options?: { readonly signal?: AbortSignal }): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<Release0989BlobStore> } };

/**
 * The session-entries triggers and progress rows 0.9.87 leaves when it installs its reference index over a session
 * table that has none, recorded from the vendored store above (the first test checks it still writes exactly these).
 */
const GOLDEN = JSON.parse(
	readFileSync(join(import.meta.dirname, "../fixtures/snapshot-index-0.9.87-session-triggers.json"), "utf8"),
) as {
	readonly triggers: readonly { readonly name: string; readonly sql: string }[];
	readonly progress: readonly {
		readonly source: string;
		readonly watermark: number;
		readonly backfilled_through: number;
	}[];
};

const SESSION_TRIGGERS = [
	"session_entries_snapshot_links",
	"session_entries_snapshot_refs",
	"session_entries_snapshot_pending",
	"session_entries_snapshot_refs_delete",
] as const;

let directory: string;
const databases: SqliteDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-older-build-"));
});
afterEach(async () => {
	while (databases.length > 0) await databases.pop()!.close();
	rmSync(directory, { recursive: true, force: true });
});

async function open(): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	databases.push(database);
	return database;
}

/** The session-entries triggers a database holds, with their SQL, by name. */
async function sessionTriggers(database: SqliteDatabase) {
	return database.all<SqliteRow & { name: string; sql: string }>(
		"SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'session_entries' AND name LIKE 'session\\_entries\\_snapshot\\_%' ESCAPE '\\' ORDER BY name",
	);
}

/**
 * A partly restored worktree (#4922) appended to `session` after its entry `parentId`: `S-lacked`, whose bundle the
 * worktree lacks, then `S-derived`, which names it in `degradedFrom`. Only the pin keeps the bundle, so a collection
 * that deletes it lost the pin. Resolves with the bundle's hash and bytes.
 */
async function appendDegradedRestore(sessions: SqlSessionStore, session: string, parentId: string, expectSeq: number) {
	const bundle = new TextEncoder().encode("bundle bytes of S-lacked");
	const hash = createHash("sha256").update(bundle).digest("hex");
	await sessions.snapshotBlobs.putBlobs([{ hash, data: bundle }]);
	const lacked = {
		type: "worktree_snapshot",
		id: "e-lacked",
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		root: "/w",
		snapshotId: "S-lacked",
		snapshot: syntheticSnapshot("S-lacked", [], { bundle: hash, root: "/w" }),
	} as SessionEntry;
	const derived = {
		type: "worktree_snapshot",
		id: "e-derived",
		parentId: lacked.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		root: "/w",
		snapshotId: "S-derived",
		degradedFrom: "S-lacked",
	} as SessionEntry;
	await sessions.append(session, [lacked, derived], { expectSeq });
	return { hash, bundle };
}

/** `count` message entries, each the child of the one before. */
function chain(prefix: string, count: number): SessionEntry[] {
	const entries: SessionEntry[] = [messageEntry(`${prefix} 0`) as SessionEntry];
	for (let index = 1; index < count; index++)
		entries.push({ ...messageEntry(`${prefix} ${index}`), parentId: entries.at(-1)!.id } as SessionEntry);
	return entries;
}

/** Leaves the session entries without any reference index, as before a build installs one over them. */
async function dropSessionIndex(database: SqliteDatabase): Promise<void> {
	for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER IF EXISTS ${name}`);
	await database.exec(
		"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records; DELETE FROM snapshot_index_sources WHERE source LIKE 'session-entries%'",
	);
}

/** Runs this build's collection of the index until its first batch is done, then stops it, as when Atomic exits. */
async function stopAfterFirstBatch(store: SqlSnapshotBlobStore): Promise<void> {
	const controller = new AbortController();
	class StoppingPace extends BackgroundCollectionPace {
		override wait(milliseconds: number): Promise<void> {
			controller.abort(new Error("Atomic exits"));
			return super.wait(milliseconds);
		}
	}
	await assert.rejects(store.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }));
}

/** The progress of the session entries' backfill. */
async function entriesProgress(database: SqliteDatabase) {
	const row = await database.get<SqliteRow & { watermark: number; backfilled_through: number }>(
		"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
	);
	return { watermark: Number(row?.watermark), backfilled: Number(row?.backfilled_through) };
}

/** `database`, counting its write transactions. */
function countingTransactions(database: SqliteDatabase) {
	const counted = { transactions: 0 };
	const wrapped: SqliteDatabase = {
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		descriptor: database.descriptor,
		close: () => database.close(),
		transaction: (callback, options) => {
			counted.transactions++;
			return database.transaction(callback, options);
		},
	};
	return { wrapped, counted };
}

/** How the index records the entry that names the snapshot it lacks: its pin, or null when the pin was not indexed. */
async function indexedPin(database: SqliteDatabase): Promise<string | null | undefined> {
	const row = await database.get<SqliteRow & { degraded_from: string | null }>(
		"SELECT degraded_from FROM snapshot_session_refs WHERE snapshot_id = 'S-derived'",
	);
	return row === undefined ? undefined : row.degraded_from;
}

describe("an older build working on this build's session index (#5558)", () => {
	test("the recorded 0.9.87 triggers and progress rows are what the vendored 0.9.87 store installs (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "s1", [messageEntry("hi") as SessionEntry]);
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.run("DELETE FROM snapshot_index_sources WHERE source LIKE 'session-entries%'");

		await release0987.SqlSnapshotBlobStore.open(database);

		assert.deepEqual(
			(await sessionTriggers(database)).map(({ name, sql }) => ({ name, sql })),
			GOLDEN.triggers,
		);
		assert.deepEqual(
			(
				await database.all<SqliteRow & { source: string; watermark: number; backfilled_through: number }>(
					"SELECT source, watermark, backfilled_through FROM snapshot_index_sources WHERE source LIKE 'session-entries%' ORDER BY source",
				)
			).map((row) => ({ ...row })),
			GOLDEN.progress,
		);
	});

	test("triggers an older build installed after this build's went missing are not trusted, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		// The session entries table loses this build's triggers; this build's progress rows stay.
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		// 0.9.87 opens the store first: it installs its own triggers under the same names and indexes the entries.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.deepEqual(
			(await sessionTriggers(database)).map(({ name, sql }) => ({ name, sql })),
			GOLDEN.triggers,
			"0.9.87's triggers are installed",
		);

		// This build opens the store and records a partly restored worktree.
		const sessions = await SqlSessionStore.open(database);
		const { hash, bundle } = await appendDegradedRestore(sessions, "s1", first.id, 1);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "the pin is indexed");
		const refs = (await sessionTriggers(database)).find(({ name }) => name === "session_entries_snapshot_refs");
		assert.notEqual(
			refs?.sql,
			GOLDEN.triggers.find(({ name }) => name === "session_entries_snapshot_refs")?.sql,
			"this build's reference trigger replaced 0.9.87's",
		);
	});

	test("an older build that finishes this build's interrupted backfill does not leave its entries indexed its way, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash, bundle } = await appendDegradedRestore(created, "s1", first.id, 1);
		// The index is rebuilt: this build installs its triggers over the entries, and its collection stops before
		// it indexes them (Atomic exits).
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.exec(
			"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records",
		);
		await SqlSnapshotBlobStore.open(database);
		const pending = await database.get<SqliteRow & { watermark: number; backfilled_through: number }>(
			"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
		);
		assert.ok(Number(pending?.backfilled_through) < Number(pending?.watermark), "the backfill is pending");
		// 0.9.87 collects next: it takes the triggers for its own and indexes the entries with its statements.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const sessions = await SqlSessionStore.open(database);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "this build indexed the entry again");
	});

	test("an older build that indexes entries written at reused rowids during this build's backfill does not leave them indexed its way (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const chain = (prefix: string, count: number) => {
			const entries: SessionEntry[] = [messageEntry(`${prefix} 0`) as SessionEntry];
			for (let index = 1; index < count; index++)
				entries.push({ ...messageEntry(`${prefix} ${index}`), parentId: entries.at(-1)!.id } as SessionEntry);
			return entries;
		};
		await createSession(created, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH - 11));
		await createSession(created, "newest", chain("newest", 120));
		// The index is rebuilt, and this build's backfill stops after its first batch.
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.exec(
			"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records",
		);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		const controller = new AbortController();
		class StoppingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				controller.abort(new Error("Atomic exits"));
				return super.wait(milliseconds);
			}
		}
		await assert.rejects(
			upgraded.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
		);
		// The newest session is deleted and a new one takes its rowids, some of them below where the backfill got.
		await created.delete("newest");
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash, bundle } = await appendDegradedRestore(created, "pinned", start.id, 1);
		const reused = await database.get<SqliteRow & { id: number }>(
			"SELECT max(rowid) AS id FROM session_entries WHERE session_id = 'pinned'",
		);
		assert.ok(
			Number(reused?.id) <= SNAPSHOT_INDEX_BACKFILL_BATCH,
			"the new entries reuse rowids the backfill passed",
		);
		// 0.9.87 collects next and indexes them its way.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});

	test("a store 0.9.89 indexed is trusted without indexing it again (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash } = await appendDegradedRestore(created, "s1", first.id, 1);
		await dropSessionIndex(database);
		await (await release0989.SqlSnapshotBlobStore.open(database)).completeIndex();
		const before = await database.all("SELECT * FROM snapshot_session_links ORDER BY session_id, seq");
		const { wrapped, counted } = countingTransactions(database);
		const store = await SqlSnapshotBlobStore.open(wrapped);

		await store.completeIndex();

		assert.equal(counted.transactions, 0, "the index needed no work");
		assert.deepEqual(await database.all("SELECT * FROM snapshot_session_links ORDER BY session_id, seq"), before);
		assert.equal((await store.collectGarbage({ graceSeconds: 0 })).includes(hash), false);
	});
});

describe("0.9.87 and a released build that indexes degraded pins on one store (#5558)", () => {
	test("entries written at reused rowids after this build took over 0.9.89's backfill keep their pin when 0.9.87 indexes them (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH - 11));
		await createSession(created, "newest", chain("newest", 120));
		// 0.9.89 installs the index over the entries; this build's collection takes its backfill over and stops.
		await dropSessionIndex(database);
		await release0989.SqlSnapshotBlobStore.open(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		await stopAfterFirstBatch(upgraded);
		// The newest session is deleted and a new one takes its rowids, some of them below where the backfill got.
		await created.delete("newest");
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash, bundle } = await appendDegradedRestore(created, "pinned", start.id, 1);
		const reused = await database.get<SqliteRow & { id: number }>(
			"SELECT max(rowid) AS id FROM session_entries WHERE session_id = 'pinned'",
		);
		assert.ok(
			Number(reused?.id) <= SNAPSHOT_INDEX_BACKFILL_BATCH,
			"the new entries reuse rowids the backfill passed",
		);
		// 0.9.87 collects next and indexes them its way.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});

	test("this build finishes 0.9.89's interrupted backfill by indexing the entries again, without removing the index (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "older", chain("older", 2 * SNAPSHOT_INDEX_BACKFILL_BATCH + 20));
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash } = await appendDegradedRestore(created, "pinned", start.id, 1);
		await dropSessionIndex(database);
		await release0989.SqlSnapshotBlobStore.open(database);
		const links = async () =>
			Number((await database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM snapshot_session_links"))?.n);
		const removed: number[] = [];
		const watched: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: async (callback, options) => {
				const before = await links();
				const result = await database.transaction(callback, options);
				removed.push(before - (await links()));
				return result;
			},
		};
		const upgraded = await SqlSnapshotBlobStore.open(watched);

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.deepEqual(
			removed.filter((rows) => rows > 0),
			[],
			"no transaction removed index rows",
		);
		assert.equal(deleted.includes(hash), false);
		assert.equal(await indexedPin(database), "S-lacked");
		const entries = Number(
			(await database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM session_entries"))?.n,
		);
		assert.equal(await links(), entries, "every entry is indexed");
	});

	test("0.9.89 collecting after 0.9.87 finished this build's interrupted backfill keeps the bundle a pin keeps (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash, bundle } = await appendDegradedRestore(created, "s1", first.id, 1);
		// This build installs its index over the entries, and Atomic exits before its backfill runs.
		await dropSessionIndex(database);
		await SqlSnapshotBlobStore.open(database);
		// 0.9.87 collects next and indexes the entries its way.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await (await release0989.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "0.9.89 collected the bundle the pin keeps");
		assert.equal(await indexedPin(database), "S-lacked", "0.9.89 indexed the entries again");
		const sessions = await SqlSessionStore.open(database);
		assert.equal((await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 })).includes(hash), false);
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
	});

	test("0.9.89 collecting while this build indexes again what 0.9.87 indexed keeps the bundle a pin keeps (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH + 20));
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash, bundle } = await appendDegradedRestore(created, "pinned", start.id, 1);
		// This build installs its index over the entries and exits; 0.9.87 indexes them all its way.
		await dropSessionIndex(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		// This build indexes the first entries again, past which the pin lies, and exits.
		await stopAfterFirstBatch(upgraded);
		assert.equal(await indexedPin(database), null, "the pin is not indexed again yet");

		const deleted = await (await release0989.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "0.9.89 collected the bundle the pin keeps");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
	});

	test("entries 0.9.87 indexed during 0.9.89's interrupted backfill are indexed again by this build (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash, bundle } = await appendDegradedRestore(created, "pinned", start.id, 1);
		await createSession(created, "newer", chain("newer", SNAPSHOT_INDEX_BACKFILL_BATCH + 20));
		// 0.9.89 installs the index over the entries and exits; 0.9.87 indexes the first of them its way and exits.
		await dropSessionIndex(database);
		await release0989.SqlSnapshotBlobStore.open(database);
		const controller = new AbortController();
		const stopping: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: async (callback, options) => {
				const result = await database.transaction(callback, options);
				if ((await entriesProgress(database)).backfilled > 0) controller.abort(new Error("Atomic 0.9.87 exits"));
				return result;
			},
		};
		await assert.rejects(
			(await release0987.SqlSnapshotBlobStore.open(stopping)).collectGarbage({
				graceSeconds: 1_000_000,
				signal: controller.signal,
			} as { graceSeconds: number }),
		);
		const progress = await entriesProgress(database);
		assert.ok(progress.backfilled > 0 && progress.backfilled < progress.watermark, "0.9.87 indexed part of it");
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const sessions = await SqlSessionStore.open(database);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});

	test("after 0.9.89 indexed again a store this build was indexing, this build trusts it without indexing it again (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH + 20));
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash } = await appendDegradedRestore(created, "pinned", start.id, 1);
		// This build installs its index over the entries, indexes a batch of them and exits.
		await dropSessionIndex(database);
		await stopAfterFirstBatch(await SqlSnapshotBlobStore.open(database));
		// 0.9.89 collects next: it indexes the store its way, which writes degraded pins too.
		await (await release0989.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), "S-lacked", "0.9.89 indexed the pin");
		const { wrapped, counted } = countingTransactions(database);
		const store = await SqlSnapshotBlobStore.open(wrapped);

		await store.completeIndex();

		assert.equal(counted.transactions, 0, "this build trusts the index 0.9.89 built");
		assert.equal((await store.collectGarbage({ graceSeconds: 0 })).includes(hash), false);
	});

	test("a reference trigger 0.9.87 installed again after 0.9.89's went missing is not trusted, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash, bundle } = await appendDegradedRestore(created, "s1", first.id, 1);
		// 0.9.89 indexes the store; then its reference trigger goes missing and 0.9.87 collects first: it installs that
		// trigger again under 0.9.89's version row and indexes every entry its way.
		await dropSessionIndex(database);
		await (await release0989.SqlSnapshotBlobStore.open(database)).completeIndex();
		await database.exec("DROP TRIGGER session_entries_snapshot_refs");
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const sessions = await SqlSessionStore.open(database);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "this build indexed the pin again");
	});

	test("an index 0.9.89 installed while a rebuild mark of a build with the batched teardown was there is not trusted, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash, bundle } = await appendDegradedRestore(created, "s1", first.id, 1);
		// A build that removes an old index in batches marked it, with no progress row left; 0.9.89 opened the store
		// meanwhile and installed its own index, and 0.9.87 indexed it its way.
		await dropSessionIndex(database);
		await database.run(
			"INSERT INTO snapshot_index_sources (source, watermark, backfilled_through) VALUES ('session-entries@rebuild', -1, -1)",
		);
		await release0989.SqlSnapshotBlobStore.open(database);
		await (await release0987.SqlSnapshotBlobStore.open(database)).completeIndex();
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const sessions = await SqlSessionStore.open(database);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "this build indexed the pin again");
		assert.equal(
			await database.get("SELECT 1 AS found FROM snapshot_index_sources WHERE source = 'session-entries@rebuild'"),
			undefined,
			"the mark is gone",
		);
	});
});

/** The session triggers whose SQL 0.9.87 and 0.9.89 write alike: losing one leaves the reference trigger in place. */
const SHARED_TRIGGERS = ["session_entries_snapshot_links", "session_entries_snapshot_refs_delete"] as const;

const drivers = {
	"node:sqlite": open,
	libSQL: async () => {
		const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "store.sqlite")).href });
		databases.push(database);
		return database;
	},
};

/**
 * A session whose first entries hold a degraded pin, followed by more entries than one backfill batch indexes: this
 * build's first batch indexes the pin. Resolves with the bundle only the pin keeps.
 */
async function pinnedThenMore(database: SqliteDatabase) {
	const created = await SqlSessionStore.open(database);
	const start = messageEntry("pinned start") as SessionEntry;
	await createSession(created, "pinned", [start]);
	const pinned = await appendDegradedRestore(created, "pinned", start.id, 1);
	await createSession(created, "newer", chain("newer", SNAPSHOT_INDEX_BACKFILL_BATCH + 20));
	return pinned;
}

describe("0.9.87 installing again one session trigger that every build writes alike (#5558)", () => {
	for (const [driver, openWith] of Object.entries(drivers)) {
		for (const lost of SHARED_TRIGGERS) {
			test(`on ${driver}, 0.9.87 installing ${lost} again during this build's backfill does not leave the entries this build indexed indexed its way (#5558)`, async () => {
				const database = await openWith();
				const { hash, bundle } = await pinnedThenMore(database);
				// This build installs its index over the entries, indexes a first batch, which holds the pin, and exits.
				await dropSessionIndex(database);
				const upgraded = await SqlSnapshotBlobStore.open(database);
				await stopAfterFirstBatch(upgraded);
				assert.equal(await indexedPin(database), "S-lacked", "this build indexed the pin");
				// The table loses that one trigger. 0.9.87 opens first: it empties the index, installs the trigger again, keeps
				// this build's other triggers, and indexes every entry its way.
				await database.exec(`DROP TRIGGER ${lost}`);
				await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
				assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

				const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

				assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
				assert.deepEqual(await upgraded.getBlob(hash), bundle);
				assert.equal(await indexedPin(database), "S-lacked", "this build indexed the pin again");
			});
		}
	}

	test("0.9.87 installing a lost trigger again and indexing part of the entries during this build's backfill does not leave them indexed its way (#5558)", async () => {
		const database = await open();
		const { hash, bundle } = await pinnedThenMore(database);
		await dropSessionIndex(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		await stopAfterFirstBatch(upgraded);
		await database.exec("DROP TRIGGER session_entries_snapshot_links");
		// 0.9.87 installs the trigger again, indexes its first batch, which holds the pin, and exits.
		const controller = new AbortController();
		const stopping: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: async (callback, options) => {
				const result = await database.transaction(callback, options);
				if ((await entriesProgress(database)).backfilled > 0) controller.abort(new Error("Atomic 0.9.87 exits"));
				return result;
			},
		};
		await assert.rejects(
			(await release0987.SqlSnapshotBlobStore.open(stopping)).collectGarbage({
				graceSeconds: 1_000_000,
				signal: controller.signal,
			} as { graceSeconds: number }),
		);
		const progress = await entriesProgress(database);
		assert.ok(progress.backfilled > 0 && progress.backfilled < progress.watermark, "0.9.87 indexed part of it");
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});

	test("0.9.87 installing a lost trigger again over this build's finished index and indexing it its way does not leave it trusted (#5558)", async () => {
		const database = await open();
		const { hash, bundle } = await pinnedThenMore(database);
		await dropSessionIndex(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		await upgraded.completeIndex();
		assert.equal(await indexedPin(database), "S-lacked", "this build indexed the pin");
		// No entry is written after the index is finished. The table loses one trigger, and 0.9.87 installs it again
		// and indexes every entry its way.
		await database.exec("DROP TRIGGER session_entries_snapshot_refs_delete");
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});
});
