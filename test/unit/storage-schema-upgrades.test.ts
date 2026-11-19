import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_COLLECTION_BATCH,
	SNAPSHOT_LEGACY_STAMP_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

import { createSession, snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
/** How many times faster than converting the 256 MiB legacy blob its schema-only open must at least be: it measured 5 to 7. */
const SCHEMA_ONLY_OPEN_SPEEDUP = 2;
/**
 * The most blob bytes one write transaction of a 256 MiB legacy session blob's conversion may write: its chunk batch.
 * Bounding the bytes rather than the time keeps the bound where a loaded runner cannot move it: one transaction of a
 * batch stalled for 19 s on a loaded Windows runner. Stamping the legacy snapshot blob's age once rewrote all 256 MiB in
 * one transaction.
 */
const LEGACY_CONVERSION_WRITE_BYTES = 16 * SESSION_BLOB_CHUNK_BYTES;
/**
 * How long one write transaction of a 256 MiB legacy upgrade may hold the writer, not counting time the whole host
 * stood still (see `hostStallClock`). Each writes at most 16 MiB of blob bytes: the longest took 0.11 s at the median on
 * Linux runners, and up to 5.7 s on Windows runners four to a host, the database's own writes waiting on a shared disk.
 */
const LONGEST_WRITE_MS = 15_000;
/**
 * How long one write transaction may hold the writer outside the database's own statements, not counting time the
 * whole host stood still: preparing a batch's bytes, which a loaded disk cannot slow. A stall of the upgrade's own
 * code while it holds the lock, such as a wait between two statements, shows here.
 */
const LONGEST_HOLD_OUTSIDE_STATEMENTS_MS = 2_000;
/** Converting and stamping 256 MiB took up to 134 s together beside other suites on loaded Windows runners. */
const LEGACY_UPGRADE_TEST_TIMEOUT_MS = 300_000;
/**
 * Tests that fork jiti-loaded openers of the database: each fork loads the storage sources before it opens, and the
 * slowest pass of the SIGKILL resume test, which forks two, took 26.7 s on a loaded Windows runner.
 */
const OPENER_FORKING_TEST_TIMEOUT_MS = 120_000;
/** A heartbeat of another thread that comes this much later than its period means the whole host stood still. */
const HOST_STALL_TICK_MS = 10;
const HOST_STALL_MIN_MS = 50;

/**
 * Milliseconds the whole host stood still since it started: a heartbeat on another thread, which keeps running while
 * this one works or waits, counts every tick that came late. A stall inside this process does not stop it.
 */
function hostStallClock(): { stalledMs(): number; stop(): Promise<void> } {
	const stalled = new Float64Array(new SharedArrayBuffer(8));
	const worker = new Worker(
		`const { workerData } = require("node:worker_threads");
const stalled = new Float64Array(workerData);
let last = performance.now();
setInterval(() => {
	const now = performance.now();
	const late = now - last - ${HOST_STALL_TICK_MS};
	if (late > ${HOST_STALL_MIN_MS}) stalled[0] += late;
	last = now;
}, ${HOST_STALL_TICK_MS});`,
		{ eval: true, workerData: stalled.buffer },
	);
	return {
		stalledMs: () => stalled[0]!,
		stop: async () => {
			await worker.terminate();
		},
	};
}

/** `database`, calling `afterCommit` after each of its transactions ends. */
function afterEachTransaction(database: SqliteDatabase, afterCommit: () => Promise<void>): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		close: database.close.bind(database),
		async transaction(callback, options) {
			const result = await database.transaction(callback, options);
			await afterCommit();
			return result;
		},
	};
}

/**
 * The blob bytes a collection has written to the snapshot tables of `database`, without prefix: stamping a blob in its
 * row rewrites the row, so a stamped row counts its bytes, and a chunk counts its own. Deleting rows lowers it.
 */
async function writtenSnapshotBytes(database: SqliteDatabase): Promise<number> {
	const row = await database.get(`SELECT
		(SELECT coalesce(sum(length(data)), 0) FROM snapshot_blobs WHERE created_at > 0) +
		(SELECT coalesce(sum(length(data)), 0) FROM snapshot_blob_chunks) AS bytes`);
	return Number(row?.bytes);
}

async function writtenSessionBytes(database: SqliteDatabase): Promise<number> {
	const row = await database.get("SELECT coalesce(sum(length(data)), 0) AS bytes FROM session_blob_chunks");
	return Number(row?.bytes);
}

/** A legacy blob of `bytes`, in a pattern no chunk boundary lines up with, and its hash. */
function legacyBlob(bytes: number): { readonly data: Buffer; readonly hash: string } {
	const data = Buffer.alloc(bytes).fill(Buffer.from(Array.from({ length: 251 }, (_, index) => index)));
	return { data, hash: createHash("sha256").update(data).digest("hex") };
}

const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "storage-schema-upgrade-"));
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

