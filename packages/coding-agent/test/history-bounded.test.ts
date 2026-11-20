import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import { MemorySessionStore, SPILL_BLOCK_BYTES } from "../src/core/storage/session/memory-session-store.js";
import { releasedHistoryFiles } from "../src/core/storage/session/released-history-files.js";
import { summarizeSession } from "../src/core/storage/session/session-summary.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionSearchIndex,
	type SessionSnapshot,
	type SessionStore,
	type SessionSummary,
} from "../src/core/storage/session/types.js";
import { createHistoryRouter, type HistoryBudget } from "../src/core/tools/history-protocol.js";
import { matchLinesInWorker, renderRawEntryInWorker } from "../src/core/tools/history-regex-worker.js";
import {
	cutTextToUtf8Bytes,
	DEFAULT_HISTORY_BUDGET,
	HISTORY_TEXT_FORMAT,
	HistoryDeadlineError,
	oneLine,
} from "../src/core/tools/history-session.js";
import { entryLines } from "../src/core/tools/history-transcript.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import {
	assertFewStalls,
	CPU_CLOCK_STEP_MS,
	cpuMs,
	turnBlockedMs,
	type WatchedTurns,
	watchEventLoopTurns,
} from "./helpers/event-loop-turns.js";

const PROJECT = resolve("/projects/bounded");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const READ_TOOL_LIMIT_CHARS = 50_000;
const EVENT_LOOP_CPU_LIMIT_MS = 120;
const LARGE_SESSION_TIMEOUT_MS = 120_000;
const INDEX_BUILD_ENTRIES = 6_000;
/** Entries of the session whose index writes are slow: a few pages, so a few slow writes. */
const SLOW_WRITE_ENTRIES = 400;
/** How long each slow index write keeps SQLite busy: well past the longest turn the watcher allows. */
const SLOW_WRITE_MS = 200;
const TURN_LIMIT_MS = 10;
const PACED_SESSIONS = 40;
const SLOW_INDEX_QUERY_MS = 4;
const PACED_TURN_LIMIT_MS = 3 * SLOW_INDEX_QUERY_MS;
/** The lowest limit a watched turn is checked against here. */
const WATCHED_TURN_LIMIT_MS = Math.min(TURN_LIMIT_MS, PACED_TURN_LIMIT_MS);
const LONG_SESSION_ENTRIES = 3000;
const LONG_SESSION_SEARCH_ROWS = 100;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT };
}

function message(id: string, role: "user" | "assistant", text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message:
			role === "user"
				? { role, content: text, timestamp: at }
				: ({ role, content: [{ type: "text", text }], timestamp: at } as never),
	};
}

function custom(id: string, at: number): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		customType: "task-completion-intent",
		data: { note: "x".repeat(400) },
	} as SessionEntry;
}

function compaction(id: string, summary: string, at: number): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		summary,
		firstKeptEntryId: null,
		tokensBefore: 1000,
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
				return <T>(body: (tx: SqliteExecutor) => Promise<T>, options?: object) =>
					target.transaction((tx) => body(wrap(tx)), options as never);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { database: counted, entryRows: () => entryRows };
}

/**
 * Holds the event loop for `ms` of wall time. With a CPU clock, also until that clock has advanced `ms`, less
 * `cpuClockStepMs`: a burst the scheduler preempts keeps working until it has used the CPU time, and a coarse clock
 * that charges a whole step early can't end it before `ms` have passed.
 */
function busyFor(ms: number, cpuClock?: () => number, cpuClockStepMs = 0): void {
	const start = performance.now();
	const cpuStart = cpuClock?.() ?? 0;
	while (performance.now() - start < ms || (cpuClock !== undefined && cpuClock() - cpuStart < ms - cpuClockStepMs))
		Math.sqrt(ms);
}

