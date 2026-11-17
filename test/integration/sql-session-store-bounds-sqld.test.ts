import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_READ_PAGE_CHARS,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { interceptingDatabase } from "../helpers/intercepting-database.js";
import { storageBackends } from "../helpers/storage-backends.js";

const LONG_SESSIONS = 200;
const FIRST_MESSAGE_CHARS = 60_000;
const PAGE_FILLING_CHARS = 600_000;
const CREATE_BATCH = 25;
const FAR_ROW_KEY = 4_000_000;
const LARGE_ENTRY_BYTES = 64 * 1024;
const LISTING_STATEMENTS_FOR_TWO_SESSIONS = 4;
const MANY_SESSIONS_TIMEOUT_MS = 120_000;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-16T00:00:00.000Z", cwd: "/project" };
}

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function textChars(rows: readonly SqliteRow[]): number {
	let chars = 0;
	for (const row of rows) for (const value of Object.values(row)) if (typeof value === "string") chars += value.length;
	return chars;
}

function observed(database: SqliteDatabase) {
	const seen = { observing: false, statements: 0, largestChars: 0 };
	const wrapped = interceptingDatabase(database, {
		all: async (sql, params, next) => {
			const rows = await next(sql, ...params);
			if (seen.observing) {
				seen.statements++;
				seen.largestChars = Math.max(seen.largestChars, textChars(rows));
			}
			return rows;
		},
	});
	return { wrapped, seen };
}

async function listedIds(store: SqlSessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true, withoutSearchText: true })) ids.push(summary.id);
	return ids;
}

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? it : it.skip;
	describe(`listing sessions without search text on ${backend.name} (#5250)`, () => {
		run(
			"returns long listing rows in pages no larger than a listing page (#5250)",
			async () => {
				const scope = await backend.openScope();
				try {
					const { wrapped, seen } = observed(await scope.connect());
					const store = await SqlSessionStore.open(wrapped, { prefix: scope.prefix });
					const ids = Array.from(
						{ length: LONG_SESSIONS },
						(_, position) => `s${String(position).padStart(4, "0")}`,
					);
					for (let start = 0; start < ids.length; start += CREATE_BATCH) {
						await Promise.all(
							ids
								.slice(start, start + CREATE_BATCH)
								.map((id) =>
									store.create(header(id), [message("e1", `${id} ${"x".repeat(FIRST_MESSAGE_CHARS)}`)]),
								),
						);
					}
					seen.observing = true;
					const listed = await listedIds(store);
					seen.observing = false;
					assert.deepEqual([...listed].sort(), ids);
					assert.ok(
						seen.largestChars <= SESSION_READ_PAGE_CHARS + FIRST_MESSAGE_CHARS * 2,
						`one listing statement returned ${seen.largestChars} characters`,
					);
				} finally {
					await scope.close();
				}
			},
			MANY_SESSIONS_TIMEOUT_MS,
		);

		run("lists sessions in a few statements however far apart their row keys are (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const { wrapped, seen } = observed(database);
				const store = await SqlSessionStore.open(wrapped, { prefix: scope.prefix });
				const { sessions } = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				await store.create(header("first"), [message("e1", "first session")]);
				if (dialectOf(database).name === "postgres")
					await database.exec(`ALTER TABLE ${sessions} ALTER COLUMN row_order RESTART WITH ${FAR_ROW_KEY}`);
				else await database.run(`UPDATE ${sessions} SET rowid = ? WHERE id = ?`, FAR_ROW_KEY, "first");
				await store.create(header("second"), [message("e1", "second session")]);
				seen.observing = true;
				const listed = await listedIds(store);
				seen.observing = false;
				assert.deepEqual(listed, ["first", "second"]);
				assert.ok(
					seen.statements <= LISTING_STATEMENTS_FOR_TWO_SESSIONS,
					`listing two sessions took ${seen.statements} statements`,
				);
			} finally {
				await scope.close();
			}
		});

		run("lists each session that existed when the listing started, once (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				for (const id of ["first", "second"])
					await store.create(header(id), [message("e1", `${id} ${"x".repeat(PAGE_FILLING_CHARS)}`)]);
				const listing = store.list({ includeInternal: true, withoutSearchText: true })[Symbol.asyncIterator]();
				const listed: string[] = [];
				const head = await listing.next();
				if (!head.done) listed.push(head.value.id);
				await store.append(listed[0]!, [message("e2", "appended while listing")], { expectSeq: 1 });
				await store.create(header("later"), [message("e1", "created while listing")]);
				for (let next = await listing.next(); !next.done; next = await listing.next()) listed.push(next.value.id);
				assert.deepEqual(listed, ["first", "second"]);
			} finally {
				await scope.close();
			}
		});
	});

	describe(`reading entry ranges on ${backend.name} (#5250)`, () => {
		run("returns an entry stored in chunks whole and skips oversized entries by kind (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const chunked = message("chunked", "x".repeat(SESSION_ENTRY_CHUNK_BYTES + 1_000));
				const typeLater: SessionEntry = {
					id: "type-later",
					parentId: null,
					timestamp: "2026-11-16T00:00:00.000Z",
					type: "custom",
					customType: "snapshot",
					data: "y".repeat(LARGE_ENTRY_BYTES * 3),
				};
				await store.create(header("s"), [message("e1", "small"), chunked, typeLater, message("e4", "small")]);
				const whole = await store.readEntryRange("s", { fromSeq: 2, toSeq: 2 });
				assert.equal(whole.entries[0]?.rawChunks, undefined, "the chunked entry is parsed");
				assert.ok(
					JSON.stringify(whole.entries[0]?.entry) === JSON.stringify(chunked),
					"the chunked entry reads back unchanged",
				);
				const skipped = await store.readEntryRange("s", {
					fromSeq: 1,
					toSeq: 4,
					largeEntryBytes: LARGE_ENTRY_BYTES,
					skipTypes: ["custom"],
				});
				assert.equal(skipped.throughSeq, 4);
				assert.deepEqual(
					skipped.entries.map((item) => [item.seq, item.rawChunks !== undefined]),
					[
						[1, false],
						[2, true],
						[4, false],
					],
				);
			} finally {
				await scope.close();
			}
		});
	});
}
