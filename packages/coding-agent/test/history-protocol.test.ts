import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	WorkflowRunControl,
	WorkflowRunDetail,
	WorkflowRunSummary,
} from "../src/core/extensions/workflow-run-control.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.ts";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import { summarizeSession } from "../src/core/storage/session/session-summary.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionSnapshot,
	type SessionStore,
	type SessionSummary,
} from "../src/core/storage/session/types.ts";
import { createHistoryRouter } from "../src/core/tools/history-protocol.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.ts";
import { createSearchToolDefinition } from "../src/core/tools/search.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const PROJECT = "/projects/alpha";
const OTHER_PROJECT = "/projects/beta";
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
				workflows: () => undefined,
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
				expect(lines.map((line) => line.split(" | ")[0])).toEqual([
					`history://sessions/${CURRENT_ID}`,
					"history://sessions/recent-session",
					"history://sessions/old-session",
				]);
				expect(lines[0]).toContain("current session");
				expect(listing).toContain("investigate the flaky websocket reconnect test");
				expect(listing).not.toContain("secret roadmap");
				expect(listing).not.toContain("other-project-session");
			} finally {
				await close();
			}
		});

		it("reads a session transcript, narrowed to a line range", async () => {
			const { read, close } = await seeded();
			try {
				const whole = await read("history://sessions/recent-session");
				expect(whole).toContain("investigate the flaky websocket reconnect test");
				expect(whole).toContain("the reconnect backoff resets too early");
				const lines = whole.split("\n");
				const line = lines.findIndex((value) => value.includes("backoff resets")) + 1;
				const narrow = await read(`history://sessions/recent-session:${line}-${line}`);
				expect(narrow).toContain("the reconnect backoff resets too early");
				expect(narrow.split("\n").length).toBeLessThan(lines.length);
				expect(narrow).not.toContain("billing");
			} finally {
				await close();
			}
		});

		it("searches the current project's earlier sessions, not the current one or other projects", async () => {
			const { read, search, close } = await seeded();
			try {
				const found = await search("backoff", "history://sessions");
				expect(found).toContain("history://sessions/recent-session");
				expect(found).toContain("backoff resets too early");
				expect(found).not.toContain("old-session");
				expect(await search("secret roadmap", "history://sessions")).toBe("No matches found");
				expect(await search("what was I working on", "history://sessions")).toBe("No matches found");
				const label = found.match(/history:\/\/sessions\/recent-session:(\d+):/);
				assert.ok(label, "a match carries a line number");
				const narrow = await read(`history://sessions/recent-session:${label[1]}-${label[1]}`);
				expect(narrow).toContain("backoff");
				expect(await search("billing", "history://")).toContain("history://sessions/old-session");
				expect(await search("reconnect", "history://sessions/recent-session")).toContain("reconnect");
			} finally {
				await close();
			}
		});

		it("keeps other projects out unless asked", async () => {
			const { read, search, close } = await seeded();
			try {
				await expect(read("history://sessions/other-project-session")).rejects.toThrow(/another project/);
				await expect(search("roadmap", "history://sessions/other-project-session")).rejects.toThrow(
					/another project/,
				);
				expect(await read("history://sessions/other-project-session?project=all")).toContain("secret roadmap");
				const everywhere = await read("history://sessions?project=all");
				expect(everywhere).toContain("other-project-session");
				expect(await read(`history://sessions?project=${OTHER_PROJECT}`)).toContain("other-project-session");
				expect(await search("roadmap", "history://sessions?project=all")).toContain("secret roadmap");
				await expect(read("history://sessions/no-such-session")).rejects.toThrow(
					/Session not found|no such session/,
				);
			} finally {
				await close();
			}
		});
	});
});

function runSummary(runId: string, startedAt: number, name: string): WorkflowRunSummary {
	return {
		runId,
		name,
		status: "completed",
		startedAt,
		elapsedMs: 1000,
		activeStages: [],
		awaitingInputCount: 0,
		awaitingInput: [],
	};
}

