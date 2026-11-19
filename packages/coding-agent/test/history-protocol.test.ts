import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { summarizeSession } from "../src/core/storage/session/session-summary.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionEntriesPage,
	type SessionEntriesQuery,
	type SessionRecordHeader,
	type SessionSnapshot,
	type SessionStore,
	type SessionSummary,
} from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { createToolDefinition } from "../src/core/tools/index.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

function assertIncludes(text: string, part: string): void {
	assert.ok(text.includes(part), `expected ${JSON.stringify(part)} in:\n${text}`);
}

function assertExcludes(text: string, part: string): void {
	assert.ok(!text.includes(part), `expected no ${JSON.stringify(part)} in:\n${text}`);
}

// Absolute on every platform, as a session's recorded cwd is; `?project=<dir>` resolves the same way.
const PROJECT = resolve("/projects/alpha");
const OTHER_PROJECT = resolve("/projects/beta");
const CURRENT_ID = "current-session";

function entry(id: string, text: string, at: number, role: "user" | "assistant" = "user"): SessionEntry {
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

function header(id: string, cwd: string, createdAt: number): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(createdAt).toISOString(), cwd };
}

const DAY = 86_400_000;
const BASE = Date.parse("2026-10-01T00:00:00.000Z");

/** A backend Atomic has never seen: it implements nothing but the `SessionStore` interface. */
class CustomSessionStore implements SessionStore {
	readonly descriptor = { adapter: "custom-double", location: "elsewhere" };
	private readonly sessions = new Map<string, SessionSnapshot>();
	async create(headerValue: SessionRecordHeader, entries: readonly SessionEntry[]) {
		this.sessions.set(headerValue.id, { header: headerValue, entries, lastSeq: entries.length });
		return { lastSeq: entries.length };
	}
	async append(): Promise<{ lastSeq: number }> {
		throw new Error("unused");
	}
	async replace(): Promise<{ lastSeq: number }> {
		throw new Error("unused");
	}
	async load(sessionId: string): Promise<SessionSnapshot> {
		const found = this.sessions.get(sessionId);
		if (!found) throw new Error(`no such session ${sessionId}`);
		return found;
	}
	async readEntryRange(sessionId: string, query: SessionEntriesQuery): Promise<SessionEntriesPage> {
		const found = this.sessions.get(sessionId);
		if (!found) throw new Error(`no such session ${sessionId}`);
		const from = Math.max(1, query.fromSeq);
		const through = Math.min(query.toSeq, found.entries.length);
		return {
			lastSeq: found.entries.length,
			entries: found.entries
				.slice(from - 1, Math.max(from - 1, through))
				.map((item, index) => ({ seq: from + index, entry: item })),
			throughSeq: Math.max(through, from - 1),
		};
	}
	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		return this.sessions.get(sessionId)?.header;
	}
	async delete(): Promise<void> {}
	async *list(query: { cwd?: string }): AsyncIterable<SessionSummary> {
		for (const snapshot of this.sessions.values())
			if (query.cwd === undefined || snapshot.header.cwd === query.cwd) yield summarizeSession(snapshot);
	}
	async findMostRecent(): Promise<SessionSummary | undefined> {
		return undefined;
	}
	async close(): Promise<void> {}
}

interface Backend {
	readonly name: string;
	open(dir: string): Promise<{ store: SessionStore; close(): Promise<void> }>;
}

