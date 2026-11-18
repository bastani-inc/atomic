import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_INDEX_TEARDOWN_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { createSession, messageEntry, syntheticSnapshot } from "../helpers/snapshot-reference-index.js";

/** The snapshot blob store of Atomic 0.9.87, vendored unmodified (test/fixtures/snapshot-store-0.9.87/README.md). */
interface Release0987BlobStore {
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	putBlobs(blobs: readonly { readonly hash: string; readonly data: Uint8Array }[]): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0987 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.87/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<Release0987BlobStore> } };

/**
 * What 0.9.87 does when it reads a snapshot blob through its run journal: its `SqlRunJournal.open` creates the journal's
 * meta table at schema version 1 when it is missing, refuses one whose row is not version 1 with
 * `JournalSchemaVersionError`, and otherwise reads the blob with the store above, which returns a row's `data` as it is.
 * With `store`, it first stores those bytes itself, as a run whose worktree holds the same content does.
 */
async function readAsRelease0987(
	database: SqliteDatabase,
	hash: string,
	store?: Uint8Array,
): Promise<{ readonly refused: unknown } | { readonly blob: Uint8Array | undefined }> {
	await database.exec("CREATE TABLE IF NOT EXISTS wf_meta(schema_version INTEGER NOT NULL)");
	if ((await database.all("SELECT schema_version FROM wf_meta")).length === 0)
		await database.run("INSERT INTO wf_meta VALUES (1)");
	const versions = await database.all<SqliteRow & { schema_version: unknown }>("SELECT schema_version FROM wf_meta");
	if (versions.length !== 1 || versions[0]!.schema_version !== 1) return { refused: versions[0]?.schema_version };
	const blobs = await release0987.SqlSnapshotBlobStore.open(database);
	if (store !== undefined) await blobs.putBlobs([{ hash, data: store }]);
	return { blob: await blobs.getBlob(hash) };
}

let directory: string;
const databases: SqliteDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-store-older-build-"));
});
afterEach(async () => {
	while (databases.length > 0) await databases.pop()!.close();
	rmSync(directory, { recursive: true, force: true });
});

async function open(name = "store.sqlite"): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, name));
	databases.push(database);
	return database;
}

/** A blob over one chunk, so this build stores it as chunk rows behind a header row with empty data. */
function largeBlob(): { readonly hash: string; readonly data: Uint8Array } {
	const data = new Uint8Array(2_500_000).map((_, index) => (index * 31) & 255);
	return { hash: createHash("sha256").update(data).digest("hex"), data };
}

