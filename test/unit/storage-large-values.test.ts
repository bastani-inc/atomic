import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageError, StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
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

import { withLibsqlDatabase } from "../helpers/libsql-database.js";
import { rowLimitedDatabase } from "../helpers/row-limited-database.js";
import { withCallerThreadSqliteDatabase, withNodeSqliteDatabase } from "../helpers/storage-database.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Values larger than a libSQL server takes (#4954), on a SQLite file behind a wrapper that refuses what such a server
 * refuses for size: values over one chunk, and responses over two and a half. Every store must stay within both.
 */

useTemporaryAgentDir();

const MiB = 1024 * 1024;
const LIMITS = { maxValueBytes: MiB, maxResponseBytes: 2.5 * MiB };
const LARGE_LISTING_SCAN_TIMEOUT_MS = 90_000;
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

	test("session pages do not include the entry that would cross the character bound (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, { ...LIMITS, maxResponseBytes: MiB });
			const store = await SqlSessionStore.open(limited.wrapped);
			const entries = Array.from({ length: 5 }, (_, index) =>
				message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, "x".repeat(600_000), "assistant"),
			);
			await store.create(header(), entries);
			assert.deepEqual((await store.load("session")).entries, entries);
			assert.deepEqual(limited.refused, []);
		});
	});

	test("listing pages do not include the session that would cross the character bound (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, { ...LIMITS, maxResponseBytes: MiB });
			const store = await SqlSessionStore.open(limited.wrapped);
			const ids = ["third", "first", "second"];
			for (const id of ids) {
				await store.create(header(id), [
					{
						type: "session_info",
						id: `${id}-name`,
						parentId: null,
						timestamp: createdAt,
						name: "n".repeat(600_000),
					},
				]);
			}
			assert.deepEqual(
				(await list(store)).map((summary) => summary.id),
				ids,
			);
			await store.append("first", [message("m", "first-name", "changed")], { expectSeq: 1 });
			assert.deepEqual(
				(await list(store)).map((summary) => summary.id),
				ids,
			);
			assert.deepEqual(limited.refused, []);
		});
	});

	test("listing pages count text columns that duplicate header fields (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, { ...LIMITS, maxResponseBytes: MiB });
			const store = await SqlSessionStore.open(limited.wrapped);
			const ids = ["first", "second", "third"];
			for (const id of ids) await store.create({ ...header(id), cwd: `/${"x".repeat(300_000)}` }, []);
			assert.deepEqual(
				(await list(store)).map((summary) => summary.id),
				ids,
			);
			assert.deepEqual(limited.refused, []);
		});
	});

	test("listing pages count the separators between search texts (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const limited = rowLimitedDatabase(database, { ...LIMITS, maxResponseBytes: MiB });
			const store = await SqlSessionStore.open(limited.wrapped);
			const ids = ["first", "second"];
			for (const id of ids) {
				await store.create(
					header(id),
					Array.from({ length: 1000 }, (_, index) => message(`${id}-${index}`, null, "x".repeat(521))),
				);
			}
			const summaries = await list(store);
			assert.deepEqual(
				summaries.map((summary) => summary.id),
				ids,
			);
			assert.ok(summaries.every((summary) => summary.searchText === Array(1000).fill("x".repeat(521)).join(" ")));
			assert.deepEqual(limited.refused, []);
		});
	});

	test.each([false, true])("read-only session stores open with orphan chunks present=%s (#4954)", async (orphan) => {
		await withNodeSqliteDatabase(async (subject) => {
			const database = subject.database;
			const store = await SqlSessionStore.open(database);
			const entries = [message("large", null, "x".repeat(2 * MiB))];
			await store.create(header(), entries);
			if (orphan) {
				await database.run(
					"INSERT INTO session_entry_chunks (session_id, seq, idx, data) VALUES (?, ?, ?, ?)",
					"deleted-session",
					1,
					0,
					new Uint8Array([1, 2, 3]),
				);
			}
			const chunksBefore = await count(database, "SELECT count(*) AS n FROM session_entry_chunks");
			const readOnly = await openNodeSqliteDatabase(database.descriptor.location, { readOnly: true });
			try {
				const reader = await SqlSessionStore.open(readOnly);
				assert.deepEqual((await reader.load("session")).entries, entries);
				assert.equal(await count(readOnly, "SELECT count(*) AS n FROM session_entry_chunks"), chunksBefore);
			} finally {
				await readOnly.close();
			}
			const writable = await subject.reopen();
			const reopened = await SqlSessionStore.open(writable);
			assert.deepEqual((await reopened.load("session")).entries, entries);
			assert.equal(
				await count(writable, "SELECT count(*) AS n FROM session_entry_chunks"),
				chunksBefore - Number(orphan),
			);
		});
	});

	test.each([false, true])(
		"session stores open on a wrapped read-only connection with orphan chunks present=%s (#4954)",
		async (orphan) => {
			await withNodeSqliteDatabase(async (subject) => {
				const database = subject.database;
				const store = await SqlSessionStore.open(database);
				const entries = [message("large", null, "x".repeat(2 * MiB))];
				await store.create(header(), entries);
				if (orphan) {
					await database.run(
						"INSERT INTO session_entry_chunks (session_id, seq, idx, data) VALUES (?, ?, ?, ?)",
						"deleted-session",
						1,
						0,
						new Uint8Array([1, 2, 3]),
					);
				}
				const chunksBefore = await count(database, "SELECT count(*) AS n FROM session_entry_chunks");
				const connection = new DatabaseSync(database.descriptor.location, { readOnly: true });
				try {
					const readOnly = wrapNodeSqliteDatabase(connection);
					const reader = await SqlSessionStore.open(readOnly);
					assert.deepEqual((await reader.load("session")).entries, entries);
					assert.equal(await count(readOnly, "SELECT count(*) AS n FROM session_entry_chunks"), chunksBefore);
					await readOnly.close();
				} finally {
					connection.close();
				}
			});
		},
	);

	test("opening a store leaves chunk rows alone once a newer build has upgraded the sessions schema (#5065)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.create(header(), [message("large", null, "x".repeat(2 * MiB))]);
			await database.run(
				"INSERT INTO session_entry_chunks (session_id, seq, idx, data) VALUES (?, ?, ?, ?)",
				"newer-build",
				1,
				0,
				new Uint8Array([1, 2, 3]),
			);
			const get = database.get.bind(database);
			database.get = (async (sql: string, ...params: SqliteValue[]) => {
				const row = await get(sql, ...params);
				if (sql.includes("AS orphaned")) await database.run("UPDATE session_meta SET schema_version = 3");
				return row;
			}) as typeof database.get;
			try {
				await SqlSessionStore.open(database).catch((error: Error) => {
					assert.ok(error instanceof StorageSchemaVersionError, String(error));
				});
			} finally {
				database.get = get;
			}
			assert.equal(
				await count(database, "SELECT count(*) AS n FROM session_entry_chunks WHERE session_id = 'newer-build'"),
				1,
			);
		});
	});

	test("sessions load on SQLite without octet_length, as on macOS 13 (#4954)", async () => {
		const configured = new WeakSet<DatabaseSync>();
		const prepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
			if (!configured.has(this)) {
				configured.add(this);
				this.function("octet_length", (_value) => {
					throw new Error("no such function: octet_length");
				});
			}
			return prepare.call(this, sql);
		} as typeof prepare;
		try {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				const entries = [
					message("first", null, "short"),
					message("large", "first", "😀".repeat(5000)),
					message("last", "large", "short"),
				];
				await store.create(header(), entries);
				assert.deepEqual((await store.load("session")).entries, entries);
			});
		} finally {
			DatabaseSync.prototype.prepare = prepare;
		}
	});

	test("history range reads work on SQLite without octet_length (#5250)", async () => {
		const configured = new WeakSet<DatabaseSync>();
		const prepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
			if (!configured.has(this)) {
				configured.add(this);
				this.function("octet_length", (_value) => {
					throw new Error("no such function: octet_length");
				});
			}
			return prepare.call(this, sql);
		} as typeof prepare;
		try {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				const entries = [
					message("first", null, "short"),
					message("large", "first", "😀".repeat(5000)),
					message("last", "large", "short"),
				];
				await store.create(header(), entries);
				const page = await store.readEntryRange("session", { fromSeq: 1, toSeq: 3 });
				assert.deepEqual(
					page.entries.map((at) => at.entry),
					entries,
				);
				const capped = await store.readEntryRange("session", { fromSeq: 1, toSeq: 3, maxChars: 1 });
				assert.equal(capped.throughSeq, 1);
			});
		} finally {
			DatabaseSync.prototype.prepare = prepare;
		}
	});

	test("open-session markers keep their heartbeat on SQLite without unixepoch subsec, as on macOS 13 (#4971)", async () => {
		const configured = new WeakSet<DatabaseSync>();
		const prepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
			if (!configured.has(this)) {
				configured.add(this);
				this.function("unixepoch", { varargs: true }, (...args) =>
					args.includes("subsec") ? null : Math.floor(Date.now() / 1000),
				);
			}
			return prepare.call(this, sql);
		} as typeof prepare;
		try {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				await store.create(header(), []);
				await store.openMarkers.put("session", { token: "t", pid: 1, host: "h" });
				const markers = await store.openMarkers.list("session");
				assert.deepEqual(
					markers.map((marker) => marker.token),
					["t"],
				);
				assert.ok(markers[0]!.ageMs >= 0 && markers[0]!.ageMs < 60_000, `${markers[0]!.ageMs} ms old`);
				await database.run("UPDATE session_open SET heartbeat_at = heartbeat_at - 120000");
				const [stale] = await store.openMarkers.list("session");
				assert.ok(stale!.ageMs >= 120_000 && stale!.ageMs < 180_000, `${stale!.ageMs} ms old`);
			});
		} finally {
			DatabaseSync.prototype.prepare = prepare;
		}
	});

	test("a long session loads in time linear in its entries, not one scan of the rest per page (#4954)", async () => {
		await withCallerThreadSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const entries = Array.from({ length: 3000 }, (_, index) =>
				message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, `${index} `.repeat(2_000)),
			);
			await store.create(header(), entries);
			const scanned = await countLongValuesMeasured(() => store.load("session"));
			assert.deepEqual(scanned.result.entries, entries);
			assert.ok(scanned.calls <= 8 * entries.length, `${scanned.calls} entry lengths measured`);
		});
	});

	test("single-entry pages shrink their fetches instead of repeatedly measuring large batches (#4954)", async () => {
		await withCallerThreadSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const entries = Array.from({ length: 40 }, (_, index) =>
				message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, "x".repeat(600_000)),
			);
			await store.create(header(), entries);
			const scanned = await countLongValuesMeasured(() => store.load("session"));
			assert.deepEqual(scanned.result.entries, entries);
			assert.ok(scanned.calls <= 4 * entries.length, `${scanned.calls} entry lengths measured`);
		});
	});

	test.each([
		{ layout: "alternate with short entries", long: (index: number) => index % 2 === 0 },
		{ layout: "follow one another", long: (_index: number) => true },
	])(
		"legacy entries longer than a page are measured a bounded number of times when they $layout (#4954)",
		async ({ long }) => {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				const entries = Array.from({ length: 40 }, (_, index) =>
					message(
						`m-${index}`,
						index === 0 ? null : `m-${index - 1}`,
						long(index) ? "x".repeat(1.3 * MiB) : "short",
					),
				);
				await store.create(header(), entries);
				for (const [index, entry] of entries.entries()) {
					if (long(index)) {
						await database.run(
							"UPDATE session_entries SET entry_json = ?, chunks = 0 WHERE seq = ?",
							JSON.stringify(entry),
							index + 1,
						);
					}
				}
				await database.run("DELETE FROM session_entry_chunks");
				const scanned = await countLongValuesMeasured(() => store.load("session"));
				assert.deepEqual(scanned.result.entries, entries);
				assert.ok(scanned.calls <= 4 * entries.length, `${scanned.calls} entry lengths measured`);
			});
		},
	);

	test.each([
		{ entriesCount: 188, firstChars: 2.5 * MiB, maxStatements: 2 },
		{ entriesCount: 1000, firstChars: 100, maxStatements: 1 },
		{ entriesCount: 1024, firstChars: 100, maxStatements: 1 },
	])(
		"$entriesCount entries load without small fetch round trips (#4954)",
		async ({ entriesCount, firstChars, maxStatements }) => {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				const entries = Array.from({ length: entriesCount }, (_, index) =>
					message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, "x".repeat(index === 0 ? firstChars : 100)),
				);
				await store.create(header(), entries);
				await database.run(
					"UPDATE session_entries SET entry_json = ?, chunks = 0 WHERE seq = 1",
					JSON.stringify(entries[0]),
				);
				let statements = 0;
				const prepare = DatabaseSync.prototype.prepare;
				DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
					if (/SELECT[\s\S]*FROM session_entries[\s\S]*ORDER BY seq/.test(sql)) statements++;
					return prepare.call(this, sql);
				} as typeof prepare;
				try {
					assert.deepEqual((await store.load("session")).entries, entries);
				} finally {
					DatabaseSync.prototype.prepare = prepare;
				}
				assert.ok(statements <= maxStatements, `${statements} entry read statements`);
			});
		},
	);

	test(
		"a long listing reads in time linear in its sessions, not one scan of the rest per page (#4954)",
		async () => {
			await withCallerThreadSqliteDatabase(async ({ database }) => {
				await database.exec("PRAGMA synchronous=OFF");
				const store = await SqlSessionStore.open(database);
				const sessions = 600;
				for (let index = 0; index < sessions; index++) {
					const id = `s-${index}`;
					await store.create(header(id), [message(`${id}-1`, null, "x".repeat(SESSION_SUMMARY_TEXT_CHARS))]);
				}
				const scanned = await countLongValuesMeasured(() => list(store));
				assert.deepEqual(
					scanned.result.map((summary) => summary.id),
					Array.from({ length: sessions }, (_, index) => `s-${index}`),
				);
				assert.ok(scanned.calls <= 20 * sessions, `${scanned.calls} listing lengths measured`);
			});
		},
		LARGE_LISTING_SCAN_TIMEOUT_MS,
	);
});

