import assert from "node:assert/strict";
import { resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/core/extensions/workflow-run-control.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { formatTaskCompletion, type TaskCompletionEnvelope } from "../src/core/tasks/completion.js";
import { formatTaskHeartbeat } from "../src/core/tasks/heartbeat-notice.js";
import { createHistoryRouter, type WorkflowRunHistory } from "../src/core/tools/history-protocol.js";
import type { InternalResourceRouter, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

/**
 * A history:// search that runs to its end gives the same result as the single call it replaces whenever that call
 * finished within its budgets: the same skip pages, result details, request a router sees, order, text and notices.
 * Each expectation is what the search printed before history searches ran as background tasks (#5479).
 */

const PROJECT = resolve("/projects/search-history-main-parity");
const at = (day: number) => new Date(Date.UTC(2026, 1, day)).toISOString();

function message(id: string, text: string, day: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: at(day),
		message: { role: "user", content: text, timestamp: Date.parse(at(day)) },
	};
}

const stores: MemorySessionStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
});

async function storeWith(sessions: readonly { id: string; day: number; texts: readonly string[] }[]) {
	const store = new MemorySessionStore();
	stores.push(store);
	for (const session of sessions)
		await store.create(
			{ id: session.id, version: SESSION_FORMAT_VERSION, createdAt: at(session.day), cwd: PROJECT },
			session.texts.map((text, index) => message(`${session.id}-${index + 1}`, text, session.day)),
		);
	return store;
}

function search(router: InternalResourceRouter, params: Record<string, unknown>) {
	return createSearchToolDefinition(PROJECT, { contextBefore: 0, contextAfter: 0 }).execute(
		"parity",
		params as never,
		undefined,
		undefined,
		{ cwd: PROJECT, internalResourceRouter: router } as never,
	);
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((item) => item.text ?? "").join("\n");

const sessionsRouter = (store: MemorySessionStore, workflows?: WorkflowRunHistory) =>
	createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => workflows });

