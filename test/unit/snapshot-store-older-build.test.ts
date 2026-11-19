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
import { SNAPSHOT_BLOB_CHUNK_BYTES } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";

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
	});

	test("a chunked blob stored through the sessions upgrades a journal an older build created (#5065)", async () => {
		const database = await open();
		// An older build created the journal first: its tables, at schema version 1.
		await readAsRelease0987(database, "unknown");
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
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(blob.hash), blob.data);
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
