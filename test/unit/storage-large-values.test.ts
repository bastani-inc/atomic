import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageError, StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { assertStorageSchemaVersion } from "../../packages/coding-agent/src/core/storage/schema.js";
import {
	SESSION_SUMMARY_TEXT_CHARS,
	summarizeSession,
} from "../../packages/coding-agent/src/core/storage/session/session-summary.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionSummary } from "../../packages/coding-agent/src/core/storage/session/types.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { JOURNAL_READ_PAGE_CHARS } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";
import { rowLimitedDatabase } from "../helpers/row-limited-database.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Values larger than a libSQL server takes (#4954), on a SQLite file behind a wrapper that refuses what such a server
 * refuses for size: values over one chunk, and responses over two and a half. Every store must stay within both.
 */

useTemporaryAgentDir();

const MiB = 1024 * 1024;
const LIMITS = { maxValueBytes: MiB, maxResponseBytes: 2.5 * MiB };
const createdAt = new Date(0).toISOString();
const header = (id = "session") => ({ id, version: 4 as const, createdAt, cwd: "/project" });

function message(id: string, parentId: string | null, text: string, role: "user" | "assistant" = "user"): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: createdAt,
		message: { role, content: text, timestamp: 0 },
	} as SessionEntry;
}

const count = async (database: SqliteDatabase, sql: string, ...params: string[]) =>
	Number((await database.get<SqliteRow & { n: number }>(sql, ...params))?.n);

async function list(store: SqlSessionStore): Promise<SessionSummary[]> {
	return Array.fromAsync(store.list({ includeInternal: true }));
}