describe("an older build on a snapshot store this build wrote (#5065)", () => {
	test("an older build refuses a new journal holding a chunked blob, never reading it as empty (#5065)", async () => {
		const database = await open();
		const journal = await SqlRunJournal.open(database);
		const blob = largeBlob();
		await journal.snapshotBlobs.putBlobs([blob]);

		const read = await readAsRelease0987(database, blob.hash);

		assert.ok(
			"refused" in read,
			`0.9.87 read the chunked blob as ${(read as { blob?: Uint8Array }).blob?.byteLength} bytes`,
		);
		assert.deepEqual(await journal.snapshotBlobs.getBlob(blob.hash), blob.data);
		await journal.close();
	});

	test("an older build refuses a database where this build stored a chunked blob through its sessions only (#5065)", async () => {
		const database = await open();
		// Shared or team storage before any workflow run: this build has opened the session store and no journal.
		const sessions = await SqlSessionStore.open(database);
		const blob = largeBlob();
		await sessions.snapshotBlobs.putBlobs([blob]);

		// 0.9.87 would create the journal at version 1, store the same bytes (kept as this build's chunked header) and
		// read them back empty.
		const read = await readAsRelease0987(database, blob.hash, blob.data);

		assert.ok(
			"refused" in read,
			`0.9.87 read the chunked blob as ${(read as { blob?: Uint8Array }).blob?.byteLength} bytes`,
		);
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(blob.hash), blob.data);
		// This build's journal opens the database it marked, and reads the blob whole.
		const journal = await SqlRunJournal.open(database);
		assert.deepEqual(await journal.snapshotBlobs.getBlob(blob.hash), blob.data);
		await journal.close();
	});

	test("a chunked blob stored through the sessions upgrades a journal an older build created (#5065)", async () => {
		const database = await open();
		// An older build created the journal first: its tables, at schema version 1.
		await (await SqlRunJournal.open(database)).close();
		await database.run("UPDATE wf_meta SET schema_version = 1");
		await database.exec("DROP TABLE wf_event_chunks");
		// This build then opens only the session store and stores a chunked blob.
		const sessions = await SqlSessionStore.open(database);
		const blob = largeBlob();
		await sessions.snapshotBlobs.putBlobs([blob]);

		const read = await readAsRelease0987(database, blob.hash);

		assert.ok(
			"refused" in read,
			`0.9.87 read the chunked blob as ${(read as { blob?: Uint8Array }).blob?.byteLength} bytes`,
		);
		// The journal's own upgrade ran, so its version 2 tables are there too.
		assert.ok(await database.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'wf_event_chunks'"));
		const journal = await SqlRunJournal.open(database);
		assert.deepEqual(await journal.snapshotBlobs.getBlob(blob.hash), blob.data);
		await journal.close();
	});

	test("opening an older build's journal upgrades it, so that build then refuses it (#5065)", async () => {
		const database = await open();
		await (await SqlRunJournal.open(database)).close();
		// The journal as 0.9.87 leaves it: the same tables, at schema version 1.
		await database.run("UPDATE wf_meta SET schema_version = 1");

		const journal = await SqlRunJournal.open(database);
		const blob = largeBlob();
		await journal.snapshotBlobs.putBlobs([blob]);

		assert.ok("refused" in (await readAsRelease0987(database, blob.hash)));
		assert.deepEqual(await journal.snapshotBlobs.getBlob(blob.hash), blob.data);
		await journal.close();
	});

	test("an older build refuses a database where collection moved a legacy blob to chunks, never reading it as empty (#5327)", async () => {
		const database = await open();
		await SqlSessionStore.open(database);
		await database.exec(`DROP INDEX snapshot_blobs_age; DROP TABLE snapshot_blobs;
			CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT`);
		const data = new Uint8Array(SNAPSHOT_BLOB_CHUNK_BYTES + 1).map((_, index) => (index * 31) & 255);
		const hash = createHash("sha256").update(data).digest("hex");
		await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", hash, data.byteLength, data);
		const sessions = await SqlSessionStore.open(database);

		assert.deepEqual(await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 }), []);

		assert.equal(
			Number((await database.get("SELECT chunks FROM snapshot_blobs WHERE hash = ?", hash))?.chunks),
			Math.ceil(data.byteLength / SNAPSHOT_BLOB_CHUNK_BYTES),
		);
		const read = await readAsRelease0987(database, hash);
		assert.ok(
			"refused" in read,
			`0.9.87 read the moved blob as ${(read as { blob?: Uint8Array }).blob?.byteLength} bytes`,
		);
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), data);
	});

	test("an older build's collection between this build's upgrade and its first collection loses no degraded pin (#5065)", async () => {
		const database = await open();
		// old-init: a session store whose snapshot reference index 0.9.87 created, with one session.
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const newIndex = await database.all<SqliteRow & { type: string; name: string }>(
			"SELECT type, name FROM sqlite_schema WHERE (type = 'table' AND name LIKE 'snapshot\\_%' ESCAPE '\\') OR (type = 'trigger' AND name LIKE 'session\\_entries\\_snapshot\\_%' ESCAPE '\\')",
		);
		for (const { type, name } of newIndex) await database.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
		await release0987.SqlSnapshotBlobStore.open(database);

		// new-open: this build upgrades the index.
		await SqlSessionStore.open(database);
		// old-gc: 0.9.87 collects before this build does, and reinstalls its own reference triggers.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 0 });

		// This build records a partly restored worktree: the head is derived from S-lacked, whose bundle it still needs.
		const sessions = await SqlSessionStore.open(database);
		const bundle = new TextEncoder().encode("bundle bytes of S-lacked");
		const hash = createHash("sha256").update(bundle).digest("hex");
		await sessions.snapshotBlobs.putBlobs([{ hash, data: bundle }]);
		const lacked = {
			type: "worktree_snapshot",
			id: "e2",
			parentId: first.id,
			timestamp: "2026-01-01T00:00:00.000Z",
			root: "/w",
			snapshotId: "S-lacked",
			snapshot: syntheticSnapshot("S-lacked", [], { bundle: hash, root: "/w" }),
		} as SessionEntry;
		const derived = {
			type: "worktree_snapshot",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-01-01T00:00:00.000Z",
			root: "/w",
			snapshotId: "S-derived",
			degradedFrom: "S-lacked",
		} as SessionEntry;
		await sessions.append("s1", [lacked, derived], { expectSeq: 1 });

		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false);
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
	});
});

/**
 * A database whose snapshot reference index 0.9.87 installed and backfilled, over the sessions `write` creates with
 * this build's session store.
 */
async function indexedByRelease0987(write: (sessions: SqlSessionStore) => Promise<void>): Promise<SqliteDatabase> {
	const database = await open();
	await write(await SqlSessionStore.open(database));
	const newIndex = await database.all<SqliteRow & { type: string; name: string }>(
		"SELECT type, name FROM sqlite_schema WHERE (type = 'table' AND name LIKE 'snapshot\\_%' ESCAPE '\\' AND name NOT IN ('snapshot_blobs', 'snapshot_blob_chunks')) OR (type = 'trigger' AND name LIKE 'session\\_entries\\_snapshot\\_%' ESCAPE '\\')",
	);
	for (const { type, name } of newIndex) await database.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
	await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
	return database;
}

