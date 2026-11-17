import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import type { SqliteDatabase } from "../src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SESSION_ENTRY_CHUNK_BYTES, SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionEntryAt,
	type SessionRecordHeader,
} from "../src/core/storage/session/types.js";

const CHUNKED_ENTRY_CHARS = SESSION_ENTRY_CHUNK_BYTES + 300_000;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-01T00:00:00.000Z", cwd: "/project" };
}

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function described(item: SessionEntryAt): { seq: number; raw: boolean; json: string } {
	const json =
		item.rawChunks === undefined ? JSON.stringify(item.entry) : Buffer.concat(item.rawChunks).toString("utf8");
	return { seq: item.seq, raw: item.rawChunks !== undefined, json };
}

function summarized(items: readonly { seq: number; raw: boolean; json: string }[]) {
	return items.map(({ seq, raw, json }) => ({ seq, raw, chars: json.length, head: json.slice(0, 48) }));
}

describe("SQL session entry ranges with entries stored in chunks (#5250)", () => {
	let database: SqliteDatabase;
	let store: SqlSessionStore;
	const big = message("big", "x".repeat(CHUNKED_ENTRY_CHARS));
	const entries = [message("first", "small"), big, message("last", "small too")];

	beforeEach(async () => {
		database = await openNodeSqliteDatabase(":memory:");
		store = await SqlSessionStore.open(database);
		await store.create(header("s"), entries);
	});

	afterEach(async () => {
		await store.close();
		await database.close();
	});

	it("returns a chunked entry whole when the query sets no largeEntryBytes (#5250)", async () => {
		const page = await store.readEntryRange("s", { fromSeq: 1, toSeq: 3 });
		const expected = entries.map((entry, index) => ({ seq: index + 1, raw: false, json: JSON.stringify(entry) }));
		const actual = page.entries.map(described);
		assert.equal(page.throughSeq, 3);
		assert.deepEqual(summarized(actual), summarized(expected));
		assert.ok(actual[1]?.json === expected[1]!.json, "the chunked entry reads back unchanged");
	});

	it("returns a chunked entry parsed when it fits the query's largeEntryBytes (#5250)", async () => {
		const page = await store.readEntryRange("s", { fromSeq: 2, toSeq: 2, largeEntryBytes: 8 * 1024 * 1024 });
		const expected = [{ seq: 2, raw: false, json: JSON.stringify(big) }];
		const actual = page.entries.map(described);
		assert.deepEqual(summarized(actual), summarized(expected));
		assert.ok(actual[0]?.json === expected[0]!.json, "the chunked entry reads back unchanged");
	});

	it("returns a chunked entry larger than largeEntryBytes as its UTF-8 JSON (#5250)", async () => {
		const page = await store.readEntryRange("s", { fromSeq: 2, toSeq: 2, largeEntryBytes: 64 * 1024 });
		const expected = [{ seq: 2, raw: true, json: JSON.stringify(big) }];
		const actual = page.entries.map(described);
		assert.deepEqual(summarized(actual), summarized(expected));
		assert.ok(actual[0]?.json === expected[0]!.json, "the raw chunks hold the entry's JSON");
	});
});

describe("SQL session entry ranges that skip entry kinds (#5250)", () => {
	const LARGE_ENTRY_BYTES = 64 * 1024;
	const snapshotData = "x".repeat(LARGE_ENTRY_BYTES * 3);
	const typeLater: SessionEntry = {
		id: "type-later",
		parentId: null,
		timestamp: "2026-11-01T00:00:00.000Z",
		type: "custom",
		customType: "snapshot",
		data: snapshotData,
	};
	const typeFirst: SessionEntry = {
		type: "custom",
		id: "type-first",
		parentId: null,
		timestamp: "2026-11-01T00:00:00.000Z",
		customType: "snapshot",
		data: snapshotData,
	};
	const entries = [message("first", "small"), typeLater, typeFirst, message("last", "small too")];

	it("skips an oversized entry of a skipped kind whatever the order of its keys (#5250)", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(header("s"), entries);
			const skipped = await store.readEntryRange("s", {
				fromSeq: 1,
				toSeq: 4,
				largeEntryBytes: LARGE_ENTRY_BYTES,
				skipTypes: ["custom"],
			});
			assert.equal(skipped.throughSeq, 4);
			assert.deepEqual(
				skipped.entries.map((item) => item.seq),
				[1, 4],
			);
			const kept = await store.readEntryRange("s", {
				fromSeq: 1,
				toSeq: 4,
				largeEntryBytes: LARGE_ENTRY_BYTES,
				skipTypes: ["label"],
			});
			assert.deepEqual(
				summarized(kept.entries.map(described)),
				summarized(
					entries.map((entry, index) => ({
						seq: index + 1,
						raw: index === 1 || index === 2,
						json: JSON.stringify(entry),
					})),
				),
			);
		} finally {
			await store.close();
			await database.close();
		}
	});
});