describe("a session store under a libSQL server's size limits (#4954)", () => {
	test("long entries are stored in chunks of at most 1 MiB and a long session loads in pages (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, LIMITS);
			const store = await SqlSessionStore.open(limited.wrapped);
			// Over three chunks of ASCII, over one of multi-byte text, and one whose JSON is long but under a chunk.
			const long = message("long", null, "a".repeat(3 * MiB + 5));
			const wide = message("wide", "long", "é😀".repeat(MiB / 6));
			const narrow = message("narrow", "wide", "n".repeat(MiB / 2));
			const replies = Array.from({ length: 10 }, (_, index) =>
				message(`reply-${index}`, "narrow", `${index}`.repeat(300_000), "assistant"),
			);
			await store.create(header(), [long, wide, narrow]);
			await store.append("session", replies, { expectSeq: 3 });

			const loaded = await store.load("session");
			assert.equal(loaded.lastSeq, 13);
			assert.ok(JSON.stringify(loaded.entries) === JSON.stringify([long, wide, narrow, ...replies]));
			assert.deepEqual(limited.refused, []);

			const rows = await database.all<SqliteRow & { entry_id: string; chunks: number; entry_json: string }>(
				"SELECT entry_id, chunks, entry_json FROM session_entries WHERE seq <= 3 ORDER BY seq",
			);
			const bytes = (entry: SessionEntry) => Buffer.byteLength(JSON.stringify(entry));
			assert.deepEqual(
				rows.map((row) => [row.entry_id, Number(row.chunks)]),
				[
					["long", Math.ceil(bytes(long) / SESSION_ENTRY_CHUNK_BYTES)],
					["wide", Math.ceil(bytes(wide) / SESSION_ENTRY_CHUNK_BYTES)],
					["narrow", 0],
				],
			);
			// The stub keeps what the snapshot reference index reads.
			assert.deepEqual(JSON.parse(rows[1]!.entry_json), { type: "message", id: "wide", parentId: "long" });
			const chunks = await database.all<SqliteRow & { data: Uint8Array }>(
				"SELECT data FROM session_entry_chunks WHERE seq = 1 ORDER BY idx",
			);
			assert.deepEqual(
				chunks.map((chunk) => chunk.data.byteLength),
				[SESSION_ENTRY_CHUNK_BYTES, SESSION_ENTRY_CHUNK_BYTES, SESSION_ENTRY_CHUNK_BYTES, bytes(long) - 3 * MiB],
			);

			await store.replace("session", header(), [narrow], { expectSeq: 13 });
			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 0);
			assert.deepEqual((await store.load("session")).entries, [narrow]);
			await store.append("session", [long], { expectSeq: 1 });
			assert.ok(JSON.stringify((await store.load("session")).entries) === JSON.stringify([narrow, long]));
			await store.delete("session");
			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 0);
		});
	});

	test("snapshot entries stay whole, other long entries are split, and a lost chunk is an error (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(
				rowLimitedDatabase(database, { ...LIMITS, maxValueBytes: 2 * MiB }).wrapped,
			);
			const snapshot = {
				type: "worktree_snapshot",
				id: "snapshot",
				parentId: null,
				timestamp: createdAt,
				root: "/repo",
				snapshotId: "id",
				snapshot: { chain: [], bundle: null, omitted: ["x".repeat(1.5 * MiB)] },
			} as unknown as SessionEntry;
			const custom = {
				type: "custom",
				id: "custom",
				parentId: null,
				timestamp: createdAt,
				customType: "payload",
				data: "y".repeat(1.5 * MiB),
			} as unknown as SessionEntry;
			await store.create(header(), [snapshot, custom]);
			const chunks = await database.all<SqliteRow & { chunks: number; entry_json: string }>(
				"SELECT chunks, entry_json FROM session_entries ORDER BY seq",
			);
			assert.deepEqual(
				chunks.map((row) => Number(row.chunks)),
				[0, 2],
			);
			assert.deepEqual(JSON.parse(chunks[1]!.entry_json), { type: "custom", id: "custom", parentId: null });
			assert.ok(JSON.stringify((await store.load("session")).entries) === JSON.stringify([snapshot, custom]));

			await database.run("DELETE FROM session_entry_chunks WHERE idx = 1");
			await assert.rejects(store.load("session"), (error: unknown) => {
				assert.ok(error instanceof StorageError);
				assert.equal(error.message, "Session session entry 2 is missing chunk 1 of 2");
				return true;
			});
		});
	});

	test("listings read in pages, in store order, with long search text joined outside the database (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, LIMITS);
			const store = await SqlSessionStore.open(limited.wrapped);
			const ids = Array.from({ length: 24 }, (_, index) => `s-${String(23 - index).padStart(2, "0")}`);
			for (const id of ids) await store.create(header(id), [message(`${id}-1`, null, `${id} `.repeat(30_000))]);
			// One session's search text alone is longer than a page.
			const texts = Array.from({ length: 20 }, (_, index) => `${index % 10}`.repeat(SESSION_SUMMARY_TEXT_CHARS));
			const long = texts.map((text, index) => message(`long-${index}`, null, text, "assistant"));
			await store.append("s-05", long, { expectSeq: 1 });

			const expected = (
				await database.all<SqliteRow & { id: string }>("SELECT id FROM session_sessions ORDER BY rowid")
			).map((row) => row.id);
			const first = await list(store);
			assert.deepEqual(
				first.map((summary) => summary.id),
				expected,
			);
			const s05 = first.find((summary) => summary.id === "s-05")!;
			assert.equal(
				s05.searchText,
				[`${"s-05 ".repeat(30_000)}`.slice(0, SESSION_SUMMARY_TEXT_CHARS), ...texts].join(" "),
			);
			assert.equal(s05.firstMessage, "s-05 ".repeat(30_000).slice(0, SESSION_SUMMARY_TEXT_CHARS));
			assert.deepEqual(limited.refused, []);

			// A listing after a change revalidates the scope through its listing rows, still in pages.
			await store.append("s-10", [message("s-10-2", "s-10-1", "appended needle")], { expectSeq: 1 });
			const second = await list(store);
			assert.deepEqual(
				second.map((summary) => summary.id),
				expected,
			);
			assert.match(second.find((summary) => summary.id === "s-10")!.searchText, /appended needle$/);
			assert.equal(second.find((summary) => summary.id === "s-05")!.searchText, s05.searchText);
			assert.deepEqual(limited.refused, []);
		});
	});
});

describe("listing text is bounded the same way by every store (#4954)", () => {
	const summary = (text: string) =>
		summarizeSession({ header: header(), entries: [message("m", null, text)], lastSeq: 1 });

	test("a message up to the bound is kept whole, a longer one is cut at the bound (#4954)", () => {
		const exact = "x".repeat(SESSION_SUMMARY_TEXT_CHARS);
		assert.equal(summary(exact).firstMessage, exact);
		assert.equal(summary(`${exact}y`).firstMessage, exact);
		assert.equal(summary(`${exact}y`).searchText, exact);
	});

	test("the cut never separates the halves of a surrogate pair (#4954)", () => {
		const before = "x".repeat(SESSION_SUMMARY_TEXT_CHARS - 1);
		assert.equal(summary(`${before}😀tail`).firstMessage, before);
		// A lone high surrogate at the bound, not followed by its low half, is kept as it was.
		assert.equal(summary(`${before}\ud800xtail`).firstMessage, `${before}\ud800`);
		// A pair that ends at the bound is whole.
		const pair = `${"x".repeat(SESSION_SUMMARY_TEXT_CHARS - 2)}😀`;
		assert.equal(summary(`${pair}tail`).firstMessage, pair);
	});
});