/** A workflow backend Atomic has never seen: run control over a plain in-memory table. */
function customRunControl(): WorkflowRunControl {
	const details = new Map<string, WorkflowRunDetail>([
		[
			"run-new",
			{
				runId: "run-new",
				name: "ship-release",
				status: "completed",
				startedAt: BASE + DAY,
				inputs: { target: "the 2.0 launch" },
				stages: [{ id: "s1", name: "build", status: "completed", sessionId: "recent-session" }],
				result: { artifact: "release-notes.md" },
			},
		],
		[
			"run-old",
			{
				runId: "run-old",
				name: "triage-bugs",
				status: "failed",
				startedAt: BASE,
				inputs: {},
				stages: [],
				error: "the tracker was unreachable",
			},
		],
	]);
	const unsupported = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		listRuns: async () => [
			runSummary("run-old", BASE, "triage-bugs"),
			runSummary("run-new", BASE + DAY, "ship-release"),
		],
		getRun: async (runId) => {
			const found = details.get(runId);
			if (!found) throw new Error(`no such run ${runId}`);
			return found;
		},
		getStages: unsupported,
		pause: unsupported,
		quit: unsupported,
		resume: unsupported,
		waitForSettled: async () => {},
	};
}

describe("history:// workflows through a workflow backend Atomic has never seen (#4252)", () => {
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => undefined,
		workflows: () => customRunControl(),
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

	it("lists runs newest first", async () => {
		const lines = (await read("history://workflows"))
			.split("\n")
			.filter((line) => line.startsWith("history://workflows/"));
		expect(lines.map((line) => line.split(" | ")[0])).toEqual([
			"history://workflows/run-new",
			"history://workflows/run-old",
		]);
		expect(lines[0]).toContain("ship-release");
	});

	it("reads a run with its stages linked to their sessions, and a unique id prefix", async () => {
		const detail = await read("history://workflows/run-new");
		expect(detail).toContain("the 2.0 launch");
		expect(detail).toContain("history://sessions/recent-session");
		expect(detail).toContain("release-notes.md");
		expect(await read("history://workflows/run-n")).toContain("ship-release");
		await expect(read("history://workflows/run-")).rejects.toThrow(/ambiguous/);
		await expect(read("history://workflows/elsewhere")).rejects.toThrow(/not found in this project/);
	});

	it("searches runs and reports the run URL with a line number", async () => {
		expect(await search("unreachable", "history://workflows")).toMatch(/history:\/\/workflows\/run-old:\d+:/);
		expect(await search("launch", "history://")).toContain("history://workflows/run-new");
	});

	it("reports unavailable workflow history when no run control is registered", async () => {
		const bare = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => undefined });
		await expect(bare.read?.("history://workflows")).rejects.toThrow(/Workflow history is unavailable/);
		await expect(bare.read?.("history://sessions")).rejects.toThrow(/Session history is unavailable/);
	});
});

describe("history:// URLs (#4252)", () => {
	const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => undefined });

	it("describes itself at the root and refuses unknown resources and parameters", async () => {
		expect(await router.read?.("history://")).toContain("history://sessions");
		await expect(router.read?.("history://notes")).rejects.toThrow(/Unknown history resource: notes/);
		await expect(router.read?.("history://workflows?project=all")).rejects.toThrow(
			/Unsupported history query parameter/,
		);
		await expect(router.read?.("history://sessions?limit=0")).rejects.toThrow(/between 1 and 200/);
		expect(await router.read?.("skill://x")).toBeUndefined();
	});

	it("is read-only", async () => {
		await expect(
			createWriteToolDefinition(PROJECT).execute(
				"write",
				{ path: "history://sessions", content: "x" },
				undefined,
				undefined,
				{
					cwd: PROJECT,
				} as never,
			),
		).rejects.toThrow(/history:\/\/ resources are read-only/);
	});
});

