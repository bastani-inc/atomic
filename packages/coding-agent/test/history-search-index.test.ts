import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionRecordHeader } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { HISTORY_TEXT_FORMAT } from "../src/core/tools/history-session.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/search-index");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const NUL_SESSION_ENTRIES = 2_000;
const NUL_SEQ = 10;
const NEEDLE_SEQ = 1_500;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT };
}

function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

function countingDatabase(database: SqliteDatabase): { database: SqliteDatabase; entryRows: () => number } {
	let entryRows = 0;
	const observe = (rows: readonly SqliteRow[]) => {
		for (const row of rows) if (typeof row.entry_json === "string") entryRows++;
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const row = await executor.get<T>(sql, ...params);
			observe(row ? [row] : []);
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const rows = await executor.all<T>(sql, ...params);
			observe(rows);
			return rows;
		},
	});
	const counted: SqliteDatabase = new Proxy(database, {
		get(target, key) {
			if (key === "get" || key === "all") return wrap(target)[key];
			if (key === "transaction")
				return <T>(
					body: (tx: SqliteExecutor) => Promise<T>,
					options?: Parameters<SqliteDatabase["transaction"]>[1],
				) => target.transaction((tx) => body(wrap(tx)), options);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { database: counted, entryRows: () => entryRows };
}

function request(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

describe("history:// search index (#5250)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-history-search-index-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("stops issuing candidate windows when its signal aborts (#5250)", async () => {
		const raw = await openNodeSqliteDatabase(join(dir, "cancel-candidates.sqlite"));
		let windows = 0;
		let started!: () => void;
		let release!: () => void;
		const firstWindow = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const database = new Proxy(raw, {
			get(target, key) {
				if (key === "all")
					return async (sql: string, ...params: readonly SqliteValue[]) => {
						if (sql.includes("GROUP BY seq, set_id")) {
							windows++;
							if (windows === 1) {
								started();
								await gate;
							}
						}
						return target.all(sql, ...params);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const store = await SqlSessionStore.open(database);
		try {
			const count = 8193;
			await store.create(
				header("cancel-candidates"),
				Array.from({ length: count }, (_, index) => ({
					type: "custom" as const,
					customType: "filler",
					id: `e${index + 1}`,
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
				})),
			);
			assert.ok(await store.searchIndex?.extend("cancel-candidates", HISTORY_TEXT_FORMAT, 0, count, []));
			const controller = new AbortController();
			const candidates = store.searchIndex!.candidates(
				"cancel-candidates",
				[["alpha", "omega"]],
				1,
				count,
				64,
				undefined,
				controller.signal,
			);
			await firstWindow;
			controller.abort(new Error("stop candidates"));
			release();
			await assert.rejects(candidates, /stop candidates/);
			assert.equal(windows, 1, "cancellation stops before querying the next sequence window");
		} finally {
			release();
			await store.close();
			await raw.close();
		}
	});

	it("keeps Unicode matches of inline case-insensitive patterns after indexing (#5250)", async () => {
		const database = await openNodeSqliteDatabase(join(dir, "inline-case.sqlite"));
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(header("inline-case"), [
				message("e1", "aɤb", BASE),
				message("e2", "another entry", BASE + 1000),
			]);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const pattern = "(?i:aꟋb)";
			const first = (await router.search?.("history://sessions/inline-case", request(pattern))) ?? "";
			assert.match(first, /^history:\/\/sessions\/inline-case:1: aɤb$/m);
			assert.equal((await store.searchIndex?.coverage("inline-case", HISTORY_TEXT_FORMAT))?.indexedSeq, 2);
			assert.equal(await router.search?.("history://sessions/inline-case", request(pattern)), first);
		} finally {
			await store.close();
			await database.close();
		}
	});

	it("indexes a session with a NUL character in an entry, so later searches read only candidates (#5250)", async () => {
		const raw = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
		const { database, entryRows } = countingDatabase(raw);
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(
				header("nul"),
				Array.from({ length: NUL_SESSION_ENTRIES }, (_, index) => {
					const seq = index + 1;
					const text =
						seq === NUL_SEQ ? "before\u0000after" : seq === NEEDLE_SEQ ? "the nul-needle entry" : `filler ${seq}`;
					return message(`e${seq}`, text, BASE + index * 1000);
				}),
			);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const first = (await router.search?.("history://sessions/nul", request("nul-needle"))) ?? "";
			assert.match(first, new RegExp(`^history://sessions/nul:${NEEDLE_SEQ}: the nul-needle entry$`, "m"));
			assert.equal(
				(await store.searchIndex?.coverage("nul", HISTORY_TEXT_FORMAT))?.indexedSeq,
				NUL_SESSION_ENTRIES,
				"the first search indexed the whole session",
			);
			const before = entryRows();
			const second = (await router.search?.("history://sessions/nul", request("nul-needle"))) ?? "";
			assert.equal(second, first);
			assert.ok(entryRows() - before <= 6, `the second search read ${entryRows() - before} stored entries`);
			const nul = (await router.search?.("history://sessions/nul", request("after"))) ?? "";
			assert.match(nul, new RegExp(`^history://sessions/nul:${NUL_SEQ}: before\u0000after$`, "m"));
		} finally {
			await store.close();
			await raw.close();
		}
	});
});