const BACKENDS: readonly Backend[] = [
	{
		name: "JsonlSessionStore",
		open: async (dir) => {
			const store = await JsonlSessionStore.open(join(dir, "jsonl"));
			return { store, close: () => store.close() };
		},
	},
	{
		name: "SqlSessionStore",
		open: async (dir) => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			const store = await SqlSessionStore.open(database);
			return {
				store,
				close: async () => {
					await store.close();
					await database.close();
				},
			};
		},
	},
	{
		name: "LegacySessionStore over SQLite",
		open: async (dir) => {
			const databasePath = join(dir, "legacy.sqlite");
			const database = await openNodeSqliteDatabase(databasePath);
			const inner = await SqlSessionStore.open(database);
			const store = new LegacySessionStore(inner, { legacyDirectory: join(dir, "legacy-jsonl"), databasePath });
			return {
				store,
				close: async () => {
					await store.close();
					await database.close();
				},
			};
		},
	},
	{ name: "MemorySessionStore", open: async () => ({ store: new MemorySessionStore(), close: async () => {} }) },
	{ name: "custom SessionStore", open: async () => ({ store: new CustomSessionStore(), close: async () => {} }) },
];

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("history:// sessions through any SessionStore (#4252)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-history-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe.each(BACKENDS)("$name", (backend) => {
		async function seeded() {
			const { store, close } = await backend.open(dir);
			await store.create(header("old-session", PROJECT, BASE), [
				entry("a1", "refactor the billing module", BASE + 1000),
				entry("a2", "billing refactor done in invoice.ts", BASE + 2000, "assistant"),
			]);
			await store.create(header("recent-session", PROJECT, BASE + DAY), [
				entry("b1", "investigate the flaky websocket reconnect test", BASE + DAY + 1000),
				entry("b2", "the reconnect backoff resets too early", BASE + DAY + 2000, "assistant"),
				entry("b3", "patch the backoff", BASE + DAY + 3000),
			]);
			await store.create(header("other-project-session", OTHER_PROJECT, BASE + 2 * DAY), [
				entry("c1", "secret roadmap for the beta project", BASE + 2 * DAY + 1000),
			]);
			await store.create(header(CURRENT_ID, PROJECT, BASE + 3 * DAY), [
				entry("d1", "what was I working on?", BASE + 3 * DAY + 1000),
			]);
			const router = createHistoryRouter({
				cwd: PROJECT,
				currentSessionId: CURRENT_ID,
				sessionStore: () => store,
			});
			const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
			const read = async (path: string) =>
				text(await createReadToolDefinition(PROJECT).execute("read", { path }, undefined, undefined, ctx as never));
			const search = async (pattern: string, paths: string) =>
				text(
					await createSearchToolDefinition(PROJECT).execute(
						"search",
						{ pattern, paths },
						undefined,
						undefined,
						ctx as never,
					),
				);
			return { read, search, close };
		}

		it("lists the current project's sessions newest first and leaves other projects out", async () => {
			const { read, close } = await seeded();
			try {
				const listing = await read("history://sessions");
				const lines = listing.split("\n").filter((line) => line.startsWith("history://sessions/"));
				assert.deepEqual(
					lines.map((line) => line.split(" | ")[0]),
					[
						`history://sessions/${CURRENT_ID}`,
						"history://sessions/recent-session",
						"history://sessions/old-session",
					],
				);
				assertIncludes(lines[0], "current session");
				assertIncludes(listing, "investigate the flaky websocket reconnect test");
				assertExcludes(listing, "secret roadmap");
				assertExcludes(listing, "other-project-session");
			} finally {
				await close();
			}
		});

		it("reads a session transcript, narrowed to an entry range", async () => {
			const { read, close } = await seeded();
			try {
				const whole = await read("history://sessions/recent-session");
				assertIncludes(whole, "investigate the flaky websocket reconnect test");
				assertIncludes(whole, "the reconnect backoff resets too early");
				const narrow = await read("history://sessions/recent-session:2-2");
				assertIncludes(narrow, "the reconnect backoff resets too early");
				assertExcludes(narrow, "investigate the flaky websocket reconnect test");
				assertExcludes(narrow, "patch the backoff");
				assertExcludes(narrow, "billing");
			} finally {
				await close();
			}
		});

		it("searches the current project's earlier sessions, not the current one or other projects", async () => {
			const { read, search, close } = await seeded();
			try {
				const found = await search("backoff", "history://sessions");
				assertIncludes(found, "history://sessions/recent-session");
				assertIncludes(found, "backoff resets too early");
				assertExcludes(found, "old-session");
				assert.equal(await search("secret roadmap", "history://sessions"), "No matches found");
				assert.equal(await search("what was I working on", "history://sessions"), "No matches found");
				const label = found.match(/history:\/\/sessions\/recent-session:(\d+):/);
				assert.ok(label, "a match carries a line number");
				const narrow = await read(`history://sessions/recent-session:${label[1]}-${label[1]}`);
				assertIncludes(narrow, "backoff");
				assertIncludes(await search("billing", "history://"), "history://sessions/old-session");
				assertIncludes(await search("reconnect", "history://sessions/recent-session"), "reconnect");
			} finally {
				await close();
			}
		});

		it("keeps other projects out unless asked", async () => {
			const { read, search, close } = await seeded();
			try {
				await assert.rejects(read("history://sessions/other-project-session"), /another project/);
				await assert.rejects(search("roadmap", "history://sessions/other-project-session"), /another project/);
				assertIncludes(await read("history://sessions/other-project-session?project=all"), "secret roadmap");
				const everywhere = await read("history://sessions?project=all");
				assertIncludes(everywhere, "other-project-session");
				assertIncludes(await read(`history://sessions?project=${OTHER_PROJECT}`), "other-project-session");
				assertIncludes(await search("roadmap", "history://sessions?project=all"), "secret roadmap");
				await assert.rejects(read("history://sessions/no-such-session"), /Session not found|no such session/);
			} finally {
				await close();
			}
		});
	});
});