function withSlowIndexQueries(store: SessionStore): { readonly store: SessionStore; readonly queries: () => number } {
	const index = store.searchIndex!;
	let queries = 0;
	const slowIndex: SessionSearchIndex = {
		coverage(...args) {
			queries++;
			busyFor(SLOW_INDEX_QUERY_MS);
			return index.coverage(...args);
		},
		extend(...args) {
			return index.extend(...args);
		},
		candidates(...args) {
			queries++;
			busyFor(SLOW_INDEX_QUERY_MS);
			return index.candidates(...args);
		},
	};
	const slowStore = new Proxy(store, {
		get(target, key) {
			if (key === "searchIndex") return slowIndex;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { store: slowStore, queries: () => queries };
}

function abortingAfterFirstIndexInsert(database: SqliteDatabase, controller: AbortController): SqliteDatabase {
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: async (sql, ...params) => {
			const result = await executor.run(sql, ...params);
			if (sql.includes("search_fts (rowid, body)") && !controller.signal.aborted)
				controller.abort(new Error("stop indexing"));
			return result;
		},
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => executor.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => executor.all<T>(sql, ...params),
	});
	return new Proxy(database, {
		get(target, key) {
			if (key === "transaction")
				return <T>(body: (tx: SqliteExecutor) => Promise<T>, options?: object) =>
					target.transaction((tx) => body(wrap(tx)), options as never);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

interface Opened {
	readonly store: SessionStore;
	readonly entryRows: () => number;
	close(): Promise<void>;
}

async function openSql(dir: string, options: { readonly unsynced?: boolean } = {}): Promise<Opened> {
	const raw = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
	if (options.unsynced === true) await raw.exec("PRAGMA synchronous=OFF");
	const { database, entryRows } = countingDatabase(raw);
	const store = await SqlSessionStore.open(database);
	return {
		store,
		entryRows,
		close: async () => {
			await store.close();
			await raw.close();
		},
	};
}

async function openMemory(): Promise<Opened> {
	return { store: new MemorySessionStore(), entryRows: () => 0, close: async () => {} };
}

async function openJsonl(dir: string): Promise<Opened> {
	const store = await JsonlSessionStore.open(join(dir, "jsonl"));
	return { store, entryRows: () => 0, close: () => store.close() };
}

function withoutWholeLoads(store: SessionStore): SessionStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === "load")
				return async () => {
					throw new Error("history loaded a whole session");
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function historyOver(store: SessionStore, budget?: Partial<HistoryBudget>) {
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => store,
		...(budget === undefined ? {} : { budget }),
	});
	const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
	const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
		result.content.map((block) => block.text ?? "").join("\n");
	const read = async (path: string) =>
		textOf(await createReadToolDefinition(PROJECT).execute("read", { path }, undefined, undefined, ctx as never));
	const search = async (pattern: string, paths: string) =>
		textOf(
			await createSearchToolDefinition(PROJECT).execute(
				"search",
				{ pattern, paths },
				undefined,
				undefined,
				ctx as never,
			),
		);
	const request = (pattern: string, signal?: AbortSignal): InternalSearchRequest => ({
		pattern,
		ignoreCase: false,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
		...(signal === undefined ? {} : { signal }),
	});
	return { router, read, search, request };
}

function numbered(count: number, text: (index: number) => string): SessionEntry[] {
	return Array.from({ length: count }, (_, index) =>
		message(`e${index + 1}`, index % 2 === 0 ? "user" : "assistant", text(index + 1), BASE + index * 1000),
	);
}

/** A statement that makes SQLite count up to `rows`, keeping it busy without touching the disk. */
function countingRows(rows: number): string {
	return `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${rows}) SELECT x FROM n`;
}

/** How many rows `countingRows` needs to keep this machine's SQLite busy for at least `ms`. */
async function countingRowsFor(database: SqliteDatabase, ms: number): Promise<number> {
	const sample = 100_000;
	let fastest = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < 3; attempt++) {
		const started = performance.now();
		await database.get(`SELECT count(*) AS n FROM (${countingRows(sample)})`);
		fastest = Math.min(fastest, performance.now() - started);
	}
	return Math.ceil((sample * ms) / Math.max(fastest, 0.1));
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

describe("history:// stays bounded on very large sessions (#5250)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-history-bounded-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads only the entries of a :N-M range (#5250)", async () => {
		const { store, entryRows, close } = await openSql(dir);
		try {
			await store.create(
				header("big"),
				numbered(2000, (seq) => `entry-${seq} body`),
			);
			const { read } = historyOver(store);
			const before = entryRows();
			const ranged = await read("history://sessions/big:1000-1002");
			for (const seq of [1000, 1001, 1002]) assert.ok(ranged.includes(`entry-${seq} body`), ranged);
			for (const seq of [999, 1003]) assert.ok(!ranged.includes(`entry-${seq} body`), ranged);
			assert.ok(entryRows() - before <= 10, `read ${entryRows() - before} stored entries for a 3-entry range`);
			const raw = await read("history://sessions/big:1001-1001:raw");
			assert.match(raw.split("\n")[0]!, /^## \S+ user$/);
			assert.equal(raw.split("\n").slice(1).join("\n"), "entry-1001 body");
		} finally {
			await close();
		}
	});

	it("expires an idle session discovery and closes its iterator without another history call (#5250)", async () => {
		const store = new MemorySessionStore();
		let closed = 0;
		await store.create(header("first"), [message("e1", "user", "first", BASE)]);
		await store.create(header("second"), [message("e2", "user", "second", BASE)]);
		const tracked = new Proxy(store, {
			get(target, key) {
				if (key === "list")
					return async function* (query: Parameters<SessionStore["list"]>[0]) {
						try {
							yield* target.list(query);
						} finally {
							closed++;
						}
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { router } = historyOver(tracked, { rows: 1 });
			assert.match(await router.read!("history://sessions"), /continue with history:\/\/sessions\?cursor=0\.1/);
			assert.equal(closed, 0);
			await vi.advanceTimersByTimeAsync(60_001);
			assert.equal(closed, 1, "expiry closes the abandoned listing even when history is never called again");
		} finally {
			vi.useRealTimers();
			await store.close();
		}
	});

	it("keeps the last outlined turn when the next page times out (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			await store.create(
				header("big"),
				numbered(2100, (seq) => `task ${seq}`),
			);
			let stalled = true;
			const paged = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return (id: string, query: Parameters<NonNullable<SessionStore["readEntryRange"]>>[1]) => {
							if (stalled && query.fromSeq > 1) return new Promise<never>(() => {});
							return target.readEntryRange(id, { ...query, toSeq: Math.min(query.toSeq, query.fromSeq) });
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const { router } = historyOver(paged, { timeMs: 100 });
			const first = await router.read!("history://sessions/big");
			assert.doesNotMatch(first, /history:\/\/sessions\/big:1-1 \| [^|]+ \| user: task 1/);
			assert.match(first, /time budget ran out/);
			const next = continuation(first);
			assert.ok(next, first);
			stalled = false;
			const rest = await router.read!(next);
			assert.match(rest, /history:\/\/sessions\/big:1-2 \| [^|]+ \| user: task 1(?:\n|$)/);
			assert.match(rest, /history:\/\/sessions\/big:3-4 \| [^|]+ \| user: task 3(?:\n|$)/);
		} finally {
			await store.close();
		}
	});

	describe.each([
		{ name: "SqlSessionStore", open: openSql },
		{ name: "JsonlSessionStore", open: openJsonl },
		{ name: "MemorySessionStore", open: openMemory },
	])("over $name", ({ open }) => {
		it("reads, outlines and searches a long session without loading it whole (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				await store.create(
					header("big"),
					numbered(
						LONG_SESSION_ENTRIES,
						(seq) => `${seq === 2500 ? "the buried needle" : `filler ${seq}`} ${"q".repeat(120)}`,
					),
				);
				const { read } = historyOver(withoutWholeLoads(store));
				assert.ok((await read("history://sessions/big:2499-2501")).includes("the buried needle"));
				assert.match(await read("history://sessions/big"), /3000 entries[\s\S]*\d+ user turns/);
				const { router, request } = historyOver(withoutWholeLoads(store), { rows: LONG_SESSION_SEARCH_ROWS });
				const callBound = 2 * Math.ceil(LONG_SESSION_ENTRIES / LONG_SESSION_SEARCH_ROWS) + 2;
				const visited = new Set<string>();
				const pages: string[] = [];
				for (let url: string | undefined = "history://sessions/big"; url !== undefined; ) {
					assert.ok(pages.length < callBound, `the search did not finish within ${callBound} calls`);
					assert.ok(!visited.has(url), `the search repeated ${url}`);
					visited.add(url);
					const page = (await router.search?.(url, request("buried needle"))) ?? "";
					assert.ok(
						Buffer.byteLength(page) <= DEFAULT_HISTORY_BUDGET.bytes,
						`a page held ${Buffer.byteLength(page)} bytes`,
					);
					pages.push(page);
					url = continuation(page);
				}
				assert.ok(pages.length > 1, "the row allowance split the search into several calls");
				assert.doesNotMatch(pages.at(-1)!, /continue with/);
				const found = pages.join("\n");
				assert.equal(found.match(/^history:\/\/sessions\/big:2500: the buried needle/gm)?.length, 1, found);
			} finally {
				await close();
			}
		});

		it("outlines a session too long to read whole, linking each user turn and compaction to its range (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				const entries: SessionEntry[] = [];
				for (let turn = 1; turn <= 120; turn++) {
					const at = BASE + turn * 10_000;
					entries.push(message(`u${turn}`, "user", `please do task ${turn}`, at));
					entries.push(custom(`c${turn}`, at + 1));
					entries.push(message(`a${turn}`, "assistant", `done with task ${turn}: ${"z".repeat(2000)}`, at + 2));
					if (turn === 60) entries.push(compaction("k60", "the first sixty tasks are finished", at + 3));
				}
				await store.create(header("big"), entries);
				const { read } = historyOver(store);
				const outline = await read("history://sessions/big");
				assert.ok(outline.length < READ_TOOL_LIMIT_CHARS, `outline is ${outline.length} characters`);
				assert.ok(!outline.includes("z".repeat(200)), "the outline does not hold the transcript");
				assert.match(outline, /120 user turns/);
				assert.match(outline, /1 compaction/);
				assert.match(outline, /history:\/\/sessions\/big:\d+-\d+ \| [^|]+ \| compaction: the first sixty tasks/);
				const turnUrl = (turn: number) =>
					new RegExp(
						`(history:\\/\\/sessions\\/big:\\d+-\\d+) \\| [^|]+ \\| user: please do task ${turn}$`,
						"m",
					).exec(outline)?.[1];
				for (const turn of [1, 7, 120]) assert.ok(turnUrl(turn), `outline links turn ${turn}:\n${outline}`);
				const seventh = await read(turnUrl(7)!);
				assert.ok(seventh.includes("please do task 7"));
				assert.ok(seventh.includes("done with task 7: zzz"));
				assert.ok(!seventh.includes("please do task 8"));
				assert.ok(!seventh.includes("please do task 6"));
			} finally {
				await close();
			}
		});

		it("caps the matches shown for one session and says how many more there are (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				await store.create(
					header("big"),
					numbered(200, (seq) => (seq % 5 === 0 ? `marker-hit number ${seq}` : `plain ${seq}`)),
				);
				const { search } = historyOver(store);
				const found = await search("marker-hit", "history://sessions/big");
				const matches = found.split("\n").filter((line) => /^history:\/\/sessions\/big:\d+: /.test(line));
				assert.equal(matches.length, 10, found);
				assert.match(found, /\+30 more in this session/);
			} finally {
				await close();
			}
		});

		it("stops a read at its byte budget and continues exactly where it stopped (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				const entries = numbered(20, (seq) => `${`chunk${seq}-`.repeat(60)}END${seq}`);
				entries[9] = message(
					"e10",
					"assistant",
					Array.from({ length: 80 }, (_, line) => `long-${line}`).join("\n"),
					BASE,
				);
				await store.create(header("big"), entries);
				const { read } = historyOver(store, { bytes: 2_000 });
				let url: string | undefined = "history://sessions/big:1-20";
				const pages: string[] = [];
				while (url !== undefined && pages.length < 50) {
					const page = await read(url);
					assert.ok(Buffer.byteLength(page) <= 2_400, `page of ${Buffer.byteLength(page)} bytes`);
					pages.push(page);
					url = continuation(page);
				}
				assert.equal(url, undefined, "the read finishes");
				const all = pages.join("\n");
				for (let seq = 1; seq <= 20; seq++)
					if (seq !== 10)
						assert.equal(
							all.match(new RegExp(`END${seq}(?!\\d)`, "g"))?.length,
							1,
							`entry ${seq} is read exactly once`,
						);
				const lines = all.split("\n").filter((line) => /^long-\d+$/.test(line));
				assert.deepEqual(
					lines,
					Array.from({ length: 80 }, (_, line) => `long-${line}`),
					"every line of the long entry is read once, in order",
				);
			} finally {
				await close();
			}
		});

		it("stops a search at its row budget and continues from the cursor it returns (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				await store.create(
					header("big"),
					numbered(400, (seq) => (seq === 380 ? "the late needle" : `filler ${seq}`)),
				);
				const { router, request } = historyOver(store, { rows: 50 });
				let url: string | undefined = "history://sessions/big";
				let calls = 0;
				let found = "";
				while (url !== undefined && calls < 40) {
					const output = (await router.search?.(url, request("late needle"))) ?? "";
					calls++;
					if (output.includes("the late needle")) {
						found = output;
						break;
					}
					assert.match(output, /searched entries 1-\d+ of 400|searched entries \d+-\d+ of 400/);
					url = continuation(output);
				}
				assert.ok(calls > 1, "the row budget stops the first call before the needle");
				assert.match(found, /history:\/\/sessions\/big:380: the late needle/);
			} finally {
				await close();
			}
		});

		it("stops when the time budget runs out and says what it covered (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				await store.create(
					header("big"),
					numbered(3000, (seq) => `filler ${seq}`),
				);
				const { router, request } = historyOver(store, { timeMs: 0 });
				const output = (await router.search?.("history://sessions/big", request("needle"))) ?? "";
				assert.match(output, /time budget/);
				assert.ok(continuation(output)?.startsWith("history://sessions/big"), output);
			} finally {
				await close();
			}
		});

		it("stops a search when the tool's signal aborts (#5250)", async () => {
			const { store, close } = await open(dir);
			try {
				await store.create(
					header("big"),
					numbered(20_000, (seq) => `filler line ${seq} ${"y".repeat(200)}`),
				);
				const { router, request } = historyOver(store, { timeMs: 60_000, rows: 10_000_000 });
				const controller = new AbortController();
				const searching = router.search?.(
					"history://sessions/big",
					request("(no)+ such (thing)+", controller.signal),
				);
				setTimeout(() => controller.abort(new Error("stop now")), 5);
				const abortedAt = performance.now();
				await assert.rejects(Promise.resolve(searching), /stop now|abort/i);
				assert.ok(performance.now() - abortedAt < 2_000, "the search stops soon after the abort");
			} finally {
				await close();
			}
		});
	});

	it("prefilters a search through the store's trigram index and loads only the matching entries (#5250)", async () => {
		const { store, entryRows, close } = await openSql(dir);
		try {
			await store.create(
				header("big"),
				numbered(3000, (seq) =>
					[700, 1500, 2900].includes(seq) ? `found the zephyr-needle at ${seq}` : `filler ${seq}`,
				),
			);
			const { router, read, request } = historyOver(store);
			const first = (await router.search?.("history://sessions/big", request("zephyr-ne+dle"))) ?? "";
			assert.deepEqual(
				[...first.matchAll(/^history:\/\/sessions\/big:(\d+): /gm)].map((match) => Number(match[1])),
				[700, 1500, 2900],
			);
			const before = entryRows();
			const second = (await router.search?.("history://sessions/big", request("zephyr-ne+dle"))) ?? "";
			assert.equal(second, first);
			assert.ok(entryRows() - before <= 6, `the second search read ${entryRows() - before} stored entries`);
			assert.ok((await read("history://sessions/big:1500-1500")).includes("zephyr-needle at 1500"));
		} finally {
			await close();
		}
	});

	it("scans a session when its index cannot be queried (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(
				header("big"),
				numbered(400, (seq) => (seq === 321 ? "a rare token here" : `filler ${seq}`)),
			);
			const { router, request } = historyOver(store);
			assert.match((await router.search?.("history://sessions/big", request("rare token"))) ?? "", /big:321: /);
			const index = store.searchIndex!;
			const broken = new Proxy(store, {
				get(target, key) {
					if (key === "searchIndex")
						return {
							coverage: index.coverage.bind(index),
							extend: index.extend.bind(index),
							candidates: async () => {
								throw new Error("the index is unreadable");
							},
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const found =
				(await historyOver(broken).router.search?.("history://sessions/big", request("rare token"))) ?? "";
			assert.match(found, /^history:\/\/sessions\/big:321: a rare token here$/m);
		} finally {
			await close();
		}
	});

	it("stops optional context loading when the row allowance is spent (#5250)", async () => {
		const base = new MemorySessionStore();
		await base.create(
			header("ctx"),
			numbered(100, (seq) => (seq === 50 ? "context target line" : `context filler ${seq}`)),
		);
		let rowsRead = 0;
		const store: SessionStore = new Proxy(base, {
			get(target, key) {
				if (key === "readEntryRange")
					return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
						const page = await target.readEntryRange(...args);
						rowsRead += page.entries.length;
						return page;
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { router } = historyOver(store, { rows: 1 });
		const found =
			(await router.search?.("history://sessions/ctx:50-50", {
				pattern: "context target",
				ignoreCase: false,
				literal: false,
				contextBefore: 40,
				contextAfter: 40,
			})) ?? "";
		assert.match(found, /^history:\/\/sessions\/ctx:50: context target line$/m);
		assert.ok(rowsRead <= 2, `a one-row search read ${rowsRead} entries for its context`);
	});

	it("charges per-session cap notes to the byte budget (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let index = 1; index <= 25; index++)
			await store.create(
				header(`cap-${String(index).padStart(2, "0")}`),
				numbered(12, (seq) => `cap needle ${index}.${seq} ${"x".repeat(120)}`),
			);
		for (const bytes of [40_000, 4_000]) {
			const { router, request } = historyOver(store, { bytes });
			const pages: string[] = [];
			let url: string | undefined = "history://sessions";
			for (let calls = 0; url !== undefined && calls < 40; calls++) {
				const out: string = (await router.search?.(url, request("cap needle"))) ?? "";
				pages.push(out);
				url = /^history:\/\/sessions[^\n]*:0: \[[^\n]*continue with (history:\/\/\S+?)\]$/m.exec(out)?.[1];
			}
			for (const page of pages)
				assert.ok(Buffer.byteLength(page) <= bytes, `a page of ${Buffer.byteLength(page)} bytes against ${bytes}`);
			assert.equal(url, undefined, "the continuation chain ended");
			const searched = new Set(
				[...pages.join("\n").matchAll(/^history:\/\/sessions\/(cap-\d+):\d+: cap needle/gm)].map(
					(match) => match[1],
				),
			);
			assert.equal(searched.size, 25, `${searched.size} sessions searched with a ${bytes}-byte budget`);
			assert.match(pages.join("\n"), /\+\d+ more in this session/);
		}
	});

	it("pins a multi-session search continuation to the session it stopped in (#5250)", async () => {
		const store = new MemorySessionStore();
		const entries = (name: string, at: number) =>
			Array.from({ length: 8 }, (_, index) =>
				message(`${name}-${index + 1}`, "user", `pin needle ${name} ${index + 1}`, at + index * 1000),
			);
		await store.create(header("s-old"), entries("s-old", BASE));
		await store.create(header("s-mid"), entries("s-mid", BASE + 100_000));
		await store.create(header("s-new"), entries("s-new", BASE + 200_000));
		const first = historyOver(store, { rows: 15 });
		const stopped = (await first.router.search?.("history://sessions", first.request("pin needle"))) ?? "";
		const url = /continue with (history:\/\/sessions\?\S+?)\]$/m.exec(stopped)?.[1];
		assert.ok(url, stopped);
		assert.match(stopped, /^history:\/\/sessions\/s-mid:4: pin needle s-mid 4$/m);
		await store.append("s-mid", [message("s-mid-9", "user", "pin needle s-mid 9", BASE + 900_000)], {
			expectSeq: 8,
		});
		const rest = (await historyOver(store).router.search?.(url, first.request("pin needle"))) ?? "";
		const matchesOf = (text: string) =>
			[...text.matchAll(/^history:\/\/sessions\/(s-\w+):(\d+): /gm)].map((match) => `${match[1]}:${match[2]}`);
		const seen = [...matchesOf(stopped), ...matchesOf(rest)];
		const expected = ["s-new", "s-mid", "s-old"].flatMap((name) =>
			Array.from({ length: name === "s-mid" ? 9 : 8 }, (_, index) => `${name}:${index + 1}`),
		);
		assert.deepEqual([...seen].sort(), [...expected].sort(), rest);
	});

	it("says when a multi-line pattern may match past the window it searched (#5250)", async () => {
		const pattern = "(?s)START[\\s\\S]*END";
		const cases: { readonly name: string; readonly middle: SessionEntry[] }[] = [
			{
				name: "long-entry",
				middle: [
					message("m1", "assistant", Array.from({ length: 400 }, () => "y".repeat(49)).join("\n"), BASE + 1),
				],
			},
			{ name: "many-entries", middle: numbered(300, (seq) => `middle ${seq}`) },
		];
		for (const { name, middle } of cases) {
			const store = new MemorySessionStore();
			await store.create(header(name), [
				message("s", "user", "START", BASE),
				...middle,
				message("e", "user", "END", BASE + 2),
			]);
			const { router, request } = historyOver(store);
			const found = (await router.search?.(`history://sessions/${name}`, request(pattern))) ?? "";
			const matched = new RegExp(`^history://sessions/${name}:\\d+: START$`, "m").test(found);
			assert.ok(
				matched || /multi-line matches are searched up to 16 KB of text or 256 entries/.test(found),
				`${name}: the search neither found the match nor said where it stopped looking: ${found}`,
			);
		}
		const small = new MemorySessionStore();
		await small.create(header("small"), [message("s", "user", "START", BASE), message("e", "user", "END", BASE + 2)]);
		const { router, request } = historyOver(small);
		const found = (await router.search?.("history://sessions/small", request(pattern))) ?? "";
		assert.match(found, /^history:\/\/sessions\/small:1: START$/m);
		assert.doesNotMatch(found, /multi-line matches are searched up to/);
	});

	it("searches a store that has no index by scanning it (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(
			header("big"),
			numbered(500, (seq) => (seq === 321 ? "a rare token here" : `filler ${seq}`)),
		);
		const { router, request } = historyOver(store);
		const found = (await router.search?.("history://sessions/big", request("rare token"))) ?? "";
		assert.match(found, /^history:\/\/sessions\/big:321: a rare token here$/m);
	});

	it("shows every matching line of one entry in search results (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(header("big"), [message("e1", "user", "alpha one\nbeta\nalpha two\nalpha three", BASE)]);
		const { search } = historyOver(store);
		const found = await search("alpha", "history://sessions/big");
		for (const line of ["alpha one", "alpha two", "alpha three"])
			assert.ok(found.includes(`history://sessions/big:1: ${line}`), found);
	});

	it("matches literals that fall in different index parts of the same entry (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const prefix = Array.from({ length: 40 }, (_, i) => `intro line ${i} ${"p".repeat(50)}`).join("\n");
			const straddlingLine = `alpha-token ${"m".repeat(3200)} omega-token`;
			await store.create(header("big"), [
				message("e1", "user", `${prefix}\n${straddlingLine}`, BASE),
				...numbered(20, (seq) => `filler ${seq}`),
			]);
			const { router, request } = historyOver(store);
			const cold = (await router.search?.("history://sessions/big", request("alpha-token.*omega-token"))) ?? "";
			assert.match(cold, /^history:\/\/sessions\/big:1: alpha-token/m);
			const warm = (await router.search?.("history://sessions/big", request("alpha-token.*omega-token"))) ?? "";
			assert.equal(warm, cold);
		} finally {
			await close();
		}
	});

	it("invalidates the search index when a session is rewritten with the same entry ids (#5250)", async () => {
		const dbPath = join(dir, "rewrite.sqlite");
		const database = await openNodeSqliteDatabase(dbPath);
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(header("big"), [
				message("e1", "user", "oldneedle-value", BASE),
				message("e2", "assistant", "unchanged-tail", BASE + 1000),
			]);
			const { router, request } = historyOver(store);
			assert.match(
				(await router.search?.("history://sessions/big", request("oldneedle-value"))) ?? "",
				/big:1: oldneedle-value/,
			);
			const replaced = message("e1", "user", "newneedle-value", BASE);
			const tail = message("e2", "assistant", "unchanged-tail", BASE + 1000);
			await database.transaction(async (tx) => {
				await tx.run("DELETE FROM session_entries WHERE session_id = 'big'");
				await tx.run(
					"INSERT INTO session_entries (session_id, seq, entry_id, entry_json, chunks) VALUES ('big', 1, 'e1', ?, 0), ('big', 2, 'e2', ?, 0)",
					JSON.stringify(replaced),
					JSON.stringify(tail),
				);
				await tx.run("UPDATE session_sessions SET revision = 'rewritten-by-older-build' WHERE id = 'big'");
			});
			assert.equal(await router.search?.("history://sessions/big", request("oldneedle-value")), "");
			assert.match(
				(await router.search?.("history://sessions/big", request("newneedle-value"))) ?? "",
				/^history:\/\/sessions\/big:1: newneedle-value$/m,
			);
		} finally {
			await store.close();
			await database.close();
		}
	});

	it("matches multi-line patterns across entries identically whether cold or indexed (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(header("big"), [
				message("e1", "user", "alpha-start", BASE),
				message("e2", "user", "omega-end", BASE + 1000),
			]);
			const { router, request } = historyOver(store);
			const pattern = "alpha-start\\n## [^\\n]* user\\nomega-end";
			const cold = (await router.search?.("history://sessions/big", request(pattern))) ?? "";
			assert.match(cold, /^history:\/\/sessions\/big:1: alpha-start$/m);
			assert.match(cold, /^history:\/\/sessions\/big-2- omega-end$/m);
			await router.search?.("history://sessions/big", request("alpha-start"));
			const warm = (await router.search?.("history://sessions/big", request(pattern))) ?? "";
			assert.equal(warm, cold);
		} finally {
			await close();
		}
	});

	it("includes context lines from neighbouring entries in both cold and indexed searches (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(header("big"), [
				message("e1", "user", "first-turn-context", BASE),
				message("e2", "assistant", "target-match-line", BASE + 1000),
				message("e3", "user", "third-turn-context", BASE + 2000),
			]);
			const { router } = historyOver(store);
			const req: InternalSearchRequest = {
				pattern: "target-match-line",
				ignoreCase: false,
				literal: false,
				contextBefore: 2,
				contextAfter: 2,
			};
			const cold = (await router.search?.("history://sessions/big", req)) ?? "";
			assert.match(cold, /^history:\/\/sessions\/big-1- first-turn-context$/m);
			assert.match(cold, /^history:\/\/sessions\/big:2: target-match-line$/m);
			assert.match(cold, /^history:\/\/sessions\/big-3- third-turn-context$/m);
			const warm = (await router.search?.("history://sessions/big", req)) ?? "";
			assert.equal(warm, cold);
		} finally {
			await close();
		}
	});

	it("advances through intra-entry matches via the +N more continuation cursor (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const text = Array.from({ length: 25 }, (_, i) => `intra-hit-${i + 1}`).join("\n");
			await store.create(header("big"), [message("e1", "user", text, BASE)]);
			const { router, request } = historyOver(store);
			const collected: string[] = [];
			let url: string | undefined = "history://sessions/big";
			for (let calls = 0; url !== undefined && calls < 10; calls++) {
				const out: string = (await router.search?.(url, request("intra-hit-\\d+"))) ?? "";
				for (const match of out.matchAll(/^history:\/\/sessions\/big:1: (intra-hit-\d+)$/gm)) {
					collected.push(match[1]!);
				}
				url = /search (history:\/\/\S+) for them\]$/m.exec(out)?.[1];
			}
			assert.equal(url, undefined);
			assert.deepEqual(
				collected,
				Array.from({ length: 25 }, (_, i) => `intra-hit-${i + 1}`),
			);
		} finally {
			await close();
		}
	});

	it("makes forward progress when the first entry's matches exceed the byte budget (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const text = Array.from({ length: 8 }, (_, i) => `budget-hit-${i + 1} ${"x".repeat(180)}`).join("\n");
			await store.create(header("big"), [message("e1", "user", text, BASE)]);
			const { router, request } = historyOver(store, { bytes: 900 });
			const collected: string[] = [];
			let url: string | undefined = "history://sessions/big";
			for (let calls = 0; url !== undefined && calls < 20; calls++) {
				const out = (await router.search?.(url, request("budget-hit-\\d+"))) ?? "";
				for (const match of out.matchAll(/^history:\/\/sessions\/big:1: (budget-hit-\d+)/gm)) {
					collected.push(match[1]!);
				}
				url = continuation(out);
			}
			assert.equal(url, undefined);
			assert.deepEqual(
				collected,
				Array.from({ length: 8 }, (_, i) => `budget-hit-${i + 1}`),
			);
		} finally {
			await close();
		}
	});

	it("preserves :N-M range bounds and reports accurate coverage on ranged search continuations (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(
				header("big"),
				numbered(50, (seq) => `ranged-needle at ${seq}`),
			);
			const { router, request } = historyOver(store, { rows: 4 });
			const matchedSeqs: number[] = [];
			let url: string | undefined = "history://sessions/big:10-18";
			for (let calls = 0; url !== undefined && calls < 20; calls++) {
				const out = (await router.search?.(url, request("ranged-needle"))) ?? "";
				for (const match of out.matchAll(/^history:\/\/sessions\/big:(\d+): /gm)) {
					const seq = Number(match[1]);
					if (seq > 0) matchedSeqs.push(seq);
				}
				const cov = /^history:\/\/sessions\/big:0: \[searched entries (\d+)-(\d+) of 50/m.exec(out);
				if (cov) {
					assert.ok(Number(cov[1]) >= 10, `coverage start ${cov[1]} must be >= 10:\n${out}`);
					assert.ok(Number(cov[2]) <= 18, `coverage end ${cov[2]} must be <= 18:\n${out}`);
				}
				url = continuation(out);
			}
			assert.equal(url, undefined);
			assert.deepEqual(matchedSeqs, [10, 11, 12, 13, 14, 15, 16, 17, 18]);
		} finally {
			await close();
		}
	});

	it("wraps oversized headings and cuts lines to fit small byte budgets (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const hugeName = `name-${"N".repeat(150_000)}-end`;
			await store.create(header("big"), [
				{
					type: "session_info",
					id: "info1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					name: hugeName,
				} as SessionEntry,
			]);
			const { read } = historyOver(store);
			const firstPage = await read("history://sessions/big");
			assert.ok(firstPage.length < READ_TOOL_LIMIT_CHARS);
			assert.ok(!firstPage.includes("File read blocked"));

			const { read: tinyRead } = historyOver(store, { bytes: 800 });
			let url: string | undefined = "history://sessions/big:1-1:raw";
			const pieces: string[] = [];
			for (let calls = 0; url !== undefined && calls < 400; calls++) {
				const page = await tinyRead(url);
				assert.ok(Buffer.byteLength(page, "utf8") <= 900, `page was ${Buffer.byteLength(page, "utf8")} bytes`);
				const lines = page.split("\n");
				const last = lines.at(-1) ?? "";
				const body = last.startsWith("[read ") ? lines.slice(0, -1).join("") : lines.join("");
				pieces.push(body);
				url = continuation(page);
			}
			assert.equal(url, undefined);
			assert.ok(pieces.join("").includes(hugeName));
		} finally {
			await close();
		}
	});

	it(
		"reads, outlines and searches a 25 MB entry without blocking the event loop (#5250)",
		async () => {
			const { store, close } = await openSql(dir, { unsynced: true });
			try {
				const hugeText = `${Array.from({ length: 400_000 }, (_, i) => `row-${i} ${"x".repeat(52)}`).join("\n")}\n25mb-tail-needle`;
				await store.create(header("big"), [
					{
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: new Date(BASE).toISOString(),
						message: {
							role: "toolResult",
							toolCallId: "c1",
							toolName: "bash",
							content: [{ type: "text", text: hugeText }],
							isError: false,
							timestamp: BASE,
						},
					} as never,
				]);
				const { router, read, request } = historyOver(store);
				const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
				let turns: WatchedTurns;
				try {
					const page = await read("history://sessions/big:1-1");
					assert.ok(page.includes("row-0 "));
					assert.ok(continuation(page));
					const outline = await read("history://sessions/big");
					assert.match(outline, /1 tool result/);
					const found = (await router.search?.("history://sessions/big", request("25mb-tail-needle"))) ?? "";
					assert.match(found, /^history:\/\/sessions\/big:1: 25mb-tail-needle$/m);
				} finally {
					turns = await stopWatching();
				}
				assertFewStalls(turns, TURN_LIMIT_MS, "reading and searching a 25 MB entry");
			} finally {
				await close();
			}
		},
		LARGE_SESSION_TIMEOUT_MS,
	);

	it("honours row and time budgets on bare reads of small sessions (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(
				header("small"),
				numbered(30, (seq) => `small-entry-${seq}`),
			);
			const byRows = await historyOver(store, { rows: 5 }).read("history://sessions/small");
			assert.match(byRows, /the row budget ran out; continue with history:\/\/sessions\/small:6-30/);
			const rest = await historyOver(store).read(continuation(byRows)!);
			assert.ok(rest.includes("small-entry-30"));

			const byTime = await historyOver(store, { timeMs: 0 }).read("history://sessions/small");
			assert.match(byTime, /the time budget ran out; continue with history:\/\/sessions\/small:2-30/);
		} finally {
			await close();
		}
	});

	it("streams large session outlines in linear entry reads across pages (#5250)", async () => {
		const { store, entryRows, close } = await openSql(dir);
		try {
			await store.create(
				header("big"),
				numbered(600, (seq) => `turn-entry-${seq}`),
			);
			const { read } = historyOver(store, { bytes: 2_500 });
			const before = entryRows();
			let url: string | undefined = "history://sessions/big";
			const seenTurns: number[] = [];
			for (let calls = 0; url !== undefined && calls < 60; calls++) {
				const page = await read(url);
				for (const match of page.matchAll(/user: turn-entry-(\d+)$/gm)) {
					seenTurns.push(Number(match[1]));
				}
				url = continuation(page);
			}
			const totalRead = entryRows() - before;
			assert.equal(url, undefined);
			assert.equal(seenTurns.length, 300);
			assert.ok(totalRead <= 1_400, `streaming outline read ${totalRead} entries for 600 entries`);
		} finally {
			await close();
		}
	});

	it("refuses a store without readEntryRange instead of loading the whole session (#5250)", async () => {
		let loadCalls = 0;
		const snapshot: SessionSnapshot = {
			header: header("s1"),
			entries: [message("e1", "user", "hello", BASE)],
			lastSeq: 1,
		};
		const legacyOnlyStore: SessionStore = {
			descriptor: { adapter: "no-range-double", location: "memory" },
			create: async () => ({ lastSeq: 1 }),
			append: async () => ({ lastSeq: 1 }),
			replace: async () => ({ lastSeq: 1 }),
			load: async () => {
				loadCalls++;
				throw new Error("whole load must not be called");
			},
			readHeader: async (id) => (id === "s1" ? snapshot.header : undefined),
			delete: async () => {},
			async *list(): AsyncIterable<SessionSummary> {
				yield summarizeSession(snapshot);
			},
			findMostRecent: async () => undefined,
			close: async () => {},
		};
		const { read, search } = historyOver(legacyOnlyStore);
		assert.match(await read("history://sessions"), /history:\/\/sessions\/s1/);
		await assert.rejects(read("history://sessions/s1"), /does not implement SessionStore\.readEntryRange/);
		await assert.rejects(read("history://sessions/s1:1-1"), /does not implement SessionStore\.readEntryRange/);
		await assert.rejects(search("hello", "history://sessions/s1"), /does not implement SessionStore\.readEntryRange/);
		assert.match(await search("hello", "history://sessions"), /1 unreadable/);
		assert.equal(loadCalls, 0);
	});

	it("reads only the requested slice of a spilled MemorySessionStore session (#5250)", async () => {
		const baseFiles = releasedHistoryFiles(dir);
		let fullReads = 0;
		let rangeBytesRead = 0;
		const store = new MemorySessionStore(undefined, {
			report: (err) => baseFiles.report(err),
			async createDirectory() {
				const created = await baseFiles.createDirectory();
				if ("code" in created) return created;
				return {
					...created,
					async read(file) {
						fullReads++;
						return created.read(file);
					},
					async readRange(file, position, length) {
						rangeBytesRead += length;
						return created.readRange!(file, position, length);
					},
				};
			},
		});
		try {
			await store.create(
				header("spilled"),
				numbered(2000, (seq) => `spilled-entry-${seq} ${"z".repeat(200)}`),
			);
			await store.releaseSession("spilled");
			await store.append("spilled", [message("e2001", "user", "tail-2001", BASE + 2_001_000)], { expectSeq: 2000 });
			const { read } = historyOver(store);
			assert.match(await read("history://sessions"), /history:\/\/sessions\/spilled/);
			assert.equal(fullReads, 0, "listing without search text must not read the spill file");
			const slice = await read("history://sessions/spilled:250-251");
			assert.ok(slice.includes("spilled-entry-250"));
			assert.ok(slice.includes("spilled-entry-251"));
			assert.equal(fullReads, 0, "ranged read must not read the whole spill file");
			assert.ok(
				rangeBytesRead > 0 && rangeBytesRead <= 2 * SPILL_BLOCK_BYTES,
				`read ${rangeBytesRead} spilled bytes`,
			);
			assert.ok(store.historyBytes().onDisk > 4 * SPILL_BLOCK_BYTES);
		} finally {
			await store.close();
		}
	});

	it("budgets and aborts session discovery, resuming across calls and preserving query parameters (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			for (let i = 1; i <= 40; i++) {
				const at = BASE + i * 60_000;
				await store.create(
					{ id: `s-${i}`, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
					[message(`m-${i}`, "user", `session ${i} first message`, at)],
				);
			}
			const { read } = historyOver(store, { rows: 15 });
			let url: string | undefined = "history://sessions?limit=10&offset=5";
			let finalListing = "";
			let calls = 0;
			while (url !== undefined && calls < 10) {
				const out = await read(url);
				calls++;
				if (out.includes("sessions so far")) {
					url = continuation(out);
					assert.ok(url?.includes("limit=10"), url);
					assert.ok(url?.includes("offset=5"), url);
				} else {
					finalListing = out;
					break;
				}
			}
			assert.ok(calls >= 3, `expected parked discovery across calls, took ${calls}`);
			assert.match(finalListing, /# sessions 6-15 of 40/);

			const bytePaged = historyOver(store, { bytes: 500 });
			const firstLines = await bytePaged.read("history://sessions?project=all&limit=10&offset=2");
			const cont = continuation(firstLines);
			assert.ok(cont, firstLines);
			assert.ok(cont.includes("project=all"), cont);
			assert.ok(cont.includes("limit=10"), cont);
			assert.ok(cont.includes("offset=2"), cont);
			const nextLines = await bytePaged.read(cont);
			assert.match(nextLines, /history:\/\/sessions\/s-\d+\?project=all/);

			const controller = new AbortController();
			controller.abort(new Error("abort listing"));
			await assert.rejects(
				Promise.resolve(
					historyOver(store).router.readSelected?.("history://sessions", { signal: controller.signal }),
				),
				/abort listing/i,
			);
		} finally {
			await close();
		}
	});

	it("aborts and bounds catastrophic backtracking regexes without blocking the event loop (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(header("redos"), [
			message("e1", "user", `${"a".repeat(28)}!`, BASE),
			message("e2", "assistant", "safe-tail", BASE + 1000),
		]);
		const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
		let turns: WatchedTurns;
		try {
			const controller = new AbortController();
			const { router, request } = historyOver(store, { timeMs: 10_000 });
			const started = performance.now();
			const searching = router.search?.("history://sessions/redos", request("(?=a)(a+)+b", controller.signal));
			setTimeout(() => controller.abort(new Error("abort redos")), 20);
			await assert.rejects(Promise.resolve(searching), /abort redos/i);
			assert.ok(performance.now() - started < 1_000, "catastrophic regex aborted promptly");

			const timed = historyOver(store, { timeMs: 30 });
			const out = (await timed.router.search?.("history://sessions/redos", timed.request("(?=a)(a+)+b"))) ?? "";
			assert.match(out, /time budget/);
			assert.ok(continuation(out)?.includes("cursor=2"), out);
		} finally {
			turns = await stopWatching();
		}
		const longest = Math.max(0, ...turns.blockedMs);
		assert.ok(longest < EVENT_LOOP_CPU_LIMIT_MS, `the event loop was busy for ${Math.round(longest)} ms`);
	});

	it("stops at the time budget when a store read or search index call stalls or never settles (#5250)", async () => {
		const base = new MemorySessionStore();
		await base.create(
			header("stalled"),
			numbered(10, (seq) => `stalled-entry-${seq}`),
		);
		let stallReads = false;
		const stalledCall = () =>
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled store finally failed")), 2_000));
		const stalledIndex: SessionSearchIndex = {
			coverage: () => stalledCall(),
			extend: () => stalledCall(),
			candidates: () => stalledCall(),
		};
		const store: SessionStore = new Proxy(base, {
			get(target, key) {
				if (key === "readEntryRange") {
					return (...args: Parameters<MemorySessionStore["readEntryRange"]>) =>
						stallReads ? stalledCall() : target.readEntryRange(...args);
				}
				if (key === "searchIndex") return stallReads ? stalledIndex : undefined;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { router, read, request } = historyOver(store, { timeMs: 60 });
		stallReads = true;
		const t0 = performance.now();
		const rangedOut = await read("history://sessions/stalled:1-3");
		assert.ok(performance.now() - t0 < 1_000, "stalled ranged read stopped at the deadline");
		assert.match(rangedOut, /time budget/);
		assert.match(rangedOut, /continue with history:\/\/sessions\/stalled:1-3/);

		const t1 = performance.now();
		const searchOut = (await router.search?.("history://sessions/stalled:2-5", request("stalled-entry"))) ?? "";
		assert.ok(performance.now() - t1 < 1_000, "stalled search stopped at the deadline");
		assert.match(searchOut, /time budget/);
		assert.match(searchOut, /continue with history:\/\/sessions\/stalled\?cursor=2:2-5/);
	});

	it("keeps the incoming mid-entry cursor when a ranged read times out waiting for the store (#5250)", async () => {
		const base = new MemorySessionStore();
		await base.create(header("midway"), [
			message("e1", "user", "first entry", BASE),
			message(
				"e2",
				"assistant",
				Array.from({ length: 20 }, (_, line) => `midway-line-${line}`).join("\n"),
				BASE + 1000,
			),
		]);
		const store: SessionStore = new Proxy(base, {
			get(target, key) {
				if (key === "readEntryRange") return () => new Promise<never>(() => {});
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { read } = historyOver(store, { timeMs: 20 });
		const stopped = await read("history://sessions/midway?cursor=2.9:2-2");
		assert.match(stopped, /time budget/);
		assert.equal(continuation(stopped), "history://sessions/midway?cursor=2.9:2-2");
	});

	it("fences stale search index extensions across concurrent rewrites and sid reuse (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(header("s1"), [
				message("e1", "user", "OLD_TEXT_MARKER", BASE),
				message("e2", "assistant", "tail", BASE + 1000),
			]);
			const index = store.searchIndex!;
			const cov = await index.coverage("s1", 2);
			assert.ok(cov);

			await store.replace(
				"s1",
				header("s1"),
				[message("e1", "user", "NEW_MARKER_VALUE", BASE), message("e2", "assistant", "tail", BASE + 1000)],
				{ expectSeq: 2 },
			);
			const staleCreated = await index.extend(
				"s1",
				2,
				0,
				2,
				[
					{ seq: 1, text: "OLD_TEXT_MARKER" },
					{ seq: 2, text: "tail" },
				],
				{ generation: cov.generation, revision: cov.revision },
			);
			assert.equal(staleCreated, false, "stale revision before first extend must be rejected");

			const freshCov = await index.coverage("s1", 2);
			assert.ok(freshCov);
			assert.equal(
				await index.extend("s1", 2, 0, 1, [{ seq: 1, text: "NEW_MARKER_VALUE" }], {
					generation: freshCov.generation,
					revision: freshCov.revision,
				}),
				true,
			);
			const activeCov = await index.coverage("s1", 2);
			assert.ok(activeCov?.generation);
			await store.delete("s1");
			await store.create(header("s1"), [
				message("e1", "user", "SECOND_LIFE_MARKER", BASE),
				message("e2", "assistant", "tail", BASE + 1000),
			]);
			const lifeCov = await index.coverage("s1", 2);
			assert.equal(
				await index.extend("s1", 2, 0, 1, [{ seq: 1, text: "SECOND_LIFE_MARKER" }], {
					generation: lifeCov?.generation,
					revision: lifeCov?.revision,
				}),
				true,
			);
			const staleExtend = await index.extend(
				"s1",
				2,
				1,
				2,
				[{ seq: 2, text: `OLD_BATCH_TEXT ${"z".repeat(20_000)}` }],
				{ generation: activeCov.generation },
			);
			assert.equal(staleExtend, false, "extend with a generation from before sid reuse must be rejected");
			assert.deepEqual(await index.candidates("s1", [["OLD_BATCH_TEXT"]], 1, 2, 10), []);
			assert.equal(await index.candidates("s1", [["SECOND_LIFE"]], 1, 2, 10, activeCov.generation), undefined);
		} finally {
			await close();
		}
	});

	it("keeps oversized entries searchable through the index without truncating them (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(header("oversized"), [
				message("e1", "user", "first entry", BASE),
				message("e2", "assistant", "oversized-tail-needle-token", BASE + 1000),
			]);
			const index = store.searchIndex!;
			const cov = await index.coverage("oversized", 2);
			assert.equal(
				await index.extend(
					"oversized",
					2,
					0,
					2,
					[
						{ seq: 1, text: "## 2026-11-01T00:00:00.000Z user\nfirst entry" },
						{ seq: 2, oversized: true },
					],
					{ generation: cov?.generation, revision: cov?.revision },
				),
				true,
			);
			const { router, request } = historyOver(store);
			const found = (await router.search?.("history://sessions/oversized", request("oversized-tail-needle"))) ?? "";
			assert.match(found, /^history:\/\/sessions\/oversized:2: oversized-tail-needle-token$/m);
		} finally {
			await close();
		}
	});

	it("keeps the index's delete trigger for other writers when the first index write rolls back (#5250)", async () => {
		const raw = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
		const controller = new AbortController();
		const store = await SqlSessionStore.open(abortingAfterFirstIndexInsert(raw, controller));
		try {
			await store.create(header("rolled"), [message("e1", "user", "ROLLED_BACK_NEEDLE", BASE)]);
			const index = store.searchIndex!;
			const texts = [
				{ seq: 1, text: "ROLLED_BACK_NEEDLE" },
				{ seq: 1, text: "ROLLED_BACK_NEEDLE again" },
			];
			await assert.rejects(
				index.extend("rolled", HISTORY_TEXT_FORMAT, 0, 1, texts, { signal: controller.signal }),
				/stop indexing/,
			);
			assert.equal(await index.extend("rolled", HISTORY_TEXT_FORMAT, 0, 1, texts), true);
			assert.deepEqual(await index.candidates("rolled", [["ROLLED_BACK"]], 1, 1, 10), [1]);
			await raw.run("DELETE FROM session_entries WHERE session_id = ?", "rolled");
			assert.equal(
				await raw.get("SELECT session_id FROM session_search_state WHERE session_id = ?", "rolled"),
				undefined,
				"deleting the session's entries outside this store left its index behind",
			);
		} finally {
			await store.close();
			await raw.close();
		}
	});

	it("stops index writes on abort and replaces partial FTS rows idempotently (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			await store.create(header("abort-idx"), [message("e1", "user", "FINAL_CLEAN_NEEDLE", BASE)]);
			const index = store.searchIndex!;
			const controller = new AbortController();
			const manyDocs = Array.from({ length: 30 }, (_, i) => ({
				seq: i + 1,
				text: `ABORTED_DOC_${i} ${"w".repeat(3_500)}`,
			}));
			setTimeout(() => controller.abort(new Error("stop indexing")), 1);
			await assert.rejects(
				index.extend("abort-idx", 2, 0, 1, manyDocs, { signal: controller.signal }),
				/stop indexing|abort/i,
			);
			const cov = await index.coverage("abort-idx", 2);
			assert.equal(cov?.indexedSeq, 0);
			assert.equal(
				await index.extend("abort-idx", 2, 0, 1, [{ seq: 1, text: "FINAL_CLEAN_NEEDLE" }], {
					generation: cov?.generation,
					revision: cov?.revision,
				}),
				true,
			);
			assert.deepEqual(await index.candidates("abort-idx", [["FINAL_CLEAN"]], 1, 1, 10), [1]);
			assert.deepEqual(await index.candidates("abort-idx", [["ABORTED_DOC_0"]], 1, 1, 10), []);
		} finally {
			await close();
		}
	});

	it("matches multi-line patterns past line 600 of an entry, across 11 small entries, and across slice boundaries once (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const deepLines = Array.from({ length: 700 }, (_, i) => (i === 650 ? "LATE_MATCH" : `line-${i}`)).join("\n");
			await store.create(header("deep"), [message("e1", "user", deepLines, BASE)]);
			const { router, request } = historyOver(store);
			const late = (await router.search?.("history://sessions/deep", request("(?m)^LATE_MATCH$"))) ?? "";
			assert.match(late, /^history:\/\/sessions\/deep:1: LATE_MATCH$/m);

			const elevenEntries = Array.from({ length: 12 }, (_, i) =>
				message(
					`s${i + 1}`,
					"user",
					i === 0 ? "START_MATCH" : i === 11 ? "END_MATCH" : `mid-${i}`,
					BASE + i * 1000,
				),
			);
			await store.create(header("span11"), elevenEntries);
			const spanned =
				(await router.search?.("history://sessions/span11", request("(?s)START_MATCH.*END_MATCH"))) ?? "";
			assert.match(spanned, /^history:\/\/sessions\/span11:1: START_MATCH$/m);
			assert.match(spanned, /^history:\/\/sessions\/span11-12- END_MATCH$/m);

			const boundaryLines = Array.from({ length: 660 }, (_, i) =>
				i === 648 ? "SLICE_BOUNDARY_HEAD" : i === 649 ? "SLICE_BOUNDARY_TAIL" : `pad-${i}-${"p".repeat(90)}`,
			).join("\n");
			await store.create(header("straddle"), [message("b1", "user", boundaryLines, BASE)]);
			const straddled =
				(await router.search?.(
					"history://sessions/straddle",
					request("SLICE_BOUNDARY_HEAD\\nSLICE_BOUNDARY_TAIL"),
				)) ?? "";
			const hits = straddled
				.split("\n")
				.filter((line) => line.startsWith("history://sessions/straddle:1: SLICE_BOUNDARY_HEAD"));
			assert.equal(hits.length, 1, straddled);

			const resumed =
				(await router.search?.("history://sessions/deep?cursor=1.0.600", request("(?m)^LATE_MATCH$"))) ?? "";
			assert.match(resumed, /^history:\/\/sessions\/deep:1: LATE_MATCH$/m);
		} finally {
			await close();
		}
	});

	it("streams only the requested range of a cached JSONL session and reads unconverted legacy sessions without converting them (#5250)", async () => {
		const jsonlDir = join(dir, "jsonl-fast");
		const jsonlStore = await JsonlSessionStore.open(jsonlDir);
		try {
			await jsonlStore.create(
				header("j1"),
				numbered(600, (seq) => `jsonl-entry-${seq} ${"k".repeat(200)}`),
			);
			const page = await jsonlStore.readEntryRange("j1", { fromSeq: 1, toSeq: 3 });
			assert.equal(page.lastSeq, 600);
			assert.deepEqual(
				page.entries.map((e) => e.seq),
				[1, 2, 3],
			);
		} finally {
			await jsonlStore.close();
		}

		const legacyDir = join(dir, "legacy-files");
		mkdirSync(legacyDir, { recursive: true });
		const legacyHeader = {
			type: "session",
			version: 1,
			id: "legacy-v1",
			timestamp: new Date(BASE).toISOString(),
			cwd: PROJECT,
		};
		const legacyLines = [
			JSON.stringify(legacyHeader),
			...Array.from({ length: 100 }, (_, i) =>
				JSON.stringify({
					type: "message",
					timestamp: new Date(BASE + (i + 1) * 1000).toISOString(),
					message: { role: "user", content: `legacy-line-${i + 1}`, timestamp: BASE + (i + 1) * 1000 },
				}),
			),
		];
		writeFileSync(join(legacyDir, "2026-11-01T00-00-00-000Z_legacy-v1.jsonl"), `${legacyLines.join("\n")}\n`);
		const sqlDb = await openNodeSqliteDatabase(join(dir, "legacy-inner.sqlite"));
		const inner = await SqlSessionStore.open(sqlDb);
		const legacyStore = new LegacySessionStore(inner, {
			legacyDirectory: legacyDir,
			databasePath: join(dir, "legacy-inner.sqlite"),
		});
		try {
			const { read } = historyOver(legacyStore);
			const out = await read("history://sessions/legacy-v1:10-12");
			assert.doesNotMatch(out, /Infinity/);
			assert.ok(out.includes("legacy-line-10"), out);
			assert.ok(out.includes("legacy-line-12"), out);
			assert.ok(!out.includes("legacy-line-13"), out);
			assert.equal(
				await inner.readHeader("legacy-v1"),
				undefined,
				"ranged read must not convert the legacy session",
			);
		} finally {
			await legacyStore.close();
			await sqlDb.close();
		}
	});

	it("does not repeat matches when a later batch of the same entry times out (#5250)", async () => {
		await matchLinesInWorker(["warm"], "warm", "", false, false, 5_000, undefined);
		const store = new MemorySessionStore();
		try {
			await store.create(header("slow-entry"), [
				message("slow", "user", `EARLY_MATCH\n${"padding\n".repeat(10_000)}${"a".repeat(30)}!`, BASE),
			]);
			const { router, request } = historyOver(store, { timeMs: 200 });
			const first = await router.search!("history://sessions/slow-entry", request("EARLY_MATCH|(?=a)(a+)+b"));
			assert.match(first, /^history:\/\/sessions\/slow-entry:1: EARLY_MATCH$/m);
			const next = continuation(first);
			assert.ok(next, first);
			const rest = await router.search!(next, request("EARLY_MATCH|(?=a)(a+)+b"));
			assert.doesNotMatch(rest, /^history:\/\/sessions\/slow-entry:1: EARLY_MATCH$/m);
		} finally {
			await store.close();
		}
	});

	it("counts oversized legacy hook messages as custom messages in an outline (#5250)", async () => {
		const jsonlDir = join(dir, "legacy-outline");
		mkdirSync(jsonlDir, { recursive: true });
		writeFileSync(
			join(jsonlDir, "2026-11-01T00-00-00-000Z_legacy-hooks.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 2,
					id: "legacy-hooks",
					timestamp: new Date(BASE).toISOString(),
					cwd: PROJECT,
				}),
				JSON.stringify({
					type: "message",
					id: "hook",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: { role: "hookMessage", customType: "notice", content: "x".repeat(300_000), timestamp: BASE },
				}),
				"",
			].join("\n"),
		);
		const store = await JsonlSessionStore.open(jsonlDir);
		try {
			const { router } = historyOver(store);
			const outline = await router.read!("history://sessions/legacy-hooks");
			assert.match(outline, /1 custom message/);
			assert.doesNotMatch(outline, /1 other entry/);
		} finally {
			await store.close();
		}
	});

	it("aborts or times out a queued worker request immediately while an active request runs, and renders all entry types identically (#5250)", async () => {
		const slow = matchLinesInWorker([`${"a".repeat(26)}!`], "(?=a)(a+)+b", "", false, false, 300, undefined);
		const controller = new AbortController();
		const queuedAbort = matchLinesInWorker(["hello"], "hello", "", false, false, 5_000, controller.signal);
		const queuedTimeout = matchLinesInWorker(["hello"], "hello", "", false, false, 15, undefined);
		const abortStart = performance.now();
		controller.abort(new Error("cancel queued"));
		await assert.rejects(queuedAbort, /cancel queued/i);
		assert.ok(performance.now() - abortStart < 100, "queued request rejected before active worker finished");
		const timedResult = await queuedTimeout;
		assert.equal(timedResult.timedOut, true);
		await slow;
		const after = await matchLinesInWorker(["hello world"], "world", "", false, false, 2_000, undefined);
		assert.deepEqual(after.matchedIndices, [0]);

		const fixtures = {
			message: [
				message("m-u", "user", `user text ${"u".repeat(4_100)} 😀`, BASE),
				message("m-a", "assistant", "assistant reply", BASE + 1000),
				{
					type: "message",
					id: "m-tr",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "read",
						content: [
							{ type: "text", text: "tool output" },
							{ type: "image", data: "x", mimeType: "image/png" },
						],
						isError: false,
						timestamp: BASE,
					},
				} as never,
				{
					type: "message",
					id: "m-tc",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
						timestamp: BASE,
					},
				} as never,
				{
					type: "message",
					id: "m-bash",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: {
						role: "bashExecution",
						command: "echo hi",
						output: "hi",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: BASE,
					},
				} as never,
				{
					type: "message",
					id: "m-cust",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: {
						role: "custom",
						customType: "note",
						content: "custom msg",
						display: true,
						timestamp: BASE,
					},
				} as never,
				{
					type: "message",
					id: "m-bs",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					message: {
						role: "branchSummary",
						summary: "branch summary msg",
						fromId: "a",
						timestamp: BASE,
					},
				} as never,
			],
			thinking_level_change: [
				{
					type: "thinking_level_change",
					id: "tl1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					thinkingLevel: "high",
				},
			],
			model_change: [
				{
					type: "model_change",
					id: "mc1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					provider: "anthropic",
					modelId: "claude",
				},
			],
			compaction: [compaction("c1", "compacted summary", BASE)],
			branch_summary: [
				{
					type: "branch_summary",
					id: "bs1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					fromId: "a",
					summary: "branch summary entry",
				},
			],
			session_summary: [
				{
					type: "session_summary",
					id: "ss1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					summary: "session summary entry",
					summarizedThroughId: "a",
				},
			],
			custom: [custom("cu1", BASE)],
			custom_message: [
				{
					type: "custom_message",
					id: "cm1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					customType: "hook",
					content: "custom message entry",
					display: true,
				},
			],
			label: [
				{
					type: "label",
					id: "l1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					targetId: "a",
					label: "bookmark",
				},
			],
			session_info: [
				{
					type: "session_info",
					id: "si1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					name: "named session",
				},
			],
			context_edit: [
				{
					type: "context_edit",
					id: "ce1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					targetId: "a",
				} as SessionEntry,
			],
			worktree_snapshot: [
				{
					type: "worktree_snapshot",
					id: "ws1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					root: "/p",
					snapshotId: "s",
				} as SessionEntry,
			],
			usage: [
				{
					type: "usage",
					id: "u1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					kind: "compaction",
					provider: "anthropic",
					model: "claude",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
			context_compaction: [
				{
					type: "context_compaction",
					id: "cc1",
					parentId: null,
					timestamp: new Date(BASE).toISOString(),
					promptVersion: 1,
					deletedTargets: [{ kind: "entry", entryId: "a" }],
					protectedEntryIds: [],
					stats: {
						objectsBefore: 2,
						objectsAfter: 1,
						objectsDeleted: 1,
						tokensBefore: 10,
						tokensAfter: 5,
						percentReduction: 50,
					},
				},
			],
		} satisfies Record<SessionEntry["type"], SessionEntry[]>;

		const decoder = new TextDecoder();
		for (const list of Object.values(fixtures)) {
			for (const item of list) {
				const raw = new TextEncoder().encode(JSON.stringify(item));
				const res = await renderRawEntryInWorker([raw], 72, 2_000, undefined);
				assert.ok(!("timedOut" in res));
				assert.equal(decoder.decode(res.renderedUtf8), entryLines(item).join("\n"));
			}
		}
	});

	it("reports entry-unit selector errors on session URLs (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(header("s1"), [message("e1", "user", "hello", BASE)]);
		const { read, search } = historyOver(store);
		await assert.rejects(read("history://sessions/s1:0-2"), /Entry selector 0 is invalid; entries are 1-indexed/);
		await assert.rejects(read("history://sessions/s1:5-3"), /Invalid entry selector :5-3; end must be >= start/);
		await assert.rejects(search("hello", "history://sessions/s1:0-2"), /Invalid entry-range selector: 0-2/);
		await assert.rejects(search("hello", "history://sessions/s1:5-3"), /Invalid entry-range selector: 5-3/);
	});

	it("lists cold JSONL sessions with oversized first messages or legacy headers without loading them whole (#5250)", async () => {
		const jsonlDir = join(dir, "jsonl-cold");
		const writer = await JsonlSessionStore.open(jsonlDir);
		await writer.create(header("huge-first"), [
			message("e1", "user", `huge-prompt-${"p".repeat(300_000)}`, BASE),
			...numbered(50, (seq) => `later-${seq}`),
		]);
		await writer.close();

		const v1Path = join(
			jsonlDir,
			`--${PROJECT.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
			"2026-11-01T00-00-00-000Z_old-v1.jsonl",
		);
		writeFileSync(
			v1Path,
			`${JSON.stringify({ type: "session", version: 1, id: "old-v1", timestamp: new Date(BASE).toISOString(), cwd: PROJECT })}\n${JSON.stringify({ type: "message", timestamp: new Date(BASE + 1000).toISOString(), message: { role: "user", content: "v1 message", timestamp: BASE + 1000 } })}\n`,
		);

		const cold = await JsonlSessionStore.open(jsonlDir, { scanExisting: false });
		try {
			(cold as never as { readSnapshot: () => Promise<never> }).readSnapshot = async () => {
				throw new Error("cold JSONL discovery must not load the whole session");
			};
			const { read } = historyOver(cold);
			const listing = await read("history://sessions");
			assert.match(listing, /history:\/\/sessions\/huge-first/);
			assert.match(listing, /history:\/\/sessions\/old-v1/);
		} finally {
			await cold.close();
		}
	});

	it("preserves the in-flight iterator item across discovery deadlines and resumes from cursor 0.0 (#5250)", async () => {
		const summaries = ["s1", "s2", "s3"].map((id, i) =>
			summarizeSession({
				header: {
					id,
					version: SESSION_FORMAT_VERSION,
					createdAt: new Date(BASE + i * 1000).toISOString(),
					cwd: PROJECT,
				},
				entries: [message(`m-${id}`, "user", `msg ${id}`, BASE + i * 1000)],
				lastSeq: 1,
			}),
		);
		let listCalls = 0;
		const slowListStore: SessionStore = {
			descriptor: { adapter: "slow-list", location: "memory" },
			create: async () => ({ lastSeq: 1 }),
			append: async () => ({ lastSeq: 1 }),
			replace: async () => ({ lastSeq: 1 }),
			load: async () => {
				throw new Error("unused");
			},
			readEntryRange: async () => ({ lastSeq: 1, entries: [], throughSeq: 0 }),
			readHeader: async () => header("s1"),
			delete: async () => {},
			async *list(): AsyncIterable<SessionSummary> {
				listCalls++;
				await new Promise((r) => setTimeout(r, 120));
				yield summaries[0]!;
				await new Promise((r) => setTimeout(r, 120));
				yield summaries[1]!;
				yield summaries[2]!;
			},
			findMostRecent: async () => undefined,
			close: async () => {},
		};
		const { read } = historyOver(slowListStore, { timeMs: 35 });
		const first = await read("history://sessions");
		assert.match(first, /continue with history:\/\/sessions\?cursor=0\.0/);
		await new Promise((r) => setTimeout(r, 100));
		const second = await read("history://sessions?cursor=0.0");
		assert.match(second, /continue with history:\/\/sessions\?cursor=0\.1/);
		await new Promise((r) => setTimeout(r, 120));
		const third = await historyOver(slowListStore, { timeMs: 500 }).read("history://sessions?cursor=0.1");
		assert.match(third, /# sessions 1-3 of 3/);
		assert.ok(third.includes("history://sessions/s1"));
		assert.ok(third.includes("history://sessions/s2"));
		assert.ok(third.includes("history://sessions/s3"));
		assert.equal(listCalls, 1, "resumed discovery must reuse the parked iterator");
	});

	it("resumes multi-line searches past the first slice under row, byte, and +N more cursors without repeating matches (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const padLines = Array.from({ length: 700 }, (_, i) => `pad-${i}-${"p".repeat(95)}`);
			const hitLines = Array.from({ length: 16 }, (_, i) => `slice2-hit-${i + 1} ${"h".repeat(120)}`);
			const entryText = [...padLines, ...hitLines].join("\n");
			await store.create(header("ml-big"), [message("e1", "user", entryText, BASE)]);

			const rowBounded = historyOver(store, { rows: 1 });
			const fromMid =
				(await rowBounded.router.search?.(
					"history://sessions/ml-big?cursor=1.0.660",
					rowBounded.request("(?m)^slice2-hit-\\d+"),
				)) ?? "";
			assert.match(fromMid, /^history:\/\/sessions\/ml-big:1: slice2-hit-1 /m);

			const byteBounded = historyOver(store, { bytes: 950 });
			const seenByteHits: string[] = [];
			let url: string | undefined = "history://sessions/ml-big";
			for (let calls = 0; url !== undefined && calls < 20; calls++) {
				const out = (await byteBounded.router.search?.(url, byteBounded.request("(?m)^slice2-hit-\\d+"))) ?? "";
				for (const match of out.matchAll(/^history:\/\/sessions\/ml-big:1: (slice2-hit-\d+) /gm)) {
					seenByteHits.push(match[1]!);
				}
				url = continuation(out);
			}
			assert.equal(url, undefined);
			assert.deepEqual(
				seenByteHits,
				Array.from({ length: 16 }, (_, i) => `slice2-hit-${i + 1}`),
			);

			const capBounded = historyOver(store);
			const seenCapHits: string[] = [];
			let capUrl: string | undefined = "history://sessions/ml-big";
			for (let calls = 0; capUrl !== undefined && calls < 10; calls++) {
				const out: string =
					(await capBounded.router.search?.(capUrl, capBounded.request("(?m)^slice2-hit-\\d+"))) ?? "";
				for (const match of out.matchAll(/^history:\/\/sessions\/ml-big:1: (slice2-hit-\d+) /gm)) {
					seenCapHits.push(match[1]!);
				}
				capUrl = /search (history:\/\/\S+) for them\]$/m.exec(out)?.[1];
			}
			assert.equal(capUrl, undefined);
			assert.deepEqual(
				seenCapHits,
				Array.from({ length: 16 }, (_, i) => `slice2-hit-${i + 1}`),
			);
		} finally {
			await close();
		}
	});

	it("allows a process to exit on its own after using the history worker (#5250)", () => {
		const workerModuleUrl = new URL("../src/core/tools/history-regex-worker.ts", import.meta.url).href;
		const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"jiti/register",
				"-e",
				`const mod = await import(${JSON.stringify(workerModuleUrl)}); const fn = mod.matchLinesInWorker ?? mod.default.matchLinesInWorker; const res = await fn(["alpha"], "alpha", "", false, false, 1000, undefined); if (res.matchedIndices[0] !== 0) process.exit(2);`,
			],
			{ cwd: pkgRoot, timeout: 4_000, encoding: "utf8" },
		);
		assert.equal(child.status, 0, `worker kept process alive or failed: ${child.stderr}`);
	});

	it("accepts native-only regex syntax and still supports JS lookaround (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(header("dialect"), [message("e1", "user", "alpha one\nBETA two", BASE)]);
		const { router, request } = historyOver(store);
		const namedGroup = (await router.search?.("history://sessions/dialect", request("(?P<word>alpha) one"))) ?? "";
		assert.match(namedGroup, /^history:\/\/sessions\/dialect:1: alpha one$/m);

		const inlineFlag = (await router.search?.("history://sessions/dialect", request("(?i:beta) two"))) ?? "";
		assert.match(inlineFlag, /^history:\/\/sessions\/dialect:1: BETA two$/m);

		const multilineNative =
			(await router.search?.("history://sessions/dialect", request("(?s)(?P<w>alpha).*BETA"))) ?? "";
		assert.match(multilineNative, /^history:\/\/sessions\/dialect:1: alpha one$/m);

		const lookbehind = (await router.search?.("history://sessions/dialect", request("(?<=alpha )one"))) ?? "";
		assert.match(lookbehind, /^history:\/\/sessions\/dialect:1: alpha one$/m);

		await assert.rejects(Promise.resolve(router.search?.("history://sessions/dialect", request("[unclosed"))));
	});

	it("a one-row or zero-time search on a warm index advances one candidate per call (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			const needles = new Set([3, 9, 15, 21, 27]);
			await store.create(
				header("warm"),
				numbered(30, (seq) => (needles.has(seq) ? `warm needle ${seq}` : `filler ${seq}`)),
			);
			const warm = historyOver(store);
			const all = (await warm.router.search?.("history://sessions/warm", warm.request("warm needle"))) ?? "";
			assert.equal(all.match(/^history:\/\/sessions\/warm:\d+: warm needle/gm)?.length, needles.size, all);
			for (const budget of [{ rows: 1 }, { timeMs: 0 }]) {
				const { router, request } = historyOver(store, budget);
				const found: number[] = [];
				const cursors: number[] = [];
				let url: string | undefined = "history://sessions/warm";
				for (let calls = 0; url !== undefined && calls < 40; calls++) {
					const out = (await router.search?.(url, request("warm needle"))) ?? "";
					for (const match of out.matchAll(/^history:\/\/sessions\/warm:(\d+): warm needle/gm))
						found.push(Number(match[1]));
					url = continuation(out);
					const cursor = url === undefined ? undefined : /[?&]cursor=(\d+)/.exec(url)?.[1];
					if (cursor !== undefined) cursors.push(Number(cursor));
				}
				assert.equal(url, undefined, `${JSON.stringify(budget)} never finished`);
				assert.deepEqual(found, [...needles], JSON.stringify(budget));
				for (let i = 1; i < cursors.length; i++)
					assert.ok(cursors[i]! > cursors[i - 1]!, `${JSON.stringify(budget)} repeated cursor ${cursors[i]}`);
			}
		} finally {
			await close();
		}
	});

	it("multi-line lookahead and span reads are charged to the row budget (#5250)", async () => {
		const store = new MemorySessionStore();
		const between = (count: number) => Array.from({ length: count }, (_, i) => custom(`c${i + 1}`, BASE + i + 1));
		await store.create(header("far"), [
			message("b", "user", "BEGIN", BASE),
			...between(5000),
			message("z", "user", "END", BASE + 6000),
		]);
		await store.create(header("near"), [
			message("b", "user", "BEGIN", BASE),
			...between(200),
			message("z", "user", "END", BASE + 6000),
		]);
		let calls = 0;
		let rows = 0;
		const counted = new Proxy(store, {
			get(target, key) {
				if (key === "readEntryRange")
					return async (sessionId: string, query: Parameters<MemorySessionStore["readEntryRange"]>[1]) => {
						const page = await target.readEntryRange(sessionId, query);
						calls++;
						rows += Math.max(0, page.throughSeq - query.fromSeq + 1);
						return page;
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const pattern = "BEGIN\\n(?:.*\\n){0,4}END";
		const oneRow = historyOver(counted, { rows: 1 });
		const first = (await oneRow.router.search?.("history://sessions/far", oneRow.request(pattern))) ?? "";
		assert.ok(calls <= 16, `one row-limited call made ${calls} store reads`);
		assert.ok(rows <= 400, `one row-limited call read ${rows} entries`);
		const firstUrl = continuation(first);
		assert.match(firstUrl ?? "", /cursor=2$/, first);
		calls = 0;
		rows = 0;
		const second = (await oneRow.router.search?.(firstUrl!, oneRow.request(pattern))) ?? "";
		assert.ok(calls <= 16 && rows <= 400, `the next call made ${calls} reads over ${rows} entries`);
		assert.match(continuation(second) ?? "", /cursor=3$/, second);

		calls = 0;
		rows = 0;
		const whole = historyOver(counted);
		const near = (await whole.router.search?.("history://sessions/near", whole.request(pattern))) ?? "";
		assert.match(near, /^history:\/\/sessions\/near:1: BEGIN$/m);
		assert.match(near, /^history:\/\/sessions\/near-202- END$/m);
		assert.ok(calls <= 24, `a match across 200 skipped entries made ${calls} store reads`);
	});

	it("finds a lookbehind match across a 64 KiB slice boundary once (#5250)", async () => {
		const text = `${"x\n".repeat(32748)}PREFIX\nTARGET\nEND`;
		for (const open of [openSql, openJsonl, async () => openMemory()]) {
			const { store, close } = await open(dir);
			try {
				await store.create(header("behind"), [message("e1", "user", text, BASE)]);
				const { router, request } = historyOver(store);
				const out =
					(await router.search?.("history://sessions/behind", request("(?<=PREFIX\\n)TARGET\\nEND"))) ?? "";
				assert.equal(out.match(/^history:\/\/sessions\/behind:1: TARGET$/gm)?.length, 1, out);
				assert.match(out, /^history:\/\/sessions\/behind-1- END$/m);
			} finally {
				await close();
			}
		}
	});

	it("finds a lookbehind match that needs the previous entry's last line (#5250)", async () => {
		const store = new MemorySessionStore();
		await store.create(header("prev"), [
			message("e1", "user", "alpha\nPREFIX", BASE),
			message("e2", "assistant", "TARGET\nEND", BASE + 1000),
		]);
		const { router, request } = historyOver(store);
		const out =
			(await router.search?.("history://sessions/prev", request("(?<=PREFIX\\n)## \\S+ assistant\\nTARGET"))) ?? "";
		assert.match(out, /^history:\/\/sessions\/prev:2: ## \S+ assistant$/m);
		assert.match(out, /^history:\/\/sessions\/prev-2- TARGET$/m);
	});

	it(
		"builds the search index of a long session without blocking the event loop for more than a few milliseconds (#5250)",
		async () => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			await database.exec("PRAGMA synchronous=OFF");
			const store = await SqlSessionStore.open(database);
			try {
				let state = 5250;
				const word = () => {
					state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
					return state.toString(36);
				};
				await store.create(
					header("long"),
					numbered(INDEX_BUILD_ENTRIES, () => Array.from({ length: 240 }, word).join(" ")),
				);
				const { router, request } = historyOver(store, { timeMs: 120_000, rows: 10_000_000 });
				const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
				let found: string;
				let turns: WatchedTurns;
				try {
					found = (await router.search?.("history://sessions/long", request("no such needle"))) ?? "";
				} finally {
					turns = await stopWatching();
				}
				assert.doesNotMatch(found, /budget ran out/);
				const coverage = await store.searchIndex?.coverage("long", HISTORY_TEXT_FORMAT);
				assert.equal(coverage?.indexedSeq, INDEX_BUILD_ENTRIES, "the search indexed the whole session");
				assertFewStalls(turns, TURN_LIMIT_MS, "indexing");
			} finally {
				await store.close();
				await database.close();
			}
		},
		LARGE_SESSION_TIMEOUT_MS,
	);

	it(
		"builds the search index without holding the event loop while the index store's writes are slow (#5666)",
		async () => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			await database.exec("PRAGMA synchronous=OFF");
			const store = await SqlSessionStore.open(database);
			try {
				await store.create(
					header("slow"),
					numbered(SLOW_WRITE_ENTRIES, (index) => `entry ${index} ${"lorem ipsum ".repeat(80)}`),
				);
				// Every time the index records how far it got, SQLite stays busy for longer than any turn may hold the event
				// loop, as a synced COMMIT on a loaded disk does.
				const rows = await countingRowsFor(database, SLOW_WRITE_MS);
				await database.exec(
					`CREATE TRIGGER slow_index_progress AFTER UPDATE OF indexed_seq ON session_search_state WHEN NEW.indexed_seq <> OLD.indexed_seq BEGIN SELECT count(*) FROM (${countingRows(rows)}); END`,
				);
				const { router, request } = historyOver(store, { timeMs: 120_000, rows: 10_000_000 });
				const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
				let found: string;
				let turns: WatchedTurns;
				try {
					found = (await router.search?.("history://sessions/slow", request("no such needle"))) ?? "";
				} finally {
					turns = await stopWatching();
				}
				assert.doesNotMatch(found, /budget ran out/);
				const coverage = await store.searchIndex?.coverage("slow", HISTORY_TEXT_FORMAT);
				assert.equal(coverage?.indexedSeq, SLOW_WRITE_ENTRIES, "the search indexed the whole session");
				assertFewStalls(turns, TURN_LIMIT_MS, "indexing with slow writes");
			} finally {
				await store.close();
				await database.close();
			}
		},
		LARGE_SESSION_TIMEOUT_MS,
	);

	it("still counts work that holds the event loop past the limit while it watches at raised priority (#5250)", async () => {
		const blocked = new Set([100, 200, 300, 400]);
		const before = getPriority();
		const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
		let turns: WatchedTurns;
		try {
			for (let index = 0; index < 500; index++) {
				if (blocked.has(index)) busyFor(25, cpuMs, CPU_CLOCK_STEP_MS);
				else busyFor(0.2);
				await new Promise((resolve) => setImmediate(resolve));
			}
		} finally {
			turns = await stopWatching();
		}
		assert.equal(getPriority(), before);
		assert.throws(
			() => assertFewStalls(turns, TURN_LIMIT_MS, "the blocking work"),
			/the blocking work held the event loop for more than 10 ms ([4-9]|\d{2,}) times/,
		);
	});

	it("counts a turn's blocking work when a collection inside it waited off the CPU (#5250)", () => {
		const windowsTick = 15.625;
		const turn = { start: 0, end: 52.6, cpu: 2 * windowsTick };
		const preemptedCollection = { start: 10, end: 41.3 };
		assert.ok(
			turnBlockedMs(turn, [preemptedCollection], windowsTick) > TURN_LIMIT_MS,
			"21.3 ms of work around a 31.3 ms collection pause still held the event loop",
		);
	});

	it("does not count a collection's own CPU work as the turn's blocking (#5250)", () => {
		const turn = { start: 0, end: 30, cpu: 30 };
		assert.ok(turnBlockedMs(turn, [{ start: 5, end: 25 }], 0.001) <= TURN_LIMIT_MS);
	});

	it("does not charge a clock step to a turn with no measured CPU time (#5624)", () => {
		const windowsTick = 15.625;
		for (const wall of [12, 200]) assert.equal(turnBlockedMs({ start: 0, end: wall, cpu: 0 }, [], windowsTick), 0);
	});

	it("counts a turn that held the event loop past the limit when a coarse CPU clock charged it a step (#5599)", () => {
		const windowsTick = 15.625;
		for (const turn of [
			{ start: 0, end: 12, cpu: windowsTick },
			{ start: 0, end: 15.2, cpu: windowsTick },
			{ start: 0, end: 20, cpu: windowsTick },
			{ start: 0, end: 25, cpu: windowsTick },
			{ start: 0, end: 31, cpu: windowsTick },
		])
			assert.ok(
				turnBlockedMs(turn, [], windowsTick) > TURN_LIMIT_MS,
				`a ${turn.end} ms turn charged ${turn.cpu} ms of CPU time held the event loop`,
			);
		const longTurn = { start: 0, end: 30, cpu: 2 * windowsTick };
		assert.ok(turnBlockedMs(longTurn, [], windowsTick) > TURN_LIMIT_MS);
		const aroundPreemptedCollection = { start: 0, end: 42, cpu: windowsTick };
		assert.ok(
			turnBlockedMs(aroundPreemptedCollection, [{ start: 10, end: 40 }], windowsTick) > TURN_LIMIT_MS,
			"12 ms of work around a 30 ms collection pause, charged one step, held the event loop",
		);
	});

	it("does not count a coarse CPU clock's step past a turn's wall time, or more than one step of waiting off the CPU (#5250)", () => {
		const windowsTick = 15.625;
		const shortTurn = { start: 0, end: 3, cpu: windowsTick };
		assert.ok(turnBlockedMs(shortTurn, [], windowsTick) <= TURN_LIMIT_MS);
		const descheduledTurn = { start: 0, end: 200, cpu: windowsTick };
		assert.ok(turnBlockedMs(descheduledTurn, [], windowsTick) <= 2 * windowsTick);
	});

	it("spends the requested CPU time in a blocking busyFor burst even when wall time jumps (#5250)", () => {
		let wall = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => {
			wall += 50;
			return wall;
		});
		try {
			const start = cpuMs();
			busyFor(25, cpuMs);
			const elapsed = cpuMs() - start;
			assert.ok(elapsed >= 25, `busyFor(25, cpuMs) used ${elapsed} ms of CPU time`);
		} finally {
			now.mockRestore();
		}
	});

	it("holds the event loop for the requested wall time in a blocking busyFor burst even when a coarse CPU clock steps ahead (#5599)", () => {
		const windowsTick = 15.625;
		let reads = 0;
		const coarseCpuClock = () => (reads++ === 0 ? 0 : 2 * windowsTick);
		const start = performance.now();
		busyFor(25, coarseCpuClock, windowsTick);
		const elapsed = performance.now() - start;
		assert.ok(elapsed >= 25, `busyFor(25) held the event loop for ${elapsed} ms`);
	});

	it("restores the process priority after watching the event loop, also when the watched work throws (#5250)", async () => {
		const before = getPriority();
		let during: number | undefined;
		await assert.rejects(async () => {
			const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
			try {
				during = getPriority();
				throw new Error("the watched work failed");
			} finally {
				await stopWatching();
			}
		}, /the watched work failed/);
		assert.ok(during !== undefined && during <= before, `watching lowered the priority from ${before} to ${during}`);
		assert.equal(getPriority(), before);
	});

	it("yields the event loop between the sessions and index queries of a multi-session search (#5250)", async () => {
		const { store, close } = await openSql(dir);
		try {
			for (let index = 1; index <= PACED_SESSIONS; index++)
				await store.create(
					header(`paced-${index}`),
					numbered(3, (seq) => `paced entry ${index}.${seq}`),
				);
			const url = `history://sessions?limit=${PACED_SESSIONS}`;
			const warm = historyOver(store, { timeMs: 60_000 });
			await warm.router.search?.(url, warm.request("text that no entry holds"));
			const slow = withSlowIndexQueries(store);
			const { router, request } = historyOver(slow.store, { timeMs: 60_000 });
			const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
			let found: string;
			let turns: WatchedTurns;
			try {
				found = (await router.search?.(url, request("text that no entry holds"))) ?? "";
			} finally {
				turns = await stopWatching();
			}
			assert.equal(found, "", "the search covered every session without stopping");
			assert.ok(slow.queries() >= 2 * PACED_SESSIONS, `the search made ${slow.queries()} index queries`);
			assertFewStalls(turns, PACED_TURN_LIMIT_MS, "the search");
		} finally {
			await close();
		}
	});

	it(
		"never blocks the event loop for long while searching a large session (#5250)",
		async () => {
			const { store, close } = await openSql(dir, { unsynced: true });
			try {
				const entries = numbered(6000, (seq) => `${seq} ${"lorem ipsum dolor sit amet ".repeat(150)}`);
				await store.create(header("big"), entries);
				const { router, request } = historyOver(store, { timeMs: 60_000, rows: 10_000_000 });
				const stopWatching = watchEventLoopTurns(WATCHED_TURN_LIMIT_MS);
				let turns: WatchedTurns;
				try {
					for (const pattern of ["no such text anywhere", "(?:x|y)z+ no"])
						await router.search?.("history://sessions/big", request(pattern));
					await router.read?.("history://sessions/big");
				} finally {
					turns = await stopWatching();
				}
				assertFewStalls(turns, TURN_LIMIT_MS, "searching and reading a large session");
			} finally {
				await close();
			}
		},
		LARGE_SESSION_TIMEOUT_MS,
	);

	it("outline links cover their exact turn ranges across row-budget, time-budget, and multi-page single-turn cuts (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const perTurn = 3;
			const turnCount = 720;
			const entries: SessionEntry[] = [];
			for (let seq = 1; seq <= turnCount * perTurn; seq++) {
				const at = BASE + seq * 1000;
				const turn = Math.ceil(seq / perTurn);
				const isUser = seq % perTurn === 1;
				entries.push(
					isUser
						? message(`e${seq}`, "user", `turn ${turn}`, at)
						: message(`e${seq}`, "assistant", `reply ${turn}.${seq % perTurn}`, at),
				);
			}
			await store.create(header("exact-turns"), entries);

			const collectOutlineTurns = async (targetStore: SessionStore, budget: Partial<HistoryBudget>) => {
				const { router } = historyOver(targetStore, budget);
				let url: string | undefined = "history://sessions/exact-turns";
				const listed = new Map<number, [number, number]>();
				let pages = 0;
				while (url !== undefined && pages < 400) {
					const out = (await router.read!(url)) ?? "";
					pages++;
					for (const match of out.matchAll(
						/^history:\/\/sessions\/exact-turns:(\d+)-(\d+) \| [^|]+ \| user: turn (\d+)$/gm,
					)) {
						listed.set(Number(match[3]), [Number(match[1]), Number(match[2])]);
					}
					url = continuation(out);
				}
				return { listed, pages };
			};

			const rowSplit = await collectOutlineTurns(store, { rows: 100 });
			assert.ok(rowSplit.pages > 1, "row budget splits the outline across pages");
			for (let turn = 1; turn <= turnCount; turn++) {
				assert.deepEqual(rowSplit.listed.get(turn), [(turn - 1) * perTurn + 1, turn * perTurn]);
			}

			const firstRowPage =
				(await historyOver(store, { rows: 100 }).router.read!("history://sessions/exact-turns")) ?? "";
			assert.match(firstRowPage, /^entries 1-99: 33 user turns, 66 assistant messages$/m);
			assert.equal(continuation(firstRowPage), "history://sessions/exact-turns?cursor=100");

			const byteSplit = await collectOutlineTurns(store, { bytes: 900 });
			assert.ok(byteSplit.pages > 1, "byte budget splits the outline across pages");
			for (let turn = 1; turn <= turnCount; turn++) {
				assert.deepEqual(byteSplit.listed.get(turn), [(turn - 1) * perTurn + 1, turn * perTurn]);
			}

			let callCount = 0;
			const timePaged: SessionStore = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return async (id: string, query: Parameters<MemorySessionStore["readEntryRange"]>[1]) => {
							callCount++;
							if (callCount % 4 === 0) await new Promise((r) => setTimeout(r, 45));
							return target.readEntryRange(id, query);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const timeSplit = await collectOutlineTurns(timePaged, { timeMs: 30 });
			assert.ok(timeSplit.pages > 1, "time budget splits the outline across pages");
			for (let turn = 1; turn <= turnCount; turn++) {
				assert.deepEqual(timeSplit.listed.get(turn), [(turn - 1) * perTurn + 1, turn * perTurn]);
			}

			const longTurnEntries: SessionEntry[] = [
				message("lt-1", "user", "long turn 1", BASE),
				...Array.from({ length: 6 }, (_, i) =>
					message(`lt-a-${i}`, "assistant", `step ${i + 1}`, BASE + (i + 1) * 1000),
				),
				message("lt-8", "user", "turn 2", BASE + 8000),
				message("lt-9", "assistant", "step 2.1", BASE + 9000),
				...Array.from({ length: 2095 }, (_, i) =>
					message(`lt-f-${i}`, i % 2 === 0 ? "user" : "assistant", `filler ${i}`, BASE + (i + 10) * 1000),
				),
			];
			await store.create(header("long-turn"), longTurnEntries);
			const { router: rowRouter } = historyOver(store, { rows: 2 });
			const p1 = (await rowRouter.read!("history://sessions/long-turn")) ?? "";
			const c1 = continuation(p1);
			assert.equal(c1, "history://sessions/long-turn?cursor=3.0.0.1");
			const p2 = (await rowRouter.read!(c1!)) ?? "";
			const c2 = continuation(p2);
			assert.equal(c2, "history://sessions/long-turn?cursor=5.0.0.1");
			const p3 = (await rowRouter.read!(c2!)) ?? "";
			const c3 = continuation(p3);
			assert.equal(c3, "history://sessions/long-turn?cursor=7.0.0.1");
			const p4 = (await rowRouter.read!(c3!)) ?? "";
			assert.match(p4, /^history:\/\/sessions\/long-turn:1-7 \| [^|]+ \| user: long turn 1$/m);

			let stallReload = true;
			const stalledReloadStore: SessionStore = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return (id: string, query: Parameters<MemorySessionStore["readEntryRange"]>[1]) => {
							if (stallReload && query.fromSeq === 1 && query.toSeq === 1) return new Promise<never>(() => {});
							return target.readEntryRange(id, query);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const stalledOut =
				(await historyOver(stalledReloadStore, { timeMs: 25 }).router.read!(
					"history://sessions/long-turn?cursor=3.0.0.1",
				)) ?? "";
			assert.doesNotMatch(stalledOut, /^entries 3-3:/m);
			assert.match(
				stalledOut,
				/\[outline up to entry 3; the time budget ran out; continue with history:\/\/sessions\/long-turn\?cursor=3\.0\.0\.1\]/,
			);
			stallReload = false;

			const usedBySignal = new WeakMap<AbortSignal, number>();
			const halfBudgetStore: SessionStore = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return async (id: string, query: Parameters<MemorySessionStore["readEntryRange"]>[1]) => {
							if (query.signal) {
								const used = (usedBySignal.get(query.signal) ?? 0) + 60;
								usedBySignal.set(query.signal, used);
								if (used > 100) throw new HistoryDeadlineError();
							}
							return target.readEntryRange(id, query);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			for (const timeMs of [100, 1_000]) {
				const halfBudgetOut =
					(await historyOver(halfBudgetStore, { timeMs }).router.read!(
						"history://sessions/long-turn?cursor=33.0.0.1",
					)) ?? "";
				assert.notEqual(
					continuation(halfBudgetOut),
					"history://sessions/long-turn?cursor=33.0.0.1",
					`${timeMs} ms: ${halfBudgetOut}`,
				);
			}
		} finally {
			await store.close();
		}
	});

	it("search tool keeps all 10 matches and the +N more cursor note when context contains file:line: text (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const entries: SessionEntry[] = [];
			for (let seq = 1; seq <= 40; seq++) {
				entries.push(
					message(
						`e${seq}`,
						"user",
						`needle ${seq}\nsrc/a.ts:${seq}: warning one\nsrc/b.ts:${seq}: warning two\nNote: summary:ok: value`,
						BASE + seq * 1000,
					),
				);
			}
			await store.create(header("ctx-colons"), entries);
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
			const tool = createSearchToolDefinition(PROJECT);

			const res = await tool.execute(
				"search",
				{ pattern: "needle", paths: "history://sessions/ctx-colons" },
				undefined,
				undefined,
				ctx as never,
			);
			const out = res.content.map((b) => ("text" in b ? b.text : "")).join("\n");
			const matched = out.split("\n").filter((line) => /^history:\/\/sessions\/ctx-colons:\d+: needle/.test(line));
			assert.equal(matched.length, 10, out);
			assert.match(out, /\+30 more in this session; search history:\/\/sessions\/ctx-colons\?cursor=11 for them/);
		} finally {
			await store.close();
		}
	});

	it("multi-line search covers its row budget per call instead of stopping after one entry (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			const entries: SessionEntry[] = Array.from({ length: 400 }, (_, i) =>
				message(`e${i + 1}`, "user", `line a ${i + 1}\nline b ${i + 1}`, BASE + i * 1000),
			);
			await store.create(header("row-cover"), entries);
			const { router, request } = historyOver(store, { rows: 50 });
			let url: string | undefined = "history://sessions/row-cover";
			const spans: number[] = [];
			let calls = 0;
			while (url !== undefined && calls < 50) {
				const out = (await router.search!(url, request("nomatch\\nmulti"))) ?? "";
				calls++;
				const match = /searched entries (\d+)-(\d+) of 400/.exec(out);
				if (match) spans.push(Number(match[2]) - Number(match[1]) + 1);
				url = continuation(out);
			}
			assert.equal(calls, 8, `expected 8 calls for 400 entries at 50 rows/call, got ${calls} (${spans.join(",")})`);
			assert.deepEqual(spans, [50, 50, 50, 50, 50, 50, 50]);
		} finally {
			await store.close();
		}
	});

	it("truncates outline previews, 512-char search rows, and UTF-8 byte cuts without splitting surrogate pairs or exceeding small byte caps (#5250)", async () => {
		assert.equal(cutTextToUtf8Bytes("😀", 0), "");
		assert.equal(cutTextToUtf8Bytes("😀", 1), "");
		assert.equal(cutTextToUtf8Bytes("😀", 2), "");
		assert.equal(cutTextToUtf8Bytes("😀", 3), "");
		assert.equal(cutTextToUtf8Bytes("😀", 4), "😀");
		assert.equal(cutTextToUtf8Bytes("\ud800a", 3), "\ud800");
		assert.equal(oneLine("\ud800a", 1), "\ud800…");
		assert.equal(oneLine(`${" ".repeat(400)}hello world`, 72), "hello world");

		const store = new MemorySessionStore();
		try {
			const entries: SessionEntry[] = Array.from({ length: 2100 }, (_, index) => {
				const text =
					index === 0
						? `${"a".repeat(71)}😀 and more words after the emoji`
						: index === 1
							? `needle ${"a".repeat(504)}😀 tail`
							: `plain ${index}`;
				return message(`e${index + 1}`, "user", text, BASE + index * 1000);
			});
			await store.create(header("surrogate"), entries);
			const { router, request } = historyOver(store);
			const outline = (await router.read!("history://sessions/surrogate")) ?? "";
			const previewLine = outline.split("\n").find((line) => line.includes("user: aaaa")) ?? "";
			assert.ok(previewLine.length > 0, outline.slice(0, 400));
			assert.equal(previewLine.isWellFormed(), true, previewLine);

			const searched = (await router.search!("history://sessions/surrogate:2-2", request("needle"))) ?? "";
			const matchLine =
				searched.split("\n").find((line) => line.startsWith("history://sessions/surrogate:2: needle")) ?? "";
			assert.ok(matchLine.length > 0, searched);
			assert.equal(matchLine.isWellFormed(), true, matchLine);
		} finally {
			await store.close();
		}
	});
});