/** Values this long are rows' JSON rather than column names or keys, so their measurements count rows read. */
const LONG_VALUE_CHARS = 10_000;

/**
 * Runs `body` with SQLite's `length()` replaced, on every connection, by one that counts the long values it measures:
 * the session store measures each row it reads for paging, so the count is the rows `body`'s statements scanned. Only
 * connections on this thread see the replacement: tests that count use `withCallerThreadSqliteDatabase` (#5376).
 */
async function countLongValuesMeasured<T>(
	body: () => Promise<T>,
): Promise<{ readonly result: T; readonly calls: number }> {
	let calls = 0;
	const counting = new WeakSet<DatabaseSync>();
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		if (!counting.has(this)) {
			counting.add(this);
			this.function("length", { deterministic: true }, (value) => {
				if (value === null) return null;
				if (typeof value === "string") {
					if (value.length >= LONG_VALUE_CHARS) calls++;
					return [...value].length;
				}
				return value instanceof Uint8Array ? value.byteLength : String(value).length;
			});
		}
		return prepare.call(this, sql);
	} as typeof prepare;
	try {
		return { result: await body(), calls };
	} finally {
		DatabaseSync.prototype.prepare = prepare;
	}
}

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

describe("a database written with chunked entries is refused by older builds (#4954)", () => {
	/**
	 * What an older build checks when it opens the session tables of a SQLite or libSQL database: every row of the
	 * sessions meta table must hold the one schema version it knows, 1. Builds before 2 check the same row on Postgres.
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

	test("a database without chunked entries stays readable by older builds (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			await store.create(header(), [message("m", null, "x".repeat(SESSION_ENTRY_CHUNK_BYTES / 4))]);
			await store.append("session", [message("n", "m", "more")], { expectSeq: 1 });
			await openAsOlderBuild(database);
			await SqlSessionStore.open(database);
			await openAsOlderBuild(database);
			assert.equal((await store.load("session")).entries.length, 2);
		});
	});

	test("an older build's database keeps its version and sessions until a chunked entry is written (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			await SqlSessionStore.open(database);
			await database.exec("UPDATE session_meta SET schema_version = 1");
			const store = await SqlSessionStore.open(database);
			await store.create(header(), [message("m", null, "kept")]);
			await openAsOlderBuild(database);
			await store.append("session", [message("big", "m", "x".repeat(2 * MiB))], { expectSeq: 1 });
			assert.deepEqual(
				(await database.all("SELECT schema_version FROM session_meta")).map((row) => Number(row.schema_version)),
				[2],
			);
			await assert.rejects(openAsOlderBuild(database), StorageSchemaVersionError);
			assert.equal((await store.load("session")).entries.length, 2);
		});
	});

	test("a failed first chunked write rolls back its schema bump and entries (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const kept = message("m", null, "kept");
			const large = message("large", "m", "x".repeat(2 * MiB));
			await store.create(header(), [kept]);
			await database.exec(`CREATE TRIGGER reject_search BEFORE INSERT ON session_search_texts
				BEGIN SELECT RAISE(ABORT, 'rejected search text'); END`);
			await assert.rejects(store.append("session", [large], { expectSeq: 1 }), /rejected search text/);
			await openAsOlderBuild(database);
			assert.deepEqual((await store.load("session")).entries, [kept]);
			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 0);
			await database.exec("DROP TRIGGER reject_search");
			await store.append("session", [large], { expectSeq: 1 });
			await assert.rejects(openAsOlderBuild(database), StorageSchemaVersionError);
			assert.deepEqual((await store.load("session")).entries, [kept, large]);
			await store.delete("session");
			await assert.rejects(openAsOlderBuild(database), StorageSchemaVersionError);
		});
	});

	test("concurrent first chunked writers both commit with one schema upgrade (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const first = await SqlSessionStore.open(database);
			const otherDatabase = await openNodeSqliteDatabase(database.descriptor.location);
			try {
				const second = await SqlSessionStore.open(otherDatabase);
				await openAsOlderBuild(database);
				const firstEntry = message("a", null, "a".repeat(2 * MiB));
				const secondEntry = message("b", null, "b".repeat(2 * MiB));
				await Promise.all([
					first.create(header("first"), [firstEntry]),
					second.create(header("second"), [secondEntry]),
				]);
				await assert.rejects(openAsOlderBuild(database), StorageSchemaVersionError);
				assert.deepEqual((await second.load("first")).entries, [firstEntry]);
				assert.deepEqual((await first.load("second")).entries, [secondEntry]);
			} finally {
				await otherDatabase.close();
			}
		});
	});

	test("a store opened at version 1 keeps working after another store writes the first chunked entry (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const first = await SqlSessionStore.open(database);
			const second = await SqlSessionStore.open(database);
			await second.create(header("big"), [message("b", null, "x".repeat(2 * MiB))]);
			await first.create(header(), [message("m", null, "after")]);
			assert.equal((await first.load("big")).entries.length, 1);
			assert.equal((await Array.fromAsync(first.list({}))).length, 2);
		});
	});

	test("chunked append and create replace leftover entry chunks at the written sequence (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const kept = message("kept", null, "k".repeat(1.5 * MiB));
			const replaced = message("replaced", "kept", "r".repeat(3 * MiB));
			const appended = message("appended", "kept", "a".repeat(1.5 * MiB));
			const recreated = message("recreated", null, "c".repeat(1.5 * MiB));
			await store.create(header("session"), [kept, replaced]);
			await store.create(header("deleted"), [replaced]);
			await database.exec(`
				DELETE FROM session_entries WHERE session_id = 'session' AND seq = 2;
				DELETE FROM session_search_texts WHERE session_id = 'session' AND seq = 2;
				UPDATE session_sessions SET last_seq = 1 WHERE id = 'session';
				DELETE FROM session_entries WHERE session_id = 'deleted';
				DELETE FROM session_search_texts WHERE session_id = 'deleted';
				DELETE FROM session_sessions WHERE id = 'deleted';
			`);

			await store.append("session", [appended], { expectSeq: 1 });
			await store.create(header("deleted"), [recreated]);

			assert.deepEqual((await store.load("session")).entries, [kept, appended]);
			assert.deepEqual((await store.load("deleted")).entries, [recreated]);
			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 6);
		});
	});

	test("opening a store sweeps orphaned entry chunks and preserves live chunked entries (#4954)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const live = message("live", null, "l".repeat(1.5 * MiB));
			const small = message("small", "live", "small");
			const orphaned = message("orphaned", "live", "o".repeat(2 * MiB));
			await store.create(header("live"), [live, orphaned]);
			await store.create(header("deleted"), [orphaned]);
			await database.exec(`
				DELETE FROM session_entries WHERE session_id = 'deleted';
				DELETE FROM session_search_texts WHERE session_id = 'deleted';
				DELETE FROM session_sessions WHERE id = 'deleted';
			`);
			await database.run(
				"UPDATE session_entries SET entry_id = ?, entry_json = ?, chunks = 0 WHERE session_id = 'live' AND seq = 2",
				small.id,
				JSON.stringify(small),
			);
			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 8);

			const reopened = await SqlSessionStore.open(database);

			assert.equal(await count(database, "SELECT count(*) AS n FROM session_entry_chunks"), 2);
			assert.deepEqual((await reopened.load("live")).entries, [live, small]);
		});
	});
});