describe("snapshot blobs under a libSQL server's size limits (#4954)", () => {
	const blobOf = (hash: string, size: number) => ({
		hash,
		data: Uint8Array.from({ length: size }, (_, index) => (index * 7 + size) % 251),
	});

	test("a blob over one chunk is stored in chunks once and read back whole (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, LIMITS);
			const blobs = await SqlSnapshotBlobStore.open(limited.wrapped);
			const stored = [
				blobOf("small", 10),
				blobOf("exact", SNAPSHOT_BLOB_CHUNK_BYTES),
				blobOf("over", SNAPSHOT_BLOB_CHUNK_BYTES + 1),
				blobOf("large", 3 * SNAPSHOT_BLOB_CHUNK_BYTES + 3),
			];
			await blobs.putBlobs(stored);
			await blobs.putBlobs(stored);
			for (const blob of stored) assert.deepEqual(await blobs.getBlob(blob.hash), blob.data, blob.hash);
			assert.deepEqual(limited.refused, []);
			const rows = await database.all<SqliteRow & { hash: string; chunks: number; data: Uint8Array }>(
				"SELECT hash, chunks, data FROM snapshot_blobs ORDER BY hash",
			);
			assert.deepEqual(
				rows.map((row) => [row.hash, Number(row.chunks), row.data.byteLength]),
				[
					["exact", 0, SNAPSHOT_BLOB_CHUNK_BYTES],
					["large", 4, 0],
					["over", 2, 0],
					["small", 0, 10],
				],
			);
			assert.equal(await count(database, "SELECT count(*) AS n FROM snapshot_blob_chunks"), 6, "stored once");
		});
	});

	test("a blob stored in one row before keeps its row, and a chunked blob missing bytes is not returned (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const blobs = await SqlSnapshotBlobStore.open(database);
			const legacy = blobOf("legacy", 2 * SNAPSHOT_BLOB_CHUNK_BYTES);
			await database.run(
				"INSERT INTO snapshot_blobs (hash, bytes, data, created_at) VALUES (?, ?, ?, 1)",
				legacy.hash,
				legacy.data.byteLength,
				legacy.data,
			);
			await blobs.putBlobs([legacy]);
			assert.equal(await count(database, "SELECT count(*) AS n FROM snapshot_blob_chunks"), 0);
			assert.deepEqual(await blobs.getBlob("legacy"), legacy.data);

			for (const [name, damage] of [
				["a lost chunk", "DELETE FROM snapshot_blob_chunks WHERE hash = ? AND idx = 1"],
				[
					"a chunk longer than the blob",
					"UPDATE snapshot_blob_chunks SET data = zeroblob(length(data) + 1) WHERE hash = ? AND idx = 1",
				],
				["a header longer than its chunks", "UPDATE snapshot_blobs SET bytes = bytes + 1 WHERE hash = ?"],
			] as const) {
				const blob = blobOf(`damaged-${name}`, 2 * SNAPSHOT_BLOB_CHUNK_BYTES);
				await blobs.putBlobs([blob]);
				assert.deepEqual(await blobs.getBlob(blob.hash), blob.data);
				await database.run(damage, blob.hash);
				assert.equal(await blobs.getBlob(blob.hash), undefined, name);
			}
		});
	});
});

describe("workflow journal reads under a libSQL server's size limits (#4954)", () => {
	test("events of more than a response read back in order, by sequence and by key (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, { ...LIMITS, maxValueBytes: 2 * MiB });
			const journal = await SqlRunJournal.open(limited.wrapped);
			await journal.createRun({ runId: "run", name: "workflow", cwd: "/cwd", createdAt: 0, status: "running" });
			const outcome = await journal.acquire("run", "holder");
			if (outcome.status !== "acquired") assert.fail("lease not acquired");
			// One event longer than a page is a page of its own; the small ones around it share pages.
			const payloads = Array.from({ length: 8 }, (_, index) =>
				`${index}`.repeat(index === 3 ? JOURNAL_READ_PAGE_CHARS + 1 : index === 4 ? 10 : 600_000),
			);
			for (const [index, payload] of payloads.entries()) {
				await journal.append(outcome.lease, { type: "SummaryRecorded", payload } as RunEvent, {
					key: `k-${index}`,
				});
			}
			const read = await Array.fromAsync(journal.read("run"));
			assert.deepEqual(
				read.map((entry) => entry.event.payload),
				payloads,
			);
			const fromThird = await Array.fromAsync(journal.read("run", 3));
			assert.deepEqual(
				fromThird.map((entry) => entry.seq),
				[3, 4, 5, 6, 7, 8],
			);
			const keyed = await Array.fromAsync(SqlRunJournal.readKeyRange(journal, "run", "k-2", "k-7"));
			assert.deepEqual(
				keyed.map((entry) => entry.key),
				["k-2", "k-3", "k-4", "k-5", "k-6"],
			);
			assert.deepEqual(limited.refused, []);
			await journal.close();
		});
	});
});