describe("history:// URLs (#4252)", () => {
	const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined });

	it("describes itself at the root and refuses unknown resources and parameters", async () => {
		assertIncludes(String(await router.read?.("history://")), "history://sessions");
		await assert.rejects(async () => router.read?.("history://notes"), /Unknown history resource: notes/);
		await assert.rejects(
			async () => router.read?.("history://sessions?unsupported=all"),
			/Unsupported history query parameter/,
		);
		await assert.rejects(async () => router.read?.("history://sessions?limit=0"), /between 1 and 200/);
		assert.equal(await router.read?.("skill://x"), undefined);
	});

	it("is read-only", async () => {
		await assert.rejects(
			createToolDefinition("write", PROJECT).execute(
				"write",
				{ path: "history://sessions", content: "x" },
				undefined,
				undefined,
				{
					cwd: PROJECT,
				} as never,
			),
			/history:\/\/ resources are read-only/,
		);
	});
});

/** Structural cost: the test writes 230 sessions, and a JSONL store writes one locked file per session. */
const PAGING_TEST_TIMEOUT_MS = 120_000;

function messageEntry(id: string, message: object, at: number): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(at).toISOString(), message } as never;
}

describe.each(BACKENDS)("history:// completeness over $name (#4252)", (backend) => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-history-complete-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function opened() {
		const { store, close } = await backend.open(dir);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
		});
		const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
		const read = async (path: string) =>
			text(await createReadToolDefinition(PROJECT).execute("read", { path }, undefined, undefined, ctx as never));
		const search = async (pattern: string, paths: string) =>
			text(
				await createSearchToolDefinition(PROJECT).execute(
					"search",
					{ pattern, paths },
					undefined,
					undefined,
					ctx as never,
				),
			);
		return { store, read, search, close };
	}

	it("returns every character of long messages, tool results, arguments and commands", async () => {
		const { store, read, close } = await opened();
		try {
			const user = `${"alpha ".repeat(1500)}END-USER`;
			const assistant = `${"x".repeat(12_000)}END-ASSISTANT`;
			await store.create(header("long", PROJECT, BASE), [
				entry("u", user, BASE + 1000),
				entry("a", assistant, BASE + 2000, "assistant"),
				messageEntry(
					"t",
					{
						role: "toolResult",
						toolCallId: "c1",
						toolName: "bash",
						content: [{ type: "text", text: `${"r".repeat(3000)}END-TOOL` }],
						isError: false,
						timestamp: BASE + 3000,
					},
					BASE + 3000,
				),
				messageEntry(
					"c",
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "c1", name: "write", arguments: { body: `${"c".repeat(5000)}END-ARGS` } },
						],
						timestamp: BASE + 4000,
					},
					BASE + 4000,
				),
				messageEntry(
					"b",
					{
						role: "bashExecution",
						command: `echo ${"k".repeat(900)}END-COMMAND`,
						output: `${"o".repeat(2500)}END-OUTPUT`,
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: BASE + 5000,
					},
					BASE + 5000,
				),
			]);
			const lines = (await read("history://sessions/long")).split("\n");
			for (const marker of ["END-USER", "END-ASSISTANT", "END-TOOL", "END-ARGS", "END-COMMAND", "END-OUTPUT"])
				assert.ok(
					lines.some((line) => line.includes(marker)),
					marker,
				);
			assert.ok(Math.max(...lines.map((line) => line.length)) <= 4000);
			const bodyOf = (heading: string): string => {
				const start = lines.findIndex((line) => line.endsWith(heading));
				const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
				return lines.slice(start + 1, end < 0 ? undefined : end).join("");
			};
			assert.equal(bodyOf(" user"), user);
			assert.equal(bodyOf(" assistant"), assistant);
			assertIncludes(await read("history://sessions/long:2-2"), "END-ASSISTANT");
		} finally {
			await close();
		}
	});

	it(
		"pages past 200 records and says what each search covered",
		async () => {
			const { store, read, search, close } = await opened();
			try {
				for (let batch = 0; batch < 230; batch += 23) {
					await Promise.all(
						Array.from({ length: 23 }, (_, offset) => {
							const index = batch + offset;
							const at = BASE + index * 60_000;
							return store.create(header(`rec-${index}`, PROJECT, at), [
								entry(`m${index}`, `record number ${index}`, at + 1000),
							]);
						}),
					);
				}
				await assert.rejects(read("history://sessions?limit=500"), /between 1 and 200/);
				const first = await read("history://sessions?limit=200");
				assertIncludes(first, "sessions 1-200 of 230");
				assertIncludes(first, "next page: history://sessions?offset=200&limit=200");
				assert.equal(first.split("\n").filter((line) => line.startsWith("history://sessions/")).length, 200);
				const second = await read("history://sessions?offset=200&limit=200");
				assertIncludes(second, "sessions 201-230 of 230");
				assertIncludes(second, "history://sessions/rec-0 ");
				assertExcludes(second, "next page");
				assertIncludes(await search("record number 229$", "history://sessions"), "history://sessions/rec-229:");
				const windowed = await search("record number 0$", "history://sessions");
				assertExcludes(windowed, "rec-0:");
				assertIncludes(windowed, "searched sessions 1-25 of 230; continue with history://sessions?offset=25");
				const deep = await search("record number 0$", "history://sessions?offset=200&limit=100");
				assertIncludes(deep, "history://sessions/rec-0:");
				assertIncludes(deep, "searched sessions 201-230 of 230");
				assertExcludes(deep, "continue with");
				assertIncludes(await search("record number", "history://sessions?offset=500"), "none of 230");
			} finally {
				await close();
			}
		},
		PAGING_TEST_TIMEOUT_MS,
	);

	it("keeps what a search covered when it is narrowed to a line range", async () => {
		const { store, search, close } = await opened();
		try {
			for (let index = 0; index < 26; index++) {
				const at = BASE + index * 60_000;
				await store.create(header(`ranged-${index}`, PROJECT, at), [
					entry(`m${index}`, index === 0 ? "the oldest needle" : `record ${index}`, at + 1000),
				]);
			}
			const continuation = "searched sessions 1-25 of 26; continue with history://sessions?offset=25";
			assertIncludes(await search("needle", "history://sessions:1-5"), continuation);
			const matched = await search("record", "history://sessions:1-1");
			assertIncludes(matched, continuation);
			assert.match(matched, /history:\/\/sessions\/ranged-25:1:/);
			assertIncludes(await search("needle", "history://sessions?offset=25:1-5"), "history://sessions/ranged-0:1:");
		} finally {
			await close();
		}
	});

	it("keeps the project scope on links from a cross-project view", async () => {
		const { store, read, search, close } = await opened();
		try {
			await store.create(header("beta-session", OTHER_PROJECT, BASE), [
				entry("b1", "secret roadmap for the beta project", BASE + 1000),
				entry("b2", "second line to narrow", BASE + 2000),
			]);
			for (const query of ["?project=all", `?project=${encodeURIComponent(OTHER_PROJECT)}`]) {
				const row = (await read(`history://sessions${query}`))
					.split("\n")
					.find((line) => line.includes("beta-session"))
					?.split(" | ")[0];
				assert.ok(row, `listing row for ${query}`);
				assertIncludes(row, query);
				assertIncludes(await read(row), "secret roadmap");
				assertIncludes(await read(`${row}:1-2`), "secret roadmap");
				const label = (await search("roadmap", `history://sessions${query}`)).match(
					/(history:\/\/sessions\/beta-session\?project=[^:\s]+):(\d+):/,
				);
				assert.ok(label, `search label for ${query}`);
				assertIncludes(await read(`${label[1]}:${label[2]}-${label[2]}`), "secret roadmap");
			}
		} finally {
			await close();
		}
	});
});