describe("history:// workflows prefer the project listing (#4252)", () => {
	it("uses listProjectRuns when the run control has it and listRuns otherwise", async () => {
		const base = customRunControl();
		const userStarted = runSummary("run-user", BASE + 2 * DAY, "user-started");
		const withProjectListing: WorkflowRunControl = {
			...base,
			listProjectRuns: async () => [userStarted, ...(await base.listRuns({ includeDurable: true }))],
			getRun: async (runId) =>
				runId === "run-user"
					? {
							runId,
							name: "user-started",
							status: "completed",
							startedAt: userStarted.startedAt,
							inputs: {},
							stages: [],
						}
					: base.getRun(runId),
		};
		const read = async (control: WorkflowRunControl) =>
			String(
				await createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => control }).read?.(
					"history://workflows",
				),
			);
		expect(await read(withProjectListing)).toContain("history://workflows/run-user");
		expect(await read(base)).not.toContain("run-user");
		expect(await read(base)).toContain("history://workflows/run-new");
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

	async function opened(workflows?: () => WorkflowRunControl | undefined) {
		const { store, close } = await backend.open(dir);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: workflows ?? (() => undefined),
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
				expect(
					lines.some((line) => line.includes(marker)),
					marker,
				).toBe(true);
			expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(4000);
			const bodyOf = (heading: string): string => {
				const start = lines.findIndex((line) => line.endsWith(heading));
				const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
				return lines.slice(start + 1, end < 0 ? undefined : end).join("");
			};
			expect(bodyOf(" user")).toBe(user);
			expect(bodyOf(" assistant")).toBe(assistant);
			const last = lines.findIndex((line) => line.includes("END-ASSISTANT")) + 1;
			expect(await read(`history://sessions/long:${last}-${last}`)).toContain("END-ASSISTANT");
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
				await expect(read("history://sessions?limit=500")).rejects.toThrow(/between 1 and 200/);
				const first = await read("history://sessions?limit=200");
				expect(first).toContain("sessions 1-200 of 230");
				expect(first).toContain("next page: history://sessions?offset=200&limit=200");
				expect(first.split("\n").filter((line) => line.startsWith("history://sessions/"))).toHaveLength(200);
				const second = await read("history://sessions?offset=200&limit=200");
				expect(second).toContain("sessions 201-230 of 230");
				expect(second).toContain("history://sessions/rec-0 ");
				expect(second).not.toContain("next page");
				expect(await search("record number 229$", "history://sessions")).toContain("history://sessions/rec-229:");
				const windowed = await search("record number 0$", "history://sessions");
				expect(windowed).not.toContain("rec-0:");
				expect(windowed).toContain("searched sessions 1-25 of 230; continue with history://sessions?offset=25");
				const deep = await search("record number 0$", "history://sessions?offset=200&limit=100");
				expect(deep).toContain("history://sessions/rec-0:");
				expect(deep).toContain("searched sessions 201-230 of 230");
				expect(deep).not.toContain("continue with");
				expect(await search("record number", "history://sessions?offset=500")).toContain("none of 230");
			} finally {
				await close();
			}
		},
		PAGING_TEST_TIMEOUT_MS,
	);

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
				expect(row).toContain(query);
				expect(await read(row)).toContain("secret roadmap");
				expect(await read(`${row}:2-3`)).toContain("secret roadmap");
				const label = (await search("roadmap", `history://sessions${query}`)).match(
					/(history:\/\/sessions\/beta-session\?project=[^:\s]+):(\d+):/,
				);
				assert.ok(label, `search label for ${query}`);
				expect(await read(`${label[1]}:${label[2]}-${label[2]}`)).toContain("secret roadmap");
			}
			const hasLink = await read("history://sessions/beta-session?project=all");
			expect(hasLink).not.toContain("history://workflows/");
		} finally {
			await close();
		}
	});

	it("opens a stage session that ran outside the project through the project's run", async () => {
		const { store, read, close } = await opened(() => customRunControl());
		try {
			const stageHeader = (id: string, runId: string) => ({
				...header(id, "/projects/alpha-worktree", BASE),
				internal: true as const,
				workflow: { runId, stageId: "s1", stageName: "build" },
			});
			await store.create(stageHeader("recent-session-stage", "run-new"), [
				entry("s", "stage transcript text", BASE + 1000),
			]);
			await store.create(stageHeader("stray-stage", "unknown-run"), [
				entry("s", "unvouched stage text", BASE + 1000),
			]);
			const opened = await read("history://sessions/recent-session-stage");
			expect(opened).toContain("stage transcript text");
			expect(opened).toContain("history://workflows/run-new");
			await expect(read("history://sessions/stray-stage")).rejects.toThrow(/another project/);
		} finally {
			await close();
		}
	});
});