/** Real processes are necessary: a synchronous SQLite statement otherwise blocks both openers' event loop. */
function startOpener(adapter: string, hash: string, mode = "open") {
	const child = fork(
		join(import.meta.dirname, "../fixtures/session-blob-migration-opener.ts"),
		[adapter, join(directory, "journal.sqlite"), hash, mode],
		{ execArgv: ["--import", "jiti/register"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const messages = new Map<string, unknown>();
	const waiters = new Map<string, (message: unknown) => void>();
	let stderr = "";
	child.stderr?.on("data", (data) => {
		stderr += String(data);
	});
	child.on("message", (message) => {
		const key = typeof message === "string" ? message : (message as { type: string }).type;
		messages.set(key, message);
		waiters.get(key)?.(message);
	});
	const exited = once(child, "exit");
	closers.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	return {
		child,
		exited,
		wait(key: string) {
			const received = messages.has(key)
				? Promise.resolve(messages.get(key))
				: new Promise<unknown>((resolve) => waiters.set(key, resolve));
			return Promise.race([
				received,
				exited.then(([code, signal]) => {
					throw new Error(`opener exited before ${key}: ${code ?? signal}\n${stderr}`);
				}),
			]);
		},
	};
}

for (const adapter of ["node-sqlite", "libsql"] as const) {
	describe(adapter, () => {
		async function openDatabase(): Promise<SqliteDatabase> {
			const path = join(directory, "journal.sqlite");
			const database =
				adapter === "node-sqlite"
					? await openNodeSqliteDatabase(path)
					: await openLibsqlDatabase({ url: pathToFileURL(path).href });
			closers.push(() => database.close());
			return database;
		}

		test.each(["", "custom_"])(
			"opens an old blob store with prefix '%s' and gives existing and new blobs a full grace window (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const table = `${prefix}snapshot_blobs`;
				await database.exec(
					`CREATE TABLE ${table} (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT`,
				);
				const old = textBlob("blob from before creation timestamps");
				await database.run(`INSERT INTO ${table} VALUES (?, ?, ?)`, old.hash, old.data.byteLength, old.data);

				const blobs = await SqlSnapshotBlobStore.open(database, prefix);
				assert.equal(
					Number((await database.get(`SELECT created_at FROM ${table} WHERE hash = ?`, old.hash))?.created_at),
					0,
				);
				assert.equal(
					await database.get("SELECT name FROM sqlite_schema WHERE name = ?", `${table}_age`),
					undefined,
				);
				assert.deepEqual((await collectSnapshotGarbage(blobs)).deleted, []);
				assert.ok(
					Number((await database.get(`SELECT created_at FROM ${table} WHERE hash = ?`, old.hash))?.created_at) > 0,
				);
				assert.ok(await database.get("SELECT name FROM sqlite_schema WHERE name = ?", `${table}_age`));
				assert.deepEqual(await blobs.getBlob(old.hash), old.data);
				const fresh = textBlob("new blob on a migrated table");
				await blobs.putBlobs([fresh]);
				assert.deepEqual((await collectSnapshotGarbage(blobs)).deleted, []);
				assert.deepEqual(await blobs.getBlob(fresh.hash), fresh.data);

				await database.run(`UPDATE ${table} SET created_at = 1`);
				await SqlSnapshotBlobStore.open(database, prefix);
				assert.deepEqual(
					[...(await collectSnapshotGarbage(blobs)).deleted].sort(),
					[old.hash, fresh.hash].sort(),
					"reopening an already migrated journal must not restart blob ages",
				);
			},
		);

		test("collection adds the inline-size index when an older store has only its age index (#5327)", async () => {
			const database = await openDatabase();
			await database.exec(`CREATE TABLE snapshot_blobs (
				hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL,
				created_at INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0) STRICT;
				CREATE INDEX snapshot_blobs_age ON snapshot_blobs (created_at, hash)`);
			const blob = textBlob("legacy-age-index-only");
			await database.run(
				"INSERT INTO snapshot_blobs (hash, bytes, data) VALUES (?, ?, ?)",
				blob.hash,
				blob.data.length,
				blob.data,
			);
			const store = await SqlSnapshotBlobStore.open(database);
			assert.equal(
				await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_inline_size'"),
				undefined,
			);
			assert.deepEqual((await collectSnapshotGarbage(store)).deleted, []);
			assert.ok(await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_inline_size'"));
			assert.deepEqual(await store.getBlob(blob.hash), blob.data);
		});

		test("upgrades an old blob table even when every reference-index table already exists (#4532)", async () => {
			const database = await openDatabase();
			await SqlSnapshotBlobStore.open(database);
			// The blob table as builds before blob ages and chunks (#4954) created it.
			await database.exec(
				"DROP INDEX snapshot_blobs_age; DROP INDEX snapshot_blobs_inline_size; DROP TRIGGER IF EXISTS snapshot_blobs_chunks_delete; DROP TRIGGER IF EXISTS snapshot_blobs_chunks_delete_all; ALTER TABLE snapshot_blobs DROP COLUMN created_at; ALTER TABLE snapshot_blobs DROP COLUMN chunks",
			);
			const old = textBlob("old blob with all index tables present");
			await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", old.hash, old.data.byteLength, old.data);

			const upgraded = await SqlSnapshotBlobStore.open(database);
			assert.deepEqual((await collectSnapshotGarbage(upgraded)).deleted, []);
			assert.deepEqual(await upgraded.getBlob(old.hash), old.data);
		});

		test("resumes bounded legacy age stamping after interruption and preserves the new grace window", async () => {
			const database = await openDatabase();
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const total = SNAPSHOT_COLLECTION_BATCH * 2 + 1;
			await database.transaction(async (tx) => {
				for (let index = 0; index < total; index++) {
					const blob = textBlob(`legacy-${index}`);
					await tx.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
				}
			});
			const controller = new AbortController();
			const interrupted = new Error("stop after one committed stamp batch");
			const observed: SqliteDatabase = {
				descriptor: database.descriptor,
				exec: database.exec.bind(database),
				run: database.run.bind(database),
				get: database.get.bind(database),
				all: database.all.bind(database),
				close: database.close.bind(database),
				async transaction(callback, options) {
					const result = await database.transaction(callback, options);
					const stamped = Number(
						(await database.get("SELECT count(*) AS rows FROM snapshot_blobs WHERE created_at > 0"))?.rows,
					);
					if (stamped > 0 && stamped < total) controller.abort(interrupted);
					return result;
				},
			};
			const store = await SqlSnapshotBlobStore.open(observed);
			await assert.rejects(
				collectSnapshotGarbage(store, { graceSeconds: 0, signal: controller.signal }),
				(error) => error === interrupted,
			);
			assert.equal(
				Number((await database.get("SELECT count(*) AS rows FROM snapshot_blobs WHERE created_at > 0"))?.rows),
				SNAPSHOT_COLLECTION_BATCH,
			);
			assert.equal(Number((await database.get("SELECT count(*) AS rows FROM snapshot_blobs"))?.rows), total);
			const resumed = await SqlSnapshotBlobStore.open(database);
			assert.deepEqual((await collectSnapshotGarbage(resumed)).deleted, []);
			assert.equal(
				Number((await database.get("SELECT count(*) AS rows FROM snapshot_blobs WHERE created_at = 0"))?.rows),
				0,
			);
			assert.equal((await collectSnapshotGarbage(resumed, { graceSeconds: 0 })).deleted.length, total);
		});

		test("stamps legacy blob ages in write transactions of at most SNAPSHOT_LEGACY_STAMP_BYTES of blobs (#5327)", async () => {
			const database = await openDatabase();
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const inlineBlobs = Array.from({ length: 18 }, (_, index) => legacyBlob(SNAPSHOT_BLOB_CHUNK_BYTES - index));
			const chunkedBlobs = [
				legacyBlob(SNAPSHOT_BLOB_CHUNK_BYTES + 1),
				legacyBlob(3 * SNAPSHOT_BLOB_CHUNK_BYTES + 7),
			];
			const blobs = [...inlineBlobs, ...chunkedBlobs];
			for (const blob of blobs)
				await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
			let written: number | undefined;
			let mostWritten = 0;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					if (written === undefined) return;
					const now = await writtenSnapshotBytes(database);
					mostWritten = Math.max(mostWritten, now - written);
					written = now;
				}),
			);
			written = await writtenSnapshotBytes(database);
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
			assert.ok(
				mostWritten > 0 && mostWritten <= SNAPSHOT_LEGACY_STAMP_BYTES,
				`one write stamped ${mostWritten} bytes`,
			);
			for (const blob of inlineBlobs) {
				const state = await legacyState(database, blob.hash);
				assert.ok(state.createdAt > 0);
				assert.equal(state.chunks, 0, "an inline legacy blob of at most one chunk stays in its row");
				assert.equal(state.inline, blob.data.length);
			}
			for (const blob of chunkedBlobs) {
				const state = await legacyState(database, blob.hash);
				assert.ok(state.createdAt > 0);
				assert.equal(state.chunks, Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES));
				assert.equal(state.inline, 0);
			}
			for (const blob of blobs) assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
		});

		/** The rows of the snapshot blob tables for `hash`, and every chunk row of any blob. */
		async function legacyState(database: SqliteDatabase, hash: string) {
			const row = await database.get(
				"SELECT created_at, chunks, length(data) AS inline FROM snapshot_blobs WHERE hash = ?",
				hash,
			);
			const chunks = await database.get(
				"SELECT count(*) AS rows, coalesce(sum(length(data)), 0) AS bytes FROM snapshot_blob_chunks",
			);
			return {
				createdAt: Number(row?.created_at),
				chunks: Number(row?.chunks),
				inline: Number(row?.inline),
				chunkRows: Number(chunks?.rows),
				chunkBytes: Number(chunks?.bytes),
			};
		}

		/**
		 * A blob table as builds before blob ages wrote it, holding one legacy blob that takes three chunk transactions to
		 * move, and a store on it whose collection calls `afterChunks` after each transaction that wrote chunks.
		 */
		async function oversizedLegacyBlob(afterChunks: (transactions: number) => Promise<void>) {
			const database = await openDatabase();
			await database.exec(
				"CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
			);
			const blob = legacyBlob(2 * SNAPSHOT_LEGACY_STAMP_BYTES + 17);
			await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", blob.hash, blob.data.length, blob.data);
			let chunkRows: number | undefined;
			let transactions = 0;
			const store = await SqlSnapshotBlobStore.open(
				afterEachTransaction(database, async () => {
					if (chunkRows === undefined) return;
					const rows = (await legacyState(database, blob.hash)).chunkRows;
					if (rows > chunkRows) await afterChunks(++transactions);
					chunkRows = rows;
				}),
			);
			chunkRows = 0;
			return { database, blob, store, chunks: Math.ceil(blob.data.length / SNAPSHOT_BLOB_CHUNK_BYTES) };
		}

		test.each([1, 2, 3])(
			"a legacy blob too large to stamp in one write, stopped after %i of its chunk transactions, stays readable and is moved whole by the next collection (#5327)",
			async (stopAfter) => {
				const controller = new AbortController();
				const stopped = new Error(`stop after ${stopAfter} chunk transactions`);
				const { database, blob, store, chunks } = await oversizedLegacyBlob(async (transactions) => {
					if (transactions === stopAfter) controller.abort(stopped);
				});
				await assert.rejects(
					collectSnapshotGarbage(store, { graceSeconds: 0, signal: controller.signal }),
					(error) => error === stopped,
				);
				const interrupted = await legacyState(database, blob.hash);
				assert.deepEqual(
					{ createdAt: interrupted.createdAt, chunks: interrupted.chunks, inline: interrupted.inline },
					{ createdAt: 0, chunks: 0, inline: blob.data.length },
					"the blob keeps its bytes and its unknown age in its row until its chunks are complete",
				);
				assert.ok(interrupted.chunkRows > 0 && interrupted.chunkRows <= chunks);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));

				assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
				const moved = await legacyState(database, blob.hash);
				assert.ok(moved.createdAt > 0);
				assert.deepEqual(
					{ chunks: moved.chunks, inline: moved.inline, chunkRows: moved.chunkRows, chunkBytes: moved.chunkBytes },
					{ chunks, inline: 0, chunkRows: chunks, chunkBytes: blob.data.length },
					"the chunks written before the stop are reused, none twice",
				);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
				assert.deepEqual(await database.get("PRAGMA integrity_check"), { integrity_check: "ok" });
			},
		);

		test("a legacy blob stored again after its move to chunks stopped finishes moving on the next collection and leaves no chunk behind once collected (#5327)", async () => {
			const controller = new AbortController();
			const { database, blob, store, chunks } = await oversizedLegacyBlob(async () => controller.abort());
			await assert.rejects(collectSnapshotGarbage(store, { graceSeconds: 0, signal: controller.signal }));
			assert.ok((await legacyState(database, blob.hash)).chunkRows > 0);
			assert.equal(await (await SqlSnapshotBlobStore.open(database)).refreshBlobs([blob.hash]), true);
			assert.equal((await legacyState(database, blob.hash)).createdAt, 0);
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
			const moved = await legacyState(database, blob.hash);
			assert.ok(moved.createdAt > 0);
			assert.deepEqual(
				{ chunks: moved.chunks, inline: moved.inline, chunkRows: moved.chunkRows, chunkBytes: moved.chunkBytes },
				{ chunks, inline: 0, chunkRows: chunks, chunkBytes: blob.data.length },
			);
			assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			await database.run("UPDATE snapshot_blobs SET created_at = 1");
			assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, [blob.hash]);
			assert.equal((await legacyState(database, blob.hash)).chunkRows, 0);
		});

		test.each([1, 3])(
			"a legacy blob stored again after %i of the 3 chunk transactions of its move still finishes moving to chunks (#5327)",
			async (storedAfter) => {
				let other: SqlSnapshotBlobStore | undefined;
				let refreshed = false;
				const { database, blob, store, chunks } = await oversizedLegacyBlob(async (transactions) => {
					if (transactions !== storedAfter) return;
					assert.equal(await other!.refreshBlobs([blob.hash]), true);
					refreshed = true;
				});
				other = await SqlSnapshotBlobStore.open(database);
				assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
				assert.ok(refreshed, "the blob is stored again after its first chunks were written");
				const kept = await legacyState(database, blob.hash);
				assert.ok(kept.createdAt > 0);
				assert.deepEqual(
					{ chunks: kept.chunks, inline: kept.inline, chunkRows: kept.chunkRows, chunkBytes: kept.chunkBytes },
					{ chunks, inline: 0, chunkRows: chunks, chunkBytes: blob.data.length },
				);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			},
		);

		test.each([1, 3])(
			"a legacy blob moved by an overlapping collector after %i chunk transactions keeps its completed chunks (#5327)",
			async (completedAfter) => {
				let other: SqlSnapshotBlobStore | undefined;
				let completed = false;
				const { database, blob, store, chunks } = await oversizedLegacyBlob(async (transactions) => {
					if (transactions !== completedAfter || completed) return;
					assert.deepEqual(await other!.collectGarbage({ graceSeconds: 0 }), []);
					completed = true;
				});
				other = await SqlSnapshotBlobStore.open(database);
				assert.deepEqual((await collectSnapshotGarbage(store, { graceSeconds: 0 })).deleted, []);
				assert.ok(completed, "the overlapping collector finished the conversion");
				const kept = await legacyState(database, blob.hash);
				assert.ok(kept.createdAt > 0);
				assert.deepEqual(
					{ chunks: kept.chunks, inline: kept.inline, chunkRows: kept.chunkRows, chunkBytes: kept.chunkBytes },
					{ chunks, inline: 0, chunkRows: chunks, chunkBytes: blob.data.length },
				);
				assert.ok(blob.data.equals((await store.getBlob(blob.hash))!));
			},
		);

		test.each(["", "custom_"])(
			"upgrades old session snapshot references with prefix '%s' and rebuilds retention links (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database, { prefix });
				closers.push(() => sessions.close());
				const old = textBlob("superseded session snapshot");
				const current = textBlob("current session snapshot");
				await sessions.snapshotBlobs.putBlobs([old, current]);
				const entries = [old, current].map((blob, index) => {
					const snapshot = syntheticSnapshot(`snapshot-${index}`, [blob.hash]);
					return snapshotEntry("/repo", snapshot.id, snapshot);
				});
				await createSession(sessions, "session", entries);
				await database.exec(`DROP TRIGGER ${prefix}session_entries_snapshot_refs;
					DROP TRIGGER ${prefix}session_entries_snapshot_refs_delete;
					DROP TABLE ${prefix}snapshot_session_refs`);
				await database.exec(`CREATE TABLE ${prefix}snapshot_session_refs (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL,
					PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID`);
				await database.run(
					`INSERT INTO ${prefix}snapshot_session_refs VALUES ('session', 1, '/repo', 'snapshot-0')`,
				);
				await database.exec(`CREATE TRIGGER ${prefix}session_entries_snapshot_refs
					AFTER INSERT ON ${prefix}session_entries WHEN json_extract(NEW.entry_json, '$.type') = 'worktree_snapshot'
					BEGIN INSERT OR REPLACE INTO ${prefix}snapshot_session_refs (session_id, seq, root, snapshot_id)
					VALUES (NEW.session_id, NEW.seq, json_extract(NEW.entry_json, '$.root'), json_extract(NEW.entry_json, '$.snapshotId')); END`);

				const upgraded = await SqlSessionStore.open(database, { prefix });
				closers.push(() => upgraded.close());
				assert.equal(
					Number((await database.get(`SELECT count(*) AS rows FROM ${prefix}snapshot_session_refs`))?.rows),
					1,
					"open must leave legacy reference rows untouched until collection",
				);
				const reopened = await SqlSessionStore.open(database, { prefix });
				closers.push(() => reopened.close());
				assert.equal(
					Number((await database.get(`SELECT count(*) AS rows FROM ${prefix}snapshot_session_refs`))?.rows),
					1,
				);
				// Appends before deferred trigger installation must also be covered by the collector's watermark.
				const unseenSnapshot = syntheticSnapshot("before-collection", [current.hash]);
				const unseen = snapshotEntry("/repo", unseenSnapshot.id, unseenSnapshot, entries[1]!.id);
				await upgraded.append("session", [unseen], { expectSeq: 2 });
				assert.deepEqual((await collectSnapshotGarbage(upgraded.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					old.hash,
				]);
				assert.deepEqual(await upgraded.snapshotBlobs.getBlob(current.hash), current.data);
				const nextBlob = textBlob("snapshot appended after migration");
				await upgraded.snapshotBlobs.putBlobs([nextBlob]);
				const next = syntheticSnapshot("next", [nextBlob.hash]);
				await upgraded.append("session", [snapshotEntry("/repo", next.id, next, unseen.id)], { expectSeq: 3 });
				assert.deepEqual((await collectSnapshotGarbage(upgraded.snapshotBlobs, { graceSeconds: 0 })).deleted, [
					current.hash,
				]);
				assert.deepEqual(await upgraded.snapshotBlobs.getBlob(nextBlob.hash), nextBlob.data);
			},
		);

		test.each(["", "custom_"])(
			"upgrades one-row session blobs with prefix '%s' without losing bytes or blocking new inserts (#4532)",
			async (prefix) => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database, { prefix });
				closers.push(() => sessions.close());
				await createSession(sessions, "session", []);
				const table = `${prefix}session_blobs`;
				await database.exec(`DROP TABLE ${table}; DROP TABLE ${prefix}session_blob_chunks;
					CREATE TABLE ${table} (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
					data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
				const old = [
					new Uint8Array(),
					Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251),
				];
				const hashes: string[] = [];
				for (const data of old) {
					const hash = createHash("sha256").update(data).digest("hex");
					hashes.push(hash);
					await database.run(`INSERT INTO ${table} VALUES ('session', ?, ?, ?)`, hash, data.byteLength, data);
				}

				const upgraded = await SqlSessionStore.open(database, { prefix });
				closers.push(() => upgraded.close());
				for (const [index, hash] of hashes.entries())
					assert.deepEqual(await upgraded.getBlob("session", hash), old[index]);
				assert.equal(
					Number((await database.get(`SELECT count(*) AS rows FROM ${table} WHERE chunks = -1`))?.rows),
					old.length,
					"reading legacy bytes must not convert rows",
				);
				const fresh = textBlob("new session blob after migration");
				const inserted = await upgraded.putBlob("session", fresh.data);
				assert.deepEqual(await upgraded.getBlob("session", inserted.hash), fresh.data);
				const reopened = await SqlSessionStore.open(database, { prefix });
				closers.push(() => reopened.close());
				for (const [index, hash] of hashes.entries())
					assert.deepEqual(await reopened.getBlob("session", hash), old[index]);
				assert.equal(
					Number((await database.get(`SELECT count(*) AS rows FROM ${table} WHERE chunks = -1`))?.rows),
					old.length,
					"writing another hash and reopening must leave legacy rows untouched",
				);
				await reopened.delete("session");
				assert.equal(await reopened.getBlob("session", hashes[1]!), undefined);
			},
		);
		test.each([64, 128, 256])(
			"reads a %i MiB legacy blob byte-exactly in linear time",
			async (mib) => {
				const database = await openDatabase();
				await database.exec(`CREATE TABLE session_blobs (
				session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL,
				PRIMARY KEY (session_id, hash)) STRICT`);
				const original = Buffer.alloc(mib * 1024 * 1024).fill(Buffer.from([0, 1, 127, 128, 255]));
				const hash = createHash("sha256").update(original).digest("hex");
				await database.run(
					"INSERT INTO session_blobs VALUES ('session', ?, ?, ?)",
					hash,
					original.length,
					original,
				);
				const sessions = await SqlSessionStore.open(database);
				closers.push(() => sessions.close());
				const started = performance.now();
				const restored = await sessions.getBlob("session", hash);
				const elapsed = performance.now() - started;
				process.stdout.write(`${adapter}: ${mib} MiB legacy read ${elapsed.toFixed(0)} ms\n`);
				assert.ok(restored !== undefined && original.equals(restored), "legacy bytes must match exactly");
				// Allow slow CI and linear copying, but reject repeatedly reading the entire source for every chunk.
				assert.ok(elapsed < 1_500 + mib * 12, `${mib} MiB legacy read took ${elapsed.toFixed(0)} ms`);
			},
			120_000,
		);

		test("reads all bytes when a legacy blob is published as chunks between read statements", async () => {
			const database = await openDatabase();
			await database.exec(`CREATE TABLE session_blobs (
				session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL,
				PRIMARY KEY (session_id, hash)) STRICT`);
			const original = Buffer.alloc(2 * 1024 * 1024 + 17).fill(Buffer.from([0, 1, 127, 128, 255]));
			const hash = createHash("sha256").update(original).digest("hex");
			await database.run("INSERT INTO session_blobs VALUES ('session', ?, ?, ?)", hash, original.length, original);
			const writer = await SqlSessionStore.open(database);
			closers.push(() => writer.close());
			await createSession(writer, "session", []);
			let publish = false;
			const interleaved: SqliteDatabase = {
				descriptor: database.descriptor,
				exec: database.exec.bind(database),
				run: database.run.bind(database),
				all: database.all.bind(database),
				transaction: database.transaction.bind(database),
				close: database.close.bind(database),
				async get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
					const row = await database.get<T>(sql, ...params);
					if (publish && Number(row?.chunks) === -1) {
						publish = false;
						await writer.putBlob("session", original);
					}
					return row;
				},
			};
			const reader = await SqlSessionStore.open(interleaved);
			closers.push(() => reader.close());
			publish = true;
			const restored = await reader.getBlob("session", hash);
			assert.ok(restored !== undefined && original.equals(restored));
			assert.equal(publish, false, "conversion must finish after the reader sees the legacy header");
		});

		test(
			"opens a 256 MiB legacy blob without rewriting it and converts only on its next write (#5327)",
			async () => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database);
				closers.push(() => sessions.close());
				await createSession(sessions, "session", []);
				await database.exec(`DROP TABLE session_blobs; DROP TABLE session_blob_chunks;
				CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
				data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
				const bytes = 256 * 1024 * 1024;
				const pattern = Buffer.from(Array.from({ length: 251 }, (_, index) => index));
				const original = Buffer.alloc(bytes).fill(pattern);
				const hash = createHash("sha256").update(original).digest("hex");
				await database.run("INSERT INTO session_blobs VALUES ('session', ?, ?, ?)", hash, bytes, original);
				await database.exec(`DROP INDEX snapshot_blobs_age; DROP TABLE snapshot_blobs;
				CREATE TABLE snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL) STRICT`);
				await database.run("INSERT INTO snapshot_blobs VALUES (?, ?, ?)", hash, bytes, original);
				const hostStalls = hostStallClock();
				closers.push(() => hostStalls.stop());
				const durations: number[] = [];
				const outsideStatements: number[] = [];
				let measuring: (() => Promise<number>) | undefined;
				let written = 0;
				let mostWritten = 0;
				const measured: SqliteDatabase = {
					descriptor: database.descriptor,
					exec: database.exec.bind(database),
					run: database.run.bind(database),
					get: database.get.bind(database),
					all: database.all.bind(database),
					close: database.close.bind(database),
					async transaction(callback, options) {
						let acquired = 0;
						let stalledBefore = 0;
						let inStatementsMs = 0;
						let running = 0;
						let runningSince = 0;
						const timed = <T>(statement: () => Promise<T>): Promise<T> => {
							if (running++ === 0) runningSince = performance.now();
							return statement().finally(() => {
								if (--running === 0) inStatementsMs += performance.now() - runningSince;
							});
						};
						const result = await database.transaction(async (tx) => {
							acquired = performance.now();
							stalledBefore = hostStalls.stalledMs();
							const value = await callback({
								exec: (sql) => timed(() => tx.exec(sql)),
								run: (sql, ...params) => timed(() => tx.run(sql, ...params)),
								get: <R extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
									timed(() => tx.get<R>(sql, ...params)),
								all: <R extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
									timed(() => tx.all<R>(sql, ...params)),
							});
							outsideStatements.push(
								performance.now() - acquired - inStatementsMs - (hostStalls.stalledMs() - stalledBefore),
							);
							return value;
						}, options);
						durations.push(performance.now() - acquired - (hostStalls.stalledMs() - stalledBefore));
						if (measuring !== undefined) {
							const now = await measuring();
							mostWritten = Math.max(mostWritten, now - written);
							written = now;
						}
						return result;
					},
				};
				const started = performance.now();
				const upgraded = await SqlSessionStore.open(measured);
				closers.push(() => upgraded.close());
				const openMs = performance.now() - started;
				const pending = await database.get(
					"SELECT chunks, length(data) AS bytes FROM session_blobs WHERE hash = ?",
					hash,
				);
				assert.equal(Number(pending?.chunks), -1);
				assert.equal(Number(pending?.bytes), bytes);
				assert.equal(Number((await database.get("SELECT count(*) AS chunks FROM session_blob_chunks"))?.chunks), 0);
				assert.equal(
					Number((await database.get("SELECT created_at FROM snapshot_blobs WHERE hash = ?", hash))?.created_at),
					0,
				);
				assert.equal(
					await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_age'"),
					undefined,
				);
				durations.length = 0;
				outsideStatements.length = 0;
				written = await writtenSessionBytes(database);
				measuring = () => writtenSessionBytes(database);
				const conversionStarted = performance.now();
				assert.deepEqual(await upgraded.putBlob("session", original), { hash, bytes });
				const elapsed = performance.now() - conversionStarted;
				measuring = undefined;
				const conversionMostWritten = mostWritten;
				mostWritten = 0;
				const longest = Math.max(...durations);
				const longestOutside = Math.max(...outsideStatements);
				process.stdout.write(
					`${adapter}: 256 MiB open ${openMs.toFixed(0)} ms; lazy conversion ${elapsed.toFixed(0)} ms; longest write ${longest.toFixed(0)} ms, ${longestOutside.toFixed(0)} ms of it outside statements; most blob bytes in one write ${conversionMostWritten}\n`,
				);
				// Measured against the conversion on the same machine, so a loaded runner slows both: an open that read or
				// rewrote the blob would cost about as much as converting it.
				assert.ok(
					openMs * SCHEMA_ONLY_OPEN_SPEEDUP < elapsed,
					`schema-only open took ${openMs.toFixed(0)} ms against ${elapsed.toFixed(0)} ms to convert the blob`,
				);
				assert.ok(
					conversionMostWritten > 0 && conversionMostWritten <= LEGACY_CONVERSION_WRITE_BYTES,
					`one conversion write transaction wrote ${conversionMostWritten} bytes of blobs`,
				);
				assert.ok(longest < LONGEST_WRITE_MS, `one write transaction held the lock for ${longest.toFixed(0)} ms`);
				assert.ok(
					longestOutside < LONGEST_HOLD_OUTSIDE_STATEMENTS_MS,
					`one write transaction held the lock for ${longestOutside.toFixed(0)} ms outside its statements`,
				);
				assert.ok(durations.length > 2, "large blobs must commit between chunk batches");
				const restored = await upgraded.getBlob("session", hash);
				assert.equal(restored?.byteLength, bytes);
				assert.equal(createHash("sha256").update(restored!).digest("hex"), hash);
				durations.length = 0;
				outsideStatements.length = 0;
				written = await writtenSnapshotBytes(database);
				measuring = () => writtenSnapshotBytes(database);
				const collectionStarted = performance.now();
				assert.deepEqual((await collectSnapshotGarbage(upgraded.snapshotBlobs, { graceSeconds: 0 })).deleted, []);
				const maintenanceMs = performance.now() - collectionStarted;
				measuring = undefined;
				const maintenanceWriteMs = Math.max(...durations);
				const maintenanceOutside = Math.max(...outsideStatements);
				process.stdout.write(
					`${adapter}: 256 MiB deferred age index + stamp ${maintenanceMs.toFixed(0)} ms; longest write ${maintenanceWriteMs.toFixed(0)} ms, ${maintenanceOutside.toFixed(0)} ms of it outside statements; most blob bytes in one write ${mostWritten}\n`,
				);
				assert.ok(
					mostWritten <= SNAPSHOT_LEGACY_STAMP_BYTES,
					`one snapshot maintenance transaction wrote ${mostWritten} bytes of blobs`,
				);
				assert.ok(
					maintenanceWriteMs < LONGEST_WRITE_MS,
					`snapshot maintenance held the writer for ${maintenanceWriteMs.toFixed(0)} ms`,
				);
				assert.ok(
					maintenanceOutside < LONGEST_HOLD_OUTSIDE_STATEMENTS_MS,
					`snapshot maintenance held the writer for ${maintenanceOutside.toFixed(0)} ms outside its statements`,
				);
				assert.ok(await database.get("SELECT name FROM sqlite_schema WHERE name = 'snapshot_blobs_age'"));
				const stamped = await database.get(
					"SELECT created_at, chunks, length(data) AS inline FROM snapshot_blobs WHERE hash = ?",
					hash,
				);
				assert.ok(Number(stamped?.created_at) > 0);
				assert.equal(
					Number(stamped?.chunks),
					bytes / SNAPSHOT_BLOB_CHUNK_BYTES,
					"a legacy blob too large to stamp in one write moves to chunks",
				);
				assert.equal(Number(stamped?.inline), 0);
				assert.equal(
					createHash("sha256")
						.update((await upgraded.snapshotBlobs.getBlob(hash))!)
						.digest("hex"),
					hash,
				);
				assert.deepEqual(
					(await collectSnapshotGarbage(upgraded.snapshotBlobs)).deleted,
					[],
					"stamped legacy blobs get the full grace window",
				);
			},
			LEGACY_UPGRADE_TEST_TIMEOUT_MS,
		);

		test(
			"a concurrent opener succeeds during a lazy 256 MiB conversion while mixed-layout blobs remain readable",
			async () => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database);
				closers.push(() => sessions.close());
				await createSession(sessions, "session", []);
				await database.exec(`DROP TABLE session_blobs; DROP TABLE session_blob_chunks;
				CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
				data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
				const reader = await SqlSessionStore.open(database);
				closers.push(() => reader.close());
				const bytes = 256 * 1024 * 1024;
				const digest = createHash("sha256");
				const block = new Uint8Array(1024 * 1024);
				for (let index = 0; index < 256; index++) digest.update(block);
				const hash = digest.digest("hex");
				await database.run(
					"INSERT INTO session_blobs (session_id, hash, bytes, data) VALUES ('session', ?, ?, zeroblob(?))",
					hash,
					bytes,
					bytes,
				);
				const old = textBlob("still legacy during conversion");
				await database.run(
					"INSERT INTO session_blobs (session_id, hash, bytes, data) VALUES ('session', ?, ?, ?)",
					old.hash,
					old.data.length,
					old.data,
				);
				const fresh = textBlob("already chunked during conversion");
				await reader.putBlob("session", fresh.data);
				const migrator = startOpener(adapter, hash, "pause");
				await migrator.wait("locked");
				const contender = startOpener(adapter, hash);
				await contender.wait("opening");
				assert.deepEqual(await reader.getBlob("session", old.hash), old.data);
				assert.deepEqual(await reader.getBlob("session", fresh.hash), fresh.data);
				migrator.child.send("continue");
				await migrator.wait("batch");
				assert.equal(await contender.wait("opened"), "opened");
				assert.deepEqual(await contender.exited, [0, null]);
				migrator.child.send("continue");
				assert.deepEqual(await migrator.wait("written"), { type: "written", hash });
				assert.deepEqual(await migrator.exited, [0, null]);
				assert.deepEqual(await database.get("PRAGMA integrity_check"), { integrity_check: "ok" });
				assert.deepEqual(await reader.getBlob("session", old.hash), old.data);
				assert.deepEqual(await reader.getBlob("session", fresh.hash), fresh.data);
				const reopened = await SqlSessionStore.open(database);
				closers.push(() => reopened.close());
				assert.equal(
					createHash("sha256")
						.update((await reopened.getBlob("session", hash))!)
						.digest("hex"),
					hash,
				);
			},
			OPENER_FORKING_TEST_TIMEOUT_MS,
		);

		test(
			"resumes after SIGKILL between chunk batches without discarding legacy bytes or duplicating chunks",
			async () => {
				const database = await openDatabase();
				const sessions = await SqlSessionStore.open(database);
				closers.push(() => sessions.close());
				await createSession(sessions, "session", []);
				await database.exec(`DROP TABLE session_blobs; DROP TABLE session_blob_chunks;
				CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
				data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
				const original = Buffer.alloc(32 * 1024 * 1024 + 17).fill(Buffer.from([0, 1, 127, 128, 255]));
				const hash = createHash("sha256").update(original).digest("hex");
				await database.run(
					"INSERT INTO session_blobs VALUES ('session', ?, ?, ?)",
					hash,
					original.length,
					original,
				);
				const migrator = startOpener(adapter, hash, "pause-binary");
				await migrator.wait("locked");
				migrator.child.send("continue");
				await migrator.wait("batch");
				migrator.child.kill("SIGKILL");
				await migrator.exited;
				assert.deepEqual(await database.get("PRAGMA integrity_check"), { integrity_check: "ok" });
				const pending = await database.get(
					"SELECT chunks, length(data) AS bytes FROM session_blobs WHERE hash = ?",
					hash,
				);
				assert.equal(Number(pending?.chunks), -1);
				assert.equal(Number(pending?.bytes), original.length);
				const progress = await database.get(
					"SELECT count(*) AS chunks, sum(length(data)) AS bytes FROM session_blob_chunks",
				);
				assert.ok(Number(progress?.chunks) > 0);
				assert.ok(Number(progress?.bytes) < original.length);
				const resumed = startOpener(adapter, hash, "write-binary");
				assert.deepEqual(await resumed.wait("written"), { type: "written", hash });
				assert.deepEqual(await resumed.exited, [0, null]);
				const upgraded = await SqlSessionStore.open(database);
				closers.push(() => upgraded.close());
				assert.deepEqual(await upgraded.getBlob("session", hash), new Uint8Array(original));
				const complete = await database.get(
					"SELECT chunks, length(data) AS bytes FROM session_blobs WHERE hash = ?",
					hash,
				);
				assert.equal(Number(complete?.chunks), 33);
				assert.equal(Number(complete?.bytes), 0);
				assert.equal(
					Number((await database.get("SELECT count(*) AS chunks FROM session_blob_chunks"))?.chunks),
					33,
				);
			},
			OPENER_FORKING_TEST_TIMEOUT_MS,
		);
	});
}