describe("this build upgrading the session index an older build installed (#5553)", () => {
	test("an entry this build appends before its first collection is found by its id (#5553)", async () => {
		const first = messageEntry("hi") as SessionEntry;
		const database = await indexedByRelease0987((sessions) => createSession(sessions, "s1", [first]).then(() => {}));
		assert.ok(
			await database.get("SELECT 1 FROM snapshot_session_links WHERE entry_id = ?", first.id),
			"0.9.87 indexed the entry",
		);

		// This build upgrades the index on open and leaves its rebuild to the first collection.
		const sessions = await SqlSessionStore.open(database);
		const second = { ...messageEntry("after the upgrade"), parentId: first.id } as SessionEntry;
		await sessions.append("s1", [second], { expectSeq: 1 });

		assert.equal(await sessions.findEntrySeq("s1", second.id), 2);
		assert.equal(await sessions.findEntrySeq("s1", first.id), 1);
		const branched = { ...messageEntry("a branch from the first entry"), parentId: second.id } as SessionEntry;
		const third = { ...messageEntry("a later entry"), parentId: first.id } as SessionEntry;
		await sessions.append("s1", [third], { expectSeq: 2 });
		await sessions.append("s1", [branched], { expectSeq: 3 });
		assert.deepEqual(
			(await sessions.readResume("s1")).branch.map((held) => held.entry.id),
			[first.id, second.id, branched.id],
			"resume follows the branch through the entry appended after the upgrade",
		);
	});

	test("an older build's collection while this build's rebuild is pending loses no degraded pin (#5553)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		// The session index lost a trigger; this build's open marks it for a rebuild, which collection carries out.
		await database.exec("DROP TRIGGER session_entries_snapshot_refs");
		await SqlSessionStore.open(database);
		// 0.9.87 collects before this build does, and installs its own reference triggers under the same names.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 0 });

		// This build records a partly restored worktree, which keeps the bundle of the snapshot it lacks.
		const sessions = await SqlSessionStore.open(database);
		const bundle = new TextEncoder().encode("bundle bytes of S-lacked");
		const hash = createHash("sha256").update(bundle).digest("hex");
		await sessions.snapshotBlobs.putBlobs([{ hash, data: bundle }]);
		const lacked = {
			type: "worktree_snapshot",
			id: "e2",
			parentId: first.id,
			timestamp: "2026-01-01T00:00:00.000Z",
			root: "/w",
			snapshotId: "S-lacked",
			snapshot: syntheticSnapshot("S-lacked", [], { bundle: hash, root: "/w" }),
		} as SessionEntry;
		const derived = {
			type: "worktree_snapshot",
			id: "e3",
			parentId: "e2",
			timestamp: "2026-01-01T00:00:00.000Z",
			root: "/w",
			snapshotId: "S-derived",
			degradedFrom: "S-lacked",
		} as SessionEntry;
		await sessions.append("s1", [lacked, derived], { expectSeq: 1 });

		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false);
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
	});

	test("this build removes the session index an older build installed in transactions of at most SNAPSHOT_INDEX_TEARDOWN_BATCH rows (#5553)", async () => {
		const entries = 3 * 1_000;
		const database = await indexedByRelease0987(async (sessions) => {
			const chain: SessionEntry[] = [messageEntry("start") as SessionEntry];
			for (let index = 1; index < entries; index++)
				chain.push({ ...messageEntry(`entry ${index}`), parentId: chain.at(-1)!.id } as SessionEntry);
			await createSession(sessions, "long", chain);
		});
		const links = async () =>
			Number((await database.get<SqliteRow & { n: number }>("SELECT count(*) AS n FROM snapshot_session_links"))?.n);
		assert.equal(await links(), entries, "0.9.87 indexed every entry");
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
		await SqlSessionStore.open(watched);
		const upgraded = await SqlSnapshotBlobStore.open(watched);

		await upgraded.completeIndex();

		const largest = Math.max(...removed);
		assert.ok(largest <= SNAPSHOT_INDEX_TEARDOWN_BATCH, `one transaction removed ${largest} of ${entries} links`);
		assert.ok(entries > 2 * SNAPSHOT_INDEX_TEARDOWN_BATCH);
		assert.equal(await links(), entries, "the rebuild indexed every entry again");
		const leaves = await database.get<SqliteRow & { leaves: number; broken: number }>(
			"SELECT count(*) FILTER (WHERE children = 0) AS leaves, sum(broken) AS broken FROM snapshot_session_links",
		);
		assert.deepEqual({ ...leaves }, { leaves: 1, broken: 0 });
	});
});
