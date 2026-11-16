import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { WorkflowRunDetail } from "../src/core/extensions/workflow-run-control.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "../src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionStore,
} from "../src/core/storage/session/types.js";
import {
	createHistoryRouter,
	type HistoryBudget,
	type WorkflowRunHistory,
} from "../src/core/tools/history-protocol.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

const PROJECT = resolve("/projects/bounded");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const READ_TOOL_LIMIT_CHARS = 50_000;
const EVENT_LOOP_CPU_LIMIT_MS = 150;
const LARGE_SESSION_TIMEOUT_MS = 120_000;

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
				return (body: (tx: SqliteExecutor) => Promise<unknown>, options?: object) =>
					target.transaction((tx) => body(wrap(tx)), options as never);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { database: counted, entryRows: () => entryRows };
}

interface Opened {
	readonly store: SessionStore;
	readonly entryRows: () => number;
	close(): Promise<void>;
}

async function openSql(dir: string): Promise<Opened> {
	const raw = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
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
		workflows: () => undefined,
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
					numbered(3000, (seq) => `${seq === 2500 ? "the buried needle" : `filler ${seq}`} ${"q".repeat(120)}`),
				);
				const { router, read, request } = historyOver(withoutWholeLoads(store));
				assert.ok((await read("history://sessions/big:2499-2501")).includes("the buried needle"));
				assert.match(await read("history://sessions/big"), /1500 user turns/);
				const found = (await router.search?.("history://sessions/big", request("buried needle"))) ?? "";
				assert.match(found, /^history:\/\/sessions\/big:2500: the buried needle/m);
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

	it("stops a search of a workflow run at its byte budget and continues where it stopped (#5250)", async () => {
		const detail: WorkflowRunDetail = {
			runId: "run-many",
			name: "many-stages",
			status: "completed",
			startedAt: BASE,
			inputs: {},
			stages: Array.from({ length: 120 }, (_, index) => ({
				id: `s${index}`,
				name: `build-step-${index}`,
				status: "completed" as const,
			})),
		};
		const workflows: WorkflowRunHistory = {
			listRuns: async () => [
				{
					runId: "run-many",
					name: "many-stages",
					status: "completed",
					startedAt: BASE,
					elapsedMs: 1,
					activeStages: [],
					awaitingInputCount: 0,
					awaitingInput: [],
				},
			],
			getRun: async () => detail,
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { bytes: 1_500 },
		});
		const rows: string[] = [];
		let url: string | undefined = "history://workflows/run-many";
		for (let calls = 0; url !== undefined && calls < 50; calls++) {
			const output =
				(await router.search?.(url, {
					pattern: "build-step",
					ignoreCase: false,
					literal: false,
					contextBefore: 0,
					contextAfter: 0,
				})) ?? "";
			assert.ok(Buffer.byteLength(output) <= 1_500, `output of ${Buffer.byteLength(output)} bytes`);
			rows.push(...output.split("\n").filter((line) => /^history:\/\/workflows\/run-many:[1-9]\d*: /.test(line)));
			url = continuation(output);
		}
		assert.equal(url, undefined, "the search finishes");
		assert.deepEqual(
			rows.map((row) => /build-step-(\d+)/.exec(row)?.[1]),
			Array.from({ length: 120 }, (_, index) => String(index)),
		);
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

	it(
		"never blocks the event loop for long while searching a large session (#5250)",
		async () => {
			const { store, close } = await openSql(dir);
			try {
				const entries = numbered(6000, (seq) => `${seq} ${"lorem ipsum dolor sit amet ".repeat(150)}`);
				await store.create(header("big"), entries);
				const { router, request } = historyOver(store, { timeMs: 60_000, rows: 10_000_000 });
				let longest = 0;
				let last = performance.now();
				let lastCpu = process.cpuUsage();
				const gap = () => {
					const now = performance.now();
					const used = process.cpuUsage(lastCpu);
					longest = Math.max(longest, Math.min(now - last, (used.user + used.system) / 1000));
					last = now;
					lastCpu = process.cpuUsage();
				};
				const ticker = setInterval(gap, 1);
				try {
					for (const pattern of ["no such text anywhere", "(?:x|y)z+ no"])
						await router.search?.("history://sessions/big", request(pattern));
					await router.read?.("history://sessions/big");
				} finally {
					clearInterval(ticker);
					gap();
				}
				assert.ok(
					longest < EVENT_LOOP_CPU_LIMIT_MS,
					`the event loop was busy for ${Math.round(longest)} ms at once`,
				);
			} finally {
				await close();
			}
		},
		LARGE_SESSION_TIMEOUT_MS,
	);
});