describe("a history:// search gives what the single call it replaces gave (#5479)", () => {
	it("pages its matches with skip and rejects a negative skip (#5479)", async () => {
		const one = sessionsRouter(await storeWith([{ id: "s", day: 1, texts: ["needle"] }]));
		assert.equal(
			textOf(await search(one, { paths: "history://sessions/s", pattern: "needle", skip: 1 })),
			"No more results (skip=1)",
		);
		await assert.rejects(
			search(one, { paths: "history://sessions/s", pattern: "needle", skip: -1 }),
			/Skip must be a non-negative number/,
		);
		const three = sessionsRouter(
			await storeWith([
				{ id: "a", day: 1, texts: ["needle a"] },
				{ id: "b", day: 2, texts: ["needle b"] },
				{ id: "c", day: 3, texts: ["needle c"] },
			]),
		);
		assert.equal(
			textOf(await search(three, { paths: "history://sessions", pattern: "needle", skip: 1 })),
			"history://sessions/b:1: needle b\n\nhistory://sessions/a:1: needle a",
		);
	});

	it("rejects with the caller's abort reason during a foreground provider call (#5479)", async () => {
		const path = "history://sessions/s";
		for (const phase of ["first", "continuation"]) {
			for (const reason of [undefined, new Error("workspace changed")]) {
				const controller = new AbortController();
				const router: InternalResourceRouter = {
					search: async (url) => {
						if (phase === "continuation" && url === path)
							return `${path}:0: [the row budget ran out; continue with ${path}?cursor=2]`;
						controller.abort(reason);
						controller.signal.throwIfAborted();
						return "No matches found";
					},
				};
				await assert.rejects(
					createSearchToolDefinition(PROJECT).execute(
						"abort",
						{ paths: path, pattern: "needle" },
						controller.signal,
						undefined,
						{ cwd: PROJECT, internalResourceRouter: router } as never,
					),
					(error) => error === controller.signal.reason,
				);
			}
		}
	});

	it("pages overlapping workflow targets separately after a real budget stop (#5479)", async () => {
		const path = "history://workflows/dupe";
		const run: WorkflowRunSummary = {
			runId: "dupe",
			name: "dupe",
			status: "completed",
			startedAt: 1,
			elapsedMs: 1,
			activeStages: [],
			awaitingInput: [],
			awaitingInputCount: 0,
		};
		const rows = Array.from({ length: 85 }, (_, i) => `needle ${i} ${"a".repeat(490)}`);
		const router = sessionsRouter(await storeWith([]), {
			listRuns: async () => [run],
			listProjectRuns: async () => [run],
			getRun: async () => ({ ...run, inputs: {}, stages: [], summary: rows.join("\n") }),
		});
		for (const second of [path, `${path}:5-89`]) {
			const result = await search(router, { paths: [path, second], pattern: "needle", skip: 1 });
			assert.deepEqual(
				textOf(result).split("\n"),
				rows.slice(0, 20).map((text, i) => `${path}:${i + 5}: ${i === 0 ? "summary: " : ""}${text}`),
			);
			assert.deepEqual(result.details?.fileMatches, { [path]: 20 });
		}
	});

	it("continued overlapping session ranges deduplicate only when no groups were skipped (#5479)", async () => {
		const path = "history://sessions/s";
		const texts = Array.from({ length: 6 }, (_, i) => `needle ${i}`);
		const store = await storeWith([{ id: "s", day: 1, texts }]);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 2 },
		});
		for (const skip of [0, 1]) {
			const result = await search(router, { paths: [path, `${path}:1-3`], pattern: "needle", skip });
			const hits = textOf(result)
				.split("\n")
				.filter((line) => /:\d+: needle/.test(line));
			assert.deepEqual(
				hits,
				texts.slice(0, skip ? 3 : 6).map((text, i) => `${path}:${i + 1}: ${text}`),
			);
		}
	});

	it("counts overlapping target groups separately before applying skip (#5479)", async () => {
		const path = "history://sessions/s";
		const router = sessionsRouter(await storeWith([{ id: "s", day: 1, texts: ["needle   "] }]));
		const result = await search(router, { paths: [path, `${path}:1-1`], pattern: "needle", skip: 1 });
		assert.equal(textOf(result), `${path}:1: needle   `);
		assert.deepEqual(result.details?.fileMatches, { [path]: 1 });
	});

	it("overlapping targets do not exhaust the output budget before their first page is shown (#5479)", async () => {
		const path = "history://workflows/repeat";
		const row = `${path}:1: needle ${"x".repeat(35_000)}`;
		const router = { search: async () => row };
		const page = (count: number) =>
			search(router, { paths: Array.from({ length: count }, () => path), pattern: "needle" });
		const first = textOf(await page(21));
		assert.ok(first.endsWith("[20 matching files shown. Use skip=20 to view more.]"));
		assert.equal(textOf(await page(470)), first);
	});

	it("keeps the entire first page inline with all its SDK locations and its skip hint (#5479)", async () => {
		const ids = Array.from({ length: 21 }, (_, i) => `inline${i}`);
		const texts = Array.from({ length: 5 }, (_, i) => `needle ${i} ${"a".repeat(430)}`);
		const paths = ids.map((id) => `history://sessions/${id}`);
		const router = sessionsRouter(await storeWith(ids.map((id) => ({ id, day: 1, texts }))));
		const result = await search(router, { paths, pattern: "needle" });
		const expected = `${paths
			.slice(0, 20)
			.map((p) => texts.map((t, i) => `${p}:${i + 1}: ${t}`).join("\n"))
			.join("\n\n")}\n\n[20 matching files shown. Use skip=20 to view more.]`;
		assert.equal(Buffer.byteLength(textOf(result)), 47_122);
		assert.equal(textOf(result), expected);
		assert.equal(result.details?.displayContent, expected);
		assert.deepEqual(result.details?.files, paths.slice(0, 20));
	});

	it("a workflow beyond the lookahead cannot replace the first page with its budget stop (#5479)", async () => {
		const paths = Array.from({ length: 22 }, (_, i) => `history://workflows/r${i}`);
		const runs = paths.map(
			(_, i): WorkflowRunSummary => ({
				runId: `r${i}`,
				name: `r${i}`,
				status: "completed",
				startedAt: 1,
				elapsedMs: 1,
				activeStages: [],
				awaitingInput: [],
				awaitingInputCount: 0,
			}),
		);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => ({
				listRuns: async () => runs,
				listProjectRuns: async () => runs,
				getRun: async (runId) => ({
					...runs.find((r) => r.runId === runId)!,
					inputs: {},
					stages: [],
					summary:
						runId === "r21"
							? Array.from({ length: 85 }, (_, i) => `needle ${i} ${"a".repeat(490)}`).join("\n")
							: "needle",
				}),
			}),
		});
		const result = await search(router, { paths, pattern: "needle" });
		assert.deepEqual(result.details?.files, paths.slice(0, 20));
		assert.equal(
			textOf(result),
			`${paths
				.slice(0, 20)
				.map((p) => `${p}:5: summary: needle`)
				.join("\n\n")}\n\n[20 matching files shown. Use skip=20 to view more.]`,
		);
	});

	it("a budget stop beyond the selected skip page is not followed (#5479)", async () => {
		const paths = Array.from({ length: 24 }, (_, i) => `history://sessions/s${i}`);
		const calls: string[] = [];
		const result = await search(
			{
				search: async (url) => {
					calls.push(url);
					return url === paths.at(-1)
						? `${url}:0: [the byte budget ran out; continue with ${url}?cursor=1]`
						: `${url}:1: needle`;
				},
			},
			{ paths, pattern: "needle", skip: 1 },
		);
		assert.deepEqual(calls, paths);
		assert.deepEqual(result.details?.files, paths.slice(1, 21));
	});

	it("off-page listings share the public cursor and close superseded iterators (#5479)", async () => {
		const ids = Array.from({ length: 21 }, (_, i) => `it${i}`);
		const store = await storeWith(ids.map((id) => ({ id, day: 1, texts: ["needle"] })));
		const list = store.list.bind(store);
		let live = 0;
		store.list = async function* (query) {
			live++;
			try {
				yield* list(query);
			} finally {
				live--;
			}
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 1 },
		});
		const listing = "history://sessions";
		const result = await search(router, {
			paths: [...ids.map((id) => `${listing}/${id}`), ...Array(470).fill(listing)],
			pattern: "needle",
			skip: 1,
		});
		assert.equal(result.details?.fileCount, 20);
		assert.equal(live, 1);
		assert.match(await router.read!(`${listing}?cursor=0.1`), /continue with history:\/\/sessions\?cursor=0\.2/);
	});

	it("a repeated target needs only the first matching lookahead (#5479)", async () => {
		const path = "history://sessions/s";
		const router = sessionsRouter(await storeWith([{ id: "s", day: 1, texts: ["needle"] }]));
		const calls: InternalSearchRequest[] = [];
		await search(
			{
				search: (url, request) => {
					calls.push(request);
					return router.search!(url, request);
				},
			},
			{ paths: Array(470).fill(path), pattern: "needle" },
		);
		assert.equal(calls.length, 21);
		assert.ok(calls.every((request) => request.timeBudgetMs === undefined));
	});

	it("a large direct answer uses the ordinary combined output limit (#5479)", async () => {
		const path = "history://workflows/r";
		const rows = Array.from({ length: 15 }, (_, i) => `${path}:${i + 1}: needle ${"z".repeat(5_000)}`);
		const result = await search({ search: async () => rows.join("\n") }, { paths: path, pattern: "needle" });
		assert.equal(textOf(result), `${rows.slice(0, 10).join("\n")}\n\n[50.0KB combined output limit reached]`);
		assert.equal(result.details?.truncation?.totalBytes, Buffer.byteLength(rows.join("\n")));
	});

	it("removes repeated rows across partially overlapping target blocks (#5479)", async () => {
		const path = "history://sessions/c";
		const router = sessionsRouter(await storeWith([{ id: "c", day: 1, texts: ["needle 0", "needle 1"] }]));
		const result = await search(router, { paths: [path, `${path}:1-1`], pattern: "needle" });
		assert.equal(textOf(result), `${path}:1: needle 0\n${path}:2: needle 1\n`);
	});

	it("separates matching targets with a blank line (#5479)", async () => {
		const paths = ["history://sessions/s", "history://sessions/b"];
		const router = sessionsRouter(
			await storeWith([
				{ id: "s", day: 1, texts: ["needle   "] },
				{ id: "b", day: 2, texts: ["needle b"] },
			]),
		);
		assert.equal(
			textOf(await search(router, { paths, pattern: "needle" })),
			`${paths[0]}:1: needle   \n\n${paths[1]}:1: needle b`,
		);
	});

	it("names each target that had no matches (#5479)", async () => {
		const paths = ["history://sessions/s", "history://sessions/b"];
		const router = sessionsRouter(
			await storeWith([
				{ id: "s", day: 1, texts: ["one"] },
				{ id: "b", day: 2, texts: ["two"] },
			]),
		);
		assert.equal(
			textOf(await search(router, { paths, pattern: "needle" })),
			`# ${paths[0]}\nNo matches found\n\n# ${paths[1]}\nNo matches found`,
		);
	});

	it("shows the first twenty matching sessions and the skip to the next page (#5479)", async () => {
		const ids = Array.from({ length: 23 }, (_, i) => `s${String(i).padStart(2, "0")}`);
		const router = sessionsRouter(await storeWith(ids.map((id) => ({ id, day: 1, texts: ["needle"] }))));
		const result = await search(router, { paths: "history://sessions?limit=25", pattern: "needle" });
		const files = ids.slice(0, 20).map((id) => `history://sessions/${id}`);
		assert.equal(
			textOf(result),
			`${files.map((file) => `${file}:1: needle`).join("\n")}\n\n[20 matching files shown. Use skip=20 to view more.]`,
		);
		assert.deepEqual(result.details?.files, files);
	});

	it("shows at most twenty matches from a workflow that finishes in one step (#5479)", async () => {
		const path = "history://workflows/many";
		const rows = Array.from({ length: 21 }, (_, i) => `${path}:${i + 1}: needle ${i}`);
		const result = await search({ search: async () => rows.join("\n") }, { paths: path, pattern: "needle" });
		assert.equal(textOf(result), rows.slice(0, 20).join("\n"));
	});

	it("counts matches, not context, under each decoded session ID (#5479)", async () => {
		const ids = ["space A", "space B"];
		const store = await storeWith(ids.map((id) => ({ id, day: 1, texts: ["before\nneedle\nafter"] })));
		const paths = ids.map((id) => `history://sessions/${encodeURIComponent(id)}`);
		const result = await createSearchToolDefinition(PROJECT, { contextBefore: 1, contextAfter: 1 }).execute(
			"spaces",
			{ paths, pattern: "needle" },
			undefined,
			undefined,
			{ cwd: PROJECT, internalResourceRouter: sessionsRouter(store) } as never,
		);
		assert.equal(result.details?.matchCount, 2);
		assert.equal(result.details?.fileCount, 2);
		assert.deepEqual(result.details?.fileMatches, {
			"history://sessions/space A": 1,
			"history://sessions/space B": 1,
		});
	});

	it("carries the result details an SDK caller reads (#5479)", async () => {
		const router = sessionsRouter(await storeWith([{ id: "s", day: 1, texts: ["needle"] }]));
		const result = await search(router, { paths: "history://sessions/s:1-1", pattern: "needle" });
		const details = result.details as Record<string, unknown>;
		const keys = ["files", "fileMatches", "displayContent", "cwd", "scopePath", "searchPath", "meta"] as const;
		assert.deepEqual(Object.fromEntries(keys.map((key) => [key, details[key]])), {
			files: ["history://sessions/s"],
			fileMatches: { "history://sessions/s": 1 },
			displayContent: "history://sessions/s:1: needle",
			cwd: PROJECT,
			scopePath: "history://sessions/s",
			searchPath: "history://sessions/s",
			meta: { source: "history://sessions/s" },
		});
	});

	it("hands a router the URL and its entry range apart (#5479)", async () => {
		const seen: { url: string; ranges: InternalSearchRequest["ranges"] }[] = [];
		const router: InternalResourceRouter = {
			search: async (url, request) => {
				seen.push({ url, ranges: request.ranges });
				if (url !== "history://sessions/s") throw new Error("resource not found");
				return request.ranges?.map((range) => `history://sessions/s:${range.start}: needle`).join("\n") ?? "";
			},
		};
		const result = await search(router, { paths: "history://sessions/s:3-3", pattern: "needle" });
		assert.equal(textOf(result), "history://sessions/s:3: needle");
		assert.deepEqual(seen, [{ url: "history://sessions/s", ranges: [{ start: 3, end: 3 }] }]);
	});

	it("searches the most recently active session first and continues where main's URL says (#5479)", async () => {
		const store = await storeWith([
			{ id: "a", day: 1, texts: ["needle a"] },
			{ id: "b", day: 2, texts: ["needle b"] },
		]);
		await store.append("a", [message("a-late", "later activity", 3)], { expectSeq: 1 });
		const router = sessionsRouter(store);
		const first = textOf(await search(router, { paths: "history://sessions?limit=1", pattern: "needle" }));
		assert.equal(
			first,
			"history://sessions?limit=1:0: [searched sessions 1-1 of 2; continue with history://sessions?offset=1&limit=1&after=1770076800000.1769904000000.a]\nhistory://sessions/a:1: needle a",
		);
		const next = /continue with (\S+?)\]/.exec(first)?.[1];
		assert.equal(
			textOf(await search(router, { paths: next, pattern: "needle" })),
			"history://sessions?offset=1&limit=1:0: [searched sessions 2-2 of 2]\nhistory://sessions/b:1: needle b",
		);
	});

	it("lists and searches workflow runs that started together in the order their source gives (#5479)", async () => {
		const startedAt = Date.parse(at(1));
		const summary = (runId: string): WorkflowRunSummary => ({
			runId,
			name: `flow-${runId}`,
			status: "completed",
			startedAt,
			elapsedMs: 1,
			activeStages: [],
			awaitingInput: [],
			awaitingInputCount: 0,
		});
		const detail = (runId: string): WorkflowRunDetail => ({
			...summary(runId),
			endedAt: startedAt + 1,
			summary: `needle ${runId}`,
			inputs: {},
			stages: [],
		});
		const runs = ["z-run", "a-run"].map(summary);
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => detail(runId),
		};
		const router = sessionsRouter(await storeWith([]), workflows);
		assert.equal(
			await router.read!("history://workflows?limit=1"),
			"# workflow runs 1-1 of 2 in this project, newest first; next page: history://workflows?offset=1&limit=1\nhistory://workflows/z-run | 2026-02-01T00:00:00.000Z | completed | flow-z-run",
		);
		const first = textOf(await search(router, { paths: "history://workflows?limit=1", pattern: "needle" }));
		assert.equal(
			first,
			"history://workflows?limit=1:0: [searched workflows 1-1 of 2; continue with history://workflows?offset=1&limit=1&run=a-run]\nhistory://workflows/z-run:6: summary: needle z-run",
		);
		const next = /continue with (\S+?)\]/.exec(first)?.[1];
		assert.equal(
			textOf(await search(router, { paths: next, pattern: "needle" })),
			"history://workflows?offset=1&limit=1:0: [searched workflows 2-2 of 2]\nhistory://workflows/a-run:6: summary: needle a-run",
		);
	});

	it("keeps a matching line's text exactly, trailing spaces included (#5479)", async () => {
		const router = sessionsRouter(await storeWith([{ id: "s", day: 1, texts: ["first line\nneedle   \nend"] }]));
		assert.equal(
			textOf(await search(router, { paths: "history://sessions/s", pattern: "needle" })),
			"history://sessions/s:1: needle   ",
		);
	});
});