describe("history:// in a session whose own transcript is kept apart from the project's sessions (#4648)", () => {
	async function opened() {
		const project = new MemorySessionStore();
		const own = new MemorySessionStore();
		await project.create(header("earlier-session", PROJECT, BASE), [
			entry("e", "we chose the retry budget of three attempts", BASE + 1000),
		]);
		await own.create(header(CURRENT_ID, PROJECT, BASE + 2 * DAY), [
			entry("c", "the subagent's own scratch note", BASE + 2 * DAY + 1000),
		]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			currentSessionId: CURRENT_ID,
			sessionStore: () => own,
			projectSessionStore: () => project,
		});
		const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
		const read = async (path: string) =>
			text(await createReadToolDefinition(PROJECT).execute("read", { path }, undefined, undefined, ctx as never));
		const search = async (pattern: string, paths: string) =>
			text(
				await createSearchToolDefinition(PROJECT).execute(
					"search",
					{ pattern, paths },
					undefined,
					undefined,
					ctx as never,
				),
			);
		return { read, search };
	}

	it("lists and reads the project's sessions, and reads its own transcript from its own store (#4648)", async () => {
		const { read } = await opened();
		const listing = await read("history://sessions");
		assertIncludes(listing, "history://sessions/earlier-session");
		assertExcludes(listing, `history://sessions/${CURRENT_ID}`);
		assertIncludes(await read("history://sessions/earlier-session"), "retry budget of three attempts");
		assertIncludes(await read(`history://sessions/${CURRENT_ID}`), "the subagent's own scratch note");
	});

	it("searches the project's sessions and its own transcript (#4648)", async () => {
		const { search } = await opened();
		assertIncludes(await search("retry budget", "history://sessions"), "history://sessions/earlier-session:");
		assertIncludes(await search("scratch note", `history://sessions/${CURRENT_ID}`), "scratch note");
		assertIncludes(await search("retry budget", "history://"), "history://sessions/earlier-session:");
	});

	it("lists the project's sessions also when no current session is named (#4648)", async () => {
		const project = new MemorySessionStore();
		await project.create(header("earlier-session", PROJECT, BASE), [entry("e", "an earlier decision", BASE + 1000)]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => new MemorySessionStore(),
			projectSessionStore: () => project,
		});
		assertIncludes(String(await router.read?.("history://sessions")), "history://sessions/earlier-session");
	});
});