describe("a database written with chunked entries is refused by older builds (#4954)", () => {
	/**
	 * What an older build checks when it opens the session tables of a SQLite or libSQL database: every row of the
	 * sessions meta table must hold the one schema version it knows, 1. Postgres records the step in its migration
	 * ledger, which older builds check instead.
	 */
	async function openAsOlderBuild(database: SqliteDatabase): Promise<void> {
		const rows = await database.all<SqliteRow & { schema_version: number }>(
			"SELECT schema_version FROM session_meta",
		);
		for (const row of rows) assertStorageSchemaVersion("sessions", row.schema_version, 1);
	}

	for (const [name, withDatabase] of [
		["SQLite", withNodeSqliteDatabase],
		["libSQL", withLibsqlDatabase],
	] as const) {
		test(`a 2 MB entry written to ${name} cannot be read by an older build as a stub (#4954)`, async () => {
			await withDatabase(async ({ database, reopen }) => {
				const store = await SqlSessionStore.open(database);
				await store.create(header(), [message("big", null, "x".repeat(2 * MiB)), message("small", "big", "small")]);
				const reopened = await reopen();
				await assert.rejects(openAsOlderBuild(reopened), (error: unknown) => {
					assert.ok(error instanceof StorageSchemaVersionError);
					assert.deepEqual([error.domain, error.supported], ["sessions", 1]);
					return true;
				});
				// This build reads it whole, and reopens it again.
				const again = await SqlSessionStore.open(reopened);
				assert.equal(
					(await again.load("session")).entries[0] &&
						JSON.stringify((await again.load("session")).entries[0]).length > 2 * MiB,
					true,
				);
			});
		});
	}

	test("a database with a schema newer than this build is refused (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			await SqlSessionStore.open(database);
			await database.run("UPDATE session_meta SET schema_version = 3");
			await assert.rejects(SqlSessionStore.open(database), (error: unknown) => {
				assert.ok(error instanceof StorageSchemaVersionError);
				assert.deepEqual([error.found, error.supported], [3, 2]);
				return true;
			});
		});
	});

	test("a store opened before a newer build upgraded the database refuses to read or write it (#5065)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.create(header(), [message("m", null, "kept")]);
			// A newer build upgrades the schema while this store is open, as this build did to 0.9.87's.
			await database.run("UPDATE session_meta SET schema_version = 3");
			const refused = (error: unknown) => {
				assert.ok(error instanceof StorageSchemaVersionError);
				assert.deepEqual([error.domain, error.found, error.supported], ["sessions", 3, 2]);
				return true;
			};
			await assert.rejects(store.load("session"), refused);
			await assert.rejects(store.append("session", [message("n", "m", "more")], { expectSeq: 1 }), refused);
			await assert.rejects(store.create(header("other"), [message("o", null, "new")]), refused);
			await assert.rejects(Array.fromAsync(store.list({})), refused);
		});
	});

	test("an open-session marker records the schema version its process reads, for a later upgrade to check (#5065)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.openMarkers!.put("session", { token: "t", pid: process.pid, host: "h" });
			assert.deepEqual(
				(await database.all("SELECT schema_version FROM session_open")).map((row) => Number(row.schema_version)),
				[2],
			);
		});
	});

	test("a database an older build created is upgraded and keeps its sessions (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			await SqlSessionStore.open(database);
			await database.exec("UPDATE session_meta SET schema_version = 1");
			const store = await SqlSessionStore.open(database);
			assert.deepEqual(
				(await database.all("SELECT schema_version FROM session_meta")).map((row) => Number(row.schema_version)),
				[2],
			);
			await store.create(header(), [message("m", null, "kept")]);
			assert.equal((await store.load("session")).entries.length, 1);
		});
	});
});