describe("background shell notices read as before background searches (#5479)", () => {
	const shell = { kind: "command" as const, title: "echo job" };
	const paused: TaskCompletionEnvelope = {
		completionId: "c",
		taskId: "t",
		ownerId: "o",
		taskKind: "command",
		result: { kind: "cancelled", cause: "pause" },
		display: false,
	} as TaskCompletionEnvelope;

	it("a shell interrupted by a pause or a restart (#5479)", () => {
		assert.equal(
			formatTaskCompletion(paused, shell),
			"Background shell interrupted by a pause: echo job\nTask: t · Owner: o\nStop reason: pause\n\nA pause interrupted this command before it finished; the user did not stop it for good. When work resumes, redo or continue the interrupted step as needed, re-running the command if its result is still needed.",
		);
		assert.equal(
			formatTaskCompletion({ ...paused, interruptedByRestart: true }, shell),
			"Background shell interrupted by a restart: echo job\nTask: t · Owner: o\nStop reason: pause\n\nAtomic restarted while this workflow stage was released, so this command no longer runs and its result and output were not kept. If its result is still needed, run the command again.",
		);
	});

	it("a heartbeat for a running shell (#5479)", () => {
		assert.equal(
			formatTaskHeartbeat({
				scheduledAt: 0,
				tasks: [{ taskId: "t", kind: "command", title: "job", elapsedMs: 60_000, intervalMs: 60_000 }],
				more: [],
				moreCount: 0,
			}),
			'♥ Task heartbeat (shell t: job) — still running after 1m, on a 1-minute cadence.\nStatus: elapsed 1m · no output yet\n\nThis is a periodic check, not a failure signal. For each task, judge whether it is still making progress or is runaway, stale, or stuck. If it is progressing, continue your current work and let it run. Otherwise inspect it (/tasks, or the shell or subagent `wait` action with its task ID), steer it (for a subagent, send it an Intercom message, or pause it and resume it with a message), or stop it (`kill({ id })` for a shell, `subagent({ action: "quit", id })` for a subagent). Do not relaunch a duplicate of a task that is still running.',
		);
	});
});