describe("history:// outlines of long sessions keep every turn across continuations (#5250)", () => {
	const OUTLINE_ENTRIES = 2_100;
	const TURN_SEQS = [1, 400, 800, 1_200, 1_600, 2_000, OUTLINE_ENTRIES];

	async function outlineStore(id: string): Promise<MemorySessionStore> {
		const store = new MemorySessionStore();
		const turns = new Set(TURN_SEQS);
		await store.create(
			header(id, PROJECT, BASE),
			Array.from({ length: OUTLINE_ENTRIES }, (_, index) => {
				const seq = index + 1;
				const role = turns.has(seq) ? "user" : "assistant";
				return entry(
					`e${seq}`,
					`${role === "user" ? `turn ${seq}` : `reply ${seq}`} ${"w".repeat(60)}`,
					BASE + seq,
					role,
				);
			}),
		);
		return store;
	}

	function outlineRouter(store: SessionStore, bytes?: number, timeMs?: number) {
		return createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { ...(bytes === undefined ? {} : { bytes }), ...(timeMs === undefined ? {} : { timeMs }) },
		});
	}

	function nextUrl(page: string): string | undefined {
		return /continue with (history:\/\/\S+?)\]$/m.exec(page)?.[1];
	}

	it("lists a turn that does not fit at the end of the session on the next page, with its entries counted once (#5250)", async () => {
		const id = "outline-end";
		const store = await outlineStore(id);
		try {
			const failures: string[] = [];
			let endStops = 0;
			for (let bytes = 500; bytes <= 1_400; bytes += 20) {
				const router = outlineRouter(store, bytes);
				const listed: number[] = [];
				let counted = 0;
				let url: string | undefined = `history://sessions/${id}`;
				let pages = 0;
				for (; url !== undefined && pages < 40; pages++) {
					const page: string = String((await router.read?.(url)) ?? "");
					for (const match of page.matchAll(new RegExp(`^history://sessions/${id}:(\\d+)-\\d+ \\| `, "gm")))
						listed.push(Number(match[1]));
					for (const match of page.matchAll(/^entries (\d+)-(\d+): (.*)$/gm)) {
						const kinds = [...match[3]!.matchAll(/(\d+) [a-z]/g)].reduce((sum, kind) => sum + Number(kind[1]), 0);
						if (kinds !== Number(match[2]) - Number(match[1]) + 1) failures.push(`${bytes}: ${match[0]}`);
						counted += kinds;
					}
					const next = nextUrl(page);
					if (
						next !== undefined &&
						page.includes(`; the byte budget ran out`) &&
						!page.includes(`:${OUTLINE_ENTRIES}-`)
					) {
						if (next.endsWith(`?cursor=${OUTLINE_ENTRIES}`)) endStops++;
					}
					url = next;
				}
				if (url !== undefined) failures.push(`${bytes}: no end after ${pages} pages`);
				if (listed.join(",") !== TURN_SEQS.join(","))
					failures.push(`${bytes}: listed ${listed.join(",")} instead of ${TURN_SEQS.join(",")}`);
				if (counted !== OUTLINE_ENTRIES) failures.push(`${bytes}: counted ${counted} entries`);
			}
			assert.deepEqual(failures, []);
			assert.ok(endStops > 0, "no byte budget stopped at the last turn of the session");
		} finally {
			await store.close();
		}
	});

	it("keeps the open turn of an outline continuation when its first page read runs out of time (#5250)", async () => {
		const id = "outline-stall";
		const store = await outlineStore(id);
		try {
			let stalled = 0;
			const stalling: SessionStore = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return (sessionId: string, query: SessionEntriesQuery) => {
							if (query.fromSeq === 900) {
								stalled++;
								return new Promise<never>(() => {});
							}
							return target.readEntryRange(sessionId, query);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const page = String(
				(await outlineRouter(stalling, undefined, 25).read?.(`history://sessions/${id}?cursor=900.0.0.800`)) ?? "",
			);
			assert.equal(stalled, 1, page);
			assert.equal(nextUrl(page), `history://sessions/${id}?cursor=900.0.0.800`, page);
			const resumed = String((await outlineRouter(store).read?.(nextUrl(page)!)) ?? "");
			assert.match(resumed, new RegExp(`^history://sessions/${id}:800-1199 \\| [^|]+ \\| user: turn 800 `, "m"));
		} finally {
			await store.close();
		}
	});
});

describe("history:// session searches cut to fit their byte budget lose no match (#5250)", () => {
	const SWEEP_PAD = "p".repeat(90);

	function hitLines(seq: number, hits: readonly number[], lineCount: number): string {
		const wanted = new Set(hits);
		return Array.from({ length: lineCount }, (_, line) => {
			const fillerChars = line === 4 ? 800 : seq === 2 && line === 1 ? 500 : 96;
			return wanted.has(line) ? `hit ${seq}.${line} ${SWEEP_PAD}` : `${"f".repeat(fillerChars)} ${line}`;
		}).join("\n");
	}

	async function sweepStore(): Promise<MemorySessionStore> {
		const store = new MemorySessionStore();
		const entries: SessionEntry[] = [];
		for (let seq = 1; seq <= 5; seq++) entries.push(entry(`m${seq}`, hitLines(seq, [0, 2, 3], 5), BASE + seq));
		entries.push(entry("m6", hitLines(6, [1, 2, 640, 641, 1290, 1291], 1_300), BASE + 6));
		entries.push(entry("m7", hitLines(7, [0, 1], 2), BASE + 7));
		await store.create(header("sweep", PROJECT, BASE), entries);
		await store.create(header("sweep-other", PROJECT, BASE - DAY), [entry("o1", "nothing here", BASE - DAY)]);
		return store;
	}

	async function shownHits(store: SessionStore, pattern: string, bytes?: number): Promise<string[]> {
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			...(bytes === undefined ? {} : { budget: { bytes } }),
		});
		const hits = new Set<string>();
		const queue = ["history://sessions"];
		const seen = new Set<string>();
		for (let calls = 0; queue.length > 0; calls++) {
			if (calls > 300) throw new Error(`${bytes} bytes: no end after ${calls} calls`);
			const url = queue.shift()!;
			if (seen.has(url)) continue;
			seen.add(url);
			const out =
				(await router.search?.(url, {
					pattern,
					ignoreCase: false,
					literal: false,
					contextBefore: 0,
					contextAfter: 1,
				})) ?? "";
			for (const match of out.matchAll(/^history:\/\/sessions\/sweep:(\d+): hit (\d+\.\d+) /gm)) {
				assert.equal(match[1], match[2]!.split(".")[0], `${bytes} bytes: ${match[0]}`);
				hits.add(match[2]!);
			}
			for (const match of out.matchAll(/(?:continue with|; search) (history:\/\/\S+?)(?:\]| for them\])/g))
				queue.push(match[1]!);
		}
		return [...hits].sort();
	}

	it("resumes a trimmed page at the next match of the same entry or entry slice (#5250)", async () => {
		const store = await sweepStore();
		try {
			for (const pattern of ["hit \\d+\\.\\d+", "(?s)hit \\d+\\.\\d+"]) {
				const expected = await shownHits(store, pattern);
				assert.equal(expected.length, 23, `${pattern}: ${expected.join(",")}`);
				const failures: string[] = [];
				for (let bytes = 400; bytes <= 1_700; bytes += 9) {
					const shown = await shownHits(store, pattern, bytes);
					const lost = expected.filter((hit) => !shown.includes(hit));
					if (lost.length > 0) failures.push(`${pattern} at ${bytes} bytes lost ${lost.join(",")}`);
				}
				assert.deepEqual(failures, []);
			}
		} finally {
			await store.close();
		}
	});
});
