import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { TaskOutputDecoder } from "../../packages/coding-agent/src/core/tasks/command-output.js";
import { formatTaskCompletion } from "../../packages/coding-agent/src/core/tasks/completion.js";
import { toolOutputExcerpt } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type { SettlementReceipt, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { formatTaskHeartbeat } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { TOOL_TASK_OUTPUT_MAX_BYTES } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import { runHistorySearch } from "../../packages/coding-agent/src/core/tools/history-search-run.js";
import { createKillToolDefinition } from "../../packages/coding-agent/src/core/tools/kill.js";
import type {
	InternalResourceContext,
	InternalSearchRequest,
} from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../../packages/coding-agent/src/core/tools/search.js";
import { executeSupervisedToolTask } from "../../packages/coding-agent/src/core/tools/tool-task.js";
import { taskListSections } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { sleep } from "../helpers/runtime.js";

/**
 * A history:// router whose search returns one page per URL: a match, and a `continue with` stop note naming the next
 * page, until the last. Each page takes `pageMs` and honours the call's abort.
 */
function pagedRouter(pages: number, pageMs = 0, matchText = (page: number) => `needle ${page}`) {
	const calls: InternalSearchRequest[] = [];
	const url = (page: number) => (page === 0 ? "history://sessions" : `history://sessions?offset=${page}`);
	return {
		calls,
		context: {
			internalResourceRouter: {
				search: async (requested: string, request: InternalSearchRequest) => {
					calls.push(request);
					const page = requested === "history://sessions" ? 0 : Number(/offset=(\d+)/.exec(requested)?.[1]);
					if (pageMs > 0) {
						const until = Date.now() + pageMs;
						while (Date.now() < until) {
							request.signal?.throwIfAborted();
							await sleep(5);
						}
					}
					request.signal?.throwIfAborted();
					const match = `history://sessions/s${page}:1: ${matchText(page)}`;
					return page + 1 < pages
						? `${match}\nhistory://sessions:0: [searched sessions ${page + 1}-${page + 1} of ${pages}; the time budget ran out; continue with ${url(page + 1)}]`
						: match;
				},
			},
		},
	};
}

function host(commandBudgetMs: number, settledNotices: SettlementReceipt[] = []) {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		tasks: { wait: { kind: "automatic", commandBudgetMs } },
		authorizeLaunch() {},
		onTaskSettled: (_ref, receipt) => {
			settledNotices.push(receipt);
		},
	});
}

function searchTool(owner: AgentTaskHost | undefined, tempDir?: string) {
	return {
		search: createSearchToolDefinition(process.cwd(), {
			...(owner === undefined ? {} : { taskOwner: () => owner.ownerBinding }),
			...(tempDir === undefined ? {} : { sessionTempDir: tempDir }),
		}),
		kill: createKillToolDefinition({ taskOwner: () => owner?.ownerBinding }),
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

async function settledRecord(owner: AgentTaskHost, id: TaskId): Promise<TaskRecord> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const task = owner.taskRecords(new Set([id]))[0];
		assert.ok(task);
		if (task.execution.kind === "settled") return task;
		assert.ok(Date.now() < deadline, JSON.stringify(task.execution));
		await sleep(10);
	}
}

const run = (tool: ReturnType<typeof searchTool>["search"], params: object, context: object) =>
	tool.execute("call", params as never, undefined, undefined, context as never);

test("a history:// search follows each continue-with URL to its end in one call", async () => {
	const owner = host(10_000);
	const router = pagedRouter(4);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions" },
			router.context,
		);
		const shown = text(result);
		for (const page of [0, 1, 2, 3]) assert.match(shown, new RegExp(`needle ${page}`));
		assert.doesNotMatch(shown, /continue with/);
		assert.equal(router.calls.length, 4);
		assert.equal((result.details as { observation?: { kind: string } }).observation?.kind, "settled");
	} finally {
		await owner.close("session-close");
	}
});

test("a history:// search yields at the owner's automatic budget and goes on as a task that notifies once", async () => {
	const notices: SettlementReceipt[] = [];
	const owner = host(60, notices);
	const router = pagedRouter(4, 80);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions" },
			router.context,
		);
		const observation = (result.details as { observation?: { kind: string; taskId?: TaskId } }).observation;
		assert.equal(observation?.kind, "yielded");
		assert.match(text(result), /Search is still running \(task /);
		const id = observation!.taskId!;
		const record = await settledRecord(owner, id);
		assert.equal(record.kind, "tool");
		assert.equal(record.toolName, "search");
		assert.equal(record.agentName, undefined);
		assert.ok(record.execution.kind === "settled" && record.execution.result.kind === "completed");
		await sleep(50);
		assert.equal(notices.filter((notice) => notice.taskId === id).length, 1);
		// All of it is read back by the search's own wait.
		const waited = await run(searchTool(owner).search, { action: "wait", id }, router.context);
		for (const page of [0, 1, 2, 3]) assert.match(text(waited), new RegExp(`needle ${page}`));
		assert.equal(router.calls.length, 4, "the search ran each page once");
	} finally {
		await owner.close("session-close");
	}
});

test("explicit background yields at once, and a foreground budget yields when it elapses", async () => {
	const owner = host(10_000);
	try {
		const background = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions", wait: { kind: "background" } },
			pagedRouter(3, 50).context,
		);
		assert.equal((background.details as { observation?: { kind: string } }).observation?.kind, "yielded");
		const started = Date.now();
		const foreground = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions", wait: { kind: "foreground", budgetMs: 40 } },
			pagedRouter(3, 200).context,
		);
		assert.equal((foreground.details as { observation?: { kind: string } }).observation?.kind, "yielded");
		assert.ok(Date.now() - started < 3_000);
	} finally {
		await owner.close("session-close");
	}
});

test("a history:// search's execution timeout stops it with the URL to continue from", async () => {
	const owner = host(10_000);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions", timeout: 0.15 },
			pagedRouter(10, 60).context,
		);
		assert.equal(result.isError, true);
		assert.match(text(result), /needle 0/);
		assert.match(text(result), /continue with history:\/\/sessions\?offset=\d+/);
		assert.match(text(result), /timed out after 0\.15 seconds/);
	} finally {
		await owner.close("session-close");
	}
});

test("kill stops a background history:// search", async () => {
	const owner = host(0);
	const tools = searchTool(owner);
	try {
		const launched = await run(
			tools.search,
			{ pattern: "needle", paths: "history://sessions" },
			pagedRouter(100, 50).context,
		);
		const id = (launched.details as { observation?: { taskId?: TaskId } }).observation?.taskId;
		assert.ok(id);
		await tools.kill.execute("stop", { id }, undefined, undefined, {} as never);
		const record = await settledRecord(owner, id);
		assert.ok(record.execution.kind === "settled" && record.execution.result.kind === "cancelled");
		assert.equal(record.execution.result.cause, "user");
	} finally {
		await owner.close("session-close");
	}
});

test("a history:// search shows the start of a long result and saves all of it to a file", async () => {
	const owner = host(10_000);
	const tempDir = await mkdtemp(join(tmpdir(), "search-full-"));
	try {
		const big = "x".repeat(30_000);
		const result = await run(
			searchTool(owner, tempDir).search,
			{ pattern: "needle", paths: "history://sessions" },
			pagedRouter(3, 0, (page) => `needle ${page} ${big}`).context,
		);
		const shown = text(result);
		assert.match(shown, /needle 0/);
		const path = /Full output: (\S+)\]/.exec(shown)?.[1];
		assert.ok(path, shown.slice(-300));
		assert.ok(Buffer.byteLength(shown) < 45_000);
		const saved = await readFile(path, "utf8");
		for (const page of [0, 1, 2]) assert.match(saved, new RegExp(`needle ${page}`));
	} finally {
		await owner.close("session-close");
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("without a task owner a history:// search runs to its end in the foreground", async () => {
	const router = pagedRouter(3, 20);
	const result = await run(
		searchTool(undefined).search,
		{ pattern: "needle", paths: "history://sessions" },
		router.context,
	);
	for (const page of [0, 1, 2]) assert.match(text(result), new RegExp(`needle ${page}`));
	assert.equal(router.calls.length, 3);
	await assert.rejects(
		run(
			searchTool(undefined).search,
			{ pattern: "needle", paths: "history://sessions", wait: { kind: "background" } },
			router.context,
		),
		/task owner/,
	);
});

test("/tasks lists a background search in its own section, never as an agent", async () => {
	const owner = host(0);
	try {
		const launched = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions" },
			pagedRouter(20, 50).context,
		);
		const id = (launched.details as { observation?: { taskId?: TaskId } }).observation?.taskId;
		assert.ok(id);
		const sections = taskListSections(owner.taskRecords());
		assert.deepEqual(
			sections.map((section) => [section.title, section.tasks.map((task) => task.ref.taskId)]),
			[["Searches", [id]]],
		);
	} finally {
		await owner.close("session-close");
	}
});

/** A router whose search answers each URL with `answer(url)`, or throws what it returns as an Error. */
function scriptedRouter(answer: (url: string) => string | Error) {
	return {
		internalResourceRouter: {
			search: async (url: string) => {
				const answered = answer(url);
				if (answered instanceof Error) throw answered;
				return answered;
			},
		},
	};
}

test("a background search keeps what a followed stop reports besides the stop itself", async () => {
	const owner = host(10_000);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions" },
			scriptedRouter((url) =>
				url === "history://sessions"
					? "history://sessions/s1:0: [searched entries 1-1 of 9; the time budget ran out; entry 1 not searched: the pattern ran past the time budget on it; continue with history://sessions?offset=1]\n" +
						"history://sessions:0: [searched sessions 1-2 of 3, 1 unreadable; the row budget ran out; continue with history://sessions?offset=2]"
					: url === "history://sessions?offset=1"
						? "history://sessions/s1:4: needle four"
						: "history://sessions/s3:1: needle three",
			),
		);
		const shown = text(result);
		assert.match(shown, /needle four/);
		assert.match(shown, /needle three/);
		assert.match(
			shown,
			/history:\/\/sessions\/s1:0: \[searched entries 1-1 of 9; entry 1 not searched: the pattern ran past the time budget on it\]/,
		);
		assert.match(shown, /history:\/\/sessions:0: \[searched sessions 1-2 of 3, 1 unreadable\]/);
		assert.doesNotMatch(shown, /budget ran out/);
	} finally {
		await owner.close("session-close");
	}
});

test("a search step that fails is noted with where to continue, and the other paths are still searched", async () => {
	const owner = host(10_000);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: ["history://sessions/s1", "history://workflows"] },
			scriptedRouter((url) =>
				url === "history://sessions/s1"
					? new Error("Session not found: s1")
					: "history://workflows/r1:2: needle in a run",
			),
		);
		const shown = text(result);
		assert.match(
			shown,
			/history:\/\/sessions\/s1:0: \[not searched: Session not found: s1; continue with history:\/\/sessions\/s1\]/,
		);
		assert.match(shown, /needle in a run/);
		assert.notEqual(result.isError, true);
	} finally {
		await owner.close("session-close");
	}
});

test("a background search does not report a source a stop handed on as not searched", async () => {
	const owner = host(10_000);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://" },
			scriptedRouter((url) =>
				url === "history://"
					? "history://sessions:0: [sessions not searched: the time budget ran out waiting for the store; continue with history://sessions]"
					: "history://sessions/s1:1: needle one",
			),
		);
		assert.match(text(result), /needle one/);
		assert.doesNotMatch(text(result), /not searched/);
	} finally {
		await owner.close("session-close");
	}
});

for (const owned of [true, false]) {
	test(`a source that answers the same page forever does not make a history search loop (${owned ? "as a task" : "in the foreground"})`, async () => {
		const owner = owned ? host(10_000) : undefined;
		let calls = 0;
		const page = `history://workflows/r1:1: needle ${"x".repeat(5_000)}\nhistory://workflows/r1:0: [the byte budget ran out; continue with history://workflows/r1?cursor=0.0.1]`;
		try {
			const result = await run(
				searchTool(owner).search,
				{ pattern: "needle", paths: "history://workflows/r1", timeout: 2 },
				{
					internalResourceRouter: {
						search: async () => {
							calls++;
							// Bounds this test where a search would loop: it fails here instead of running away.
							if (calls > 50) throw new Error("the search kept asking the same source");
							return page;
						},
					},
				},
			);
			assert.equal(calls, 2);
			assert.notEqual(result.isError, true);
			assert.ok(Buffer.byteLength(text(result)) < 20_000, `${Buffer.byteLength(text(result))} bytes`);
			assert.match(text(result), /continue with history:\/\/workflows\/r1\?cursor=0\.0\.1\]/);
		} finally {
			await owner?.close("session-close");
		}
	});
}

test("a history search's timeout stops it even when its source answers without waiting on anything", async () => {
	const owner = host(10_000);
	const tempDir = await mkdtemp(join(tmpdir(), "search-timeout-"));
	let calls = 0;
	// Far past the 0.2 s timeout: a search that never lets its timer run gets this long, then its source ends it.
	const runawayMs = 5_000;
	const started = Date.now();
	try {
		const result = await run(
			searchTool(owner, tempDir).search,
			{ pattern: "needle", paths: "history://sessions", timeout: 0.2 },
			{
				internalResourceRouter: {
					// Each page answers at once and hands on to a new one: only the timeout ends the search.
					search: async (url: string) => {
						calls++;
						if (Date.now() - started > runawayMs) throw new Error("the search ran past its timeout");
						const page = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
						return `history://sessions/s${page}:1: needle ${page}\nhistory://sessions:0: [searched sessions ${page + 1}-${page + 1} of many; the time budget ran out; continue with history://sessions?offset=${page + 1}]`;
					},
				},
			},
		);
		assert.match(text(result), /timed out after 0\.2 seconds/);
		assert.match(text(result), /continue with history:\/\/sessions\?offset=\d+\]/);
		assert.ok(calls > 1);
	} finally {
		await owner.close("session-close");
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("a tool task's output is final once it settles: a write after its work ended is refused", async () => {
	const owner = host(10_000);
	let late: ((text: string) => void) | undefined;
	try {
		const result = await executeSupervisedToolTask(owner.ownerBinding, {
			tool: "search",
			label: "a search that keeps its writer",
			work: async (write) => {
				write("kept\n");
				late = write;
				return "finished";
			},
		});
		assert.equal(result.observation?.kind, "settled");
		late?.("written after it ended\n");
		const task = owner.resolveTask(result.taskId);
		assert.ok(task.ok);
		const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
			start: "0",
			maximumBytes: 64 * 1024,
		});
		assert.ok(page.ok);
		assert.equal(
			Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString("utf8"),
			"kept\n",
		);
		assert.equal(page.value.nextOffset, undefined);
	} finally {
		await owner.close("session-close");
	}
});

test("a tool task that prints past its output cap keeps how its output ends, and reads the gap as one omitted range", async () => {
	const owner = host(10_000);
	const block = `${"x".repeat(64 * 1024 - 1)}\n`;
	const blocks = Math.ceil(TOOL_TASK_OUTPUT_MAX_BYTES / block.length) + 16;
	try {
		const result = await executeSupervisedToolTask(owner.ownerBinding, {
			tool: "search",
			label: "a search that prints more than its task keeps",
			wait: { kind: "background" },
			work: async (write) => {
				for (let index = 0; index < blocks; index++) write(block);
				write("[search stopped before it finished; continue with history://sessions?offset=7]\n");
				return "stopped";
			},
		});
		const task = owner.resolveTask(result.taskId);
		assert.ok(task.ok);
		await settledRecord(owner, result.taskId);
		const omitted: string[] = [];
		let tail = "";
		let pages = 0;
		for (let offset: string | undefined = "0"; offset !== undefined; pages++) {
			const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
				start: offset,
				maximumBytes: 64 * 1024,
			});
			assert.ok(page.ok);
			omitted.push(...page.value.omittedRanges.map((range) => `${range.start}-${range.end}`));
			tail = (tail + Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString()).slice(
				-200,
			);
			offset = page.value.nextOffset;
		}
		assert.match(tail, /continue with history:\/\/sessions\?offset=7\]\n$/);
		assert.equal(omitted.length, 1, omitted.join(", "));
		assert.ok(pages <= TOOL_TASK_OUTPUT_MAX_BYTES / (64 * 1024) + 4, `${pages} pages`);
	} finally {
		await owner.close("session-close");
	}
});

test("a history search keeps a match that quotes a stop note, and does not follow the URL it quotes", async () => {
	const owner = host(10_000);
	const quoted =
		"history://sessions/S:7: history://sessions:0: [searched sessions 1-1 of 2; the time budget ran out at entry 3 of 9 in history://sessions/T; continue with history://sessions?session=T&cursor=3]";
	const searched: string[] = [];
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "budget ran out", paths: "history://sessions/S" },
			{
				internalResourceRouter: {
					search: async (url: string) => {
						searched.push(url);
						// Bounds this test where a search would follow the quoted URL: it fails here instead of running away.
						if (searched.length > 50) throw new Error("the search kept following the quoted URL");
						return quoted;
					},
				},
			},
		);
		assert.deepEqual(searched, ["history://sessions/S"]);
		assert.equal(text(result), quoted);
	} finally {
		await owner.close("session-close");
	}
});

test("a history search that has printed as much as its task keeps stops there and ends with where to continue", async () => {
	const owner = host(10_000);
	const tempDir = await mkdtemp(join(tmpdir(), "search-cap-"));
	// Each page prints one 64 KB match: past the 16 MB a task keeps from the start well before its last page.
	const pages = Math.ceil(TOOL_TASK_OUTPUT_MAX_BYTES / (64 * 1024)) + 64;
	const router = pagedRouter(pages, 0, (page) => `needle ${page} ${"x".repeat(64 * 1024)}`);
	try {
		const result = await run(
			searchTool(owner, tempDir).search,
			{ pattern: "needle", paths: "history://sessions", wait: { kind: "foreground", budgetMs: 20_000 } },
			router.context,
		);
		const observation = (result.details as { observation?: { kind: string; taskId?: TaskId } }).observation;
		assert.equal(observation?.kind, "settled");
		const next = /continue with history:\/\/sessions\?offset=(\d+)\]$/.exec(text(result));
		assert.ok(next, text(result).slice(-500));
		assert.ok(Number(next[1]) < pages);
		assert.equal(router.calls.length, Number(next[1]));
		const taskId = observation?.taskId;
		assert.ok(taskId);
		const task = owner.resolveTask(taskId);
		assert.ok(task.ok);
		// Everything it printed is kept: nothing between its start and where it stopped is lost.
		for (let offset: string | undefined = "0"; offset !== undefined; ) {
			const page = await owner.ownerBinding.supervisor.readTaskOutput(task.value, {
				start: offset,
				maximumBytes: 64 * 1024,
			});
			assert.ok(page.ok);
			assert.deepEqual(page.value.omittedRanges, []);
			offset = page.value.nextOffset;
		}
	} finally {
		await owner.close("session-close");
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("a cut history search result still shows what could not be read or searched and where to continue", async () => {
	const owner = host(10_000);
	const tempDir = await mkdtemp(join(tmpdir(), "search-notes-"));
	const unreadable = "history://workflows:0: [searched workflow runs 1-7 of 110, 1 unreadable]";
	const skipped = "history://sessions/s2:0: [entry 9 not searched: the pattern ran past its time limit]";
	const nextPage = "history://sessions:0: [searched sessions 1-25 of 164; continue with history://sessions?offset=25]";
	try {
		const result = await run(
			searchTool(owner, tempDir).search,
			{ pattern: "needle", paths: "history://workflows" },
			{
				internalResourceRouter: {
					search: async () =>
						[
							`history://workflows/r1:1: needle ${"x".repeat(45_000)}`,
							unreadable,
							skipped,
							nextPage,
							`history://workflows/r2:1: needle ${"y".repeat(30_000)}`,
						].join("\n"),
				},
			},
		);
		const shown = text(result);
		assert.match(shown, /Full output: /);
		assert.ok(shown.includes(unreadable), shown.slice(-600));
		assert.ok(shown.includes(skipped), shown.slice(-600));
		assert.ok(shown.includes(nextPage), shown.slice(-600));
		assert.ok(Buffer.byteLength(shown) < 45_000);
	} finally {
		await owner.close("session-close");
		await rm(tempDir, { recursive: true, force: true });
	}
});

/**
 * The real history router over twelve sessions of ten entries each, every entry a match of Japanese text and emoji:
 * a search of them prints about 160 KB, so its output runs over several 64 KiB pages, split inside characters.
 */
async function unicodeHistory() {
	const store = new MemorySessionStore();
	const timestamp = new Date().toISOString();
	const text = "日本語🙂".repeat(100);
	for (let session = 0; session < 12; session++) {
		await store.create(
			{
				id: `unicode-session-${session}`,
				version: SESSION_FORMAT_VERSION,
				createdAt: new Date(Date.now() + session).toISOString(),
				cwd: process.cwd(),
			},
			Array.from({ length: 10 }, (_, entry) => ({
				type: "message" as const,
				id: `m${entry}`,
				parentId: null,
				timestamp,
				message: { role: "user" as const, content: `needle ${entry} ${text}`, timestamp: Date.now() },
			})),
		);
	}
	return {
		text,
		context: {
			internalResourceRouter: createHistoryRouter({
				cwd: process.cwd(),
				sessionStore: () => store,
				workflows: () => undefined,
			}),
		},
	};
}

for (const mode of ["in the foreground", "as a task", "read by its wait"] as const) {
	test(`a history search keeps each character whole across its output's pages (${mode})`, async () => {
		const owner = mode === "in the foreground" ? undefined : host(10_000);
		const tempDir = await mkdtemp(join(tmpdir(), "search-unicode-"));
		const history = await unicodeHistory();
		try {
			const tools = searchTool(owner, tempDir);
			let result = await run(
				tools.search,
				{
					pattern: "needle",
					paths: "history://sessions",
					...(mode === "read by its wait" ? { wait: { kind: "background" } } : {}),
				},
				history.context,
			);
			if (mode === "read by its wait") {
				const id = (result.details as { observation?: { taskId?: TaskId } }).observation?.taskId;
				assert.ok(id);
				result = await run(tools.search, { action: "wait", id, budgetMs: 20_000 }, history.context);
			}
			const shown = text(result);
			const path = /Full output: (\S+)\]/.exec(shown)?.[1];
			assert.ok(path, shown.slice(-500));
			const saved = await readFile(path, "utf8");
			assert.equal(saved.indexOf("\uFFFD"), -1, "the saved output has no replacement character");
			assert.equal(shown.indexOf("\uFFFD"), -1, "the result has no replacement character");
			const matches = saved
				.split("\n")
				.filter((line) => /^history:\/\/sessions\/unicode-session-\d+:[1-9]\d*: /.test(line));
			assert.equal(matches.length, 120);
			for (const line of matches) assert.ok(line.endsWith(history.text), line.slice(-80));
		} finally {
			await owner?.close("session-close");
			await rm(tempDir, { recursive: true, force: true });
		}
	});
}

test("/tasks and the completion notice show the start of a search's output without a character the first 8 KiB cuts", async () => {
	const owner = host(10_000);
	try {
		// 9,000 bytes of three-byte characters: the first 8 KiB that /tasks shows ends inside one.
		const result = await executeSupervisedToolTask(owner.ownerBinding, {
			tool: "search",
			label: "a search that found Japanese text",
			work: async (write) => {
				write("日".repeat(3_000));
				return "finished";
			},
		});
		const source = ownerTaskViewSource(new OwnerTaskStore(owner.ownerBinding.supervisor, owner.ownerBinding.owner));
		const page = await source.readTaskOutput(result.taskId, { start: "0", maximumBytes: 8192 });
		assert.ok(page.ok);
		assert.equal(page.value.more, true);
		assert.ok(!page.value.text.includes("\uFFFD"), JSON.stringify(page.value.text.slice(-4)));
		assert.equal(page.value.text, "日".repeat(2_730));
		const task = owner.resolveTask(result.taskId);
		assert.ok(task.ok);
		const notice = await toolOutputExcerpt(owner, task.value);
		assert.ok(!notice.includes("\uFFFD"), JSON.stringify(notice.slice(-30)));
		assert.equal(notice, `${"日".repeat(2_730)}\n[Later output omitted]`);
	} finally {
		await owner.close("session-close");
	}
});

/** A session store whose listing answers only after `delayMs`, as a busy store does. */
class SlowListingStore extends MemorySessionStore {
	listings = 0;
	constructor(private readonly delayMs: number) {
		super();
	}
	override async *list(query: Parameters<MemorySessionStore["list"]>[0]) {
		this.listings++;
		await sleep(this.delayMs);
		yield* super.list(query);
	}
}

for (const owned of [false, true]) {
	test(`a history search waits for a slow store until it answers, through repeated waiting stops (${owned ? "as a task" : "in the foreground"})`, async () => {
		const owner = owned ? host(10_000) : undefined;
		// The store answers after 900 ms; each 25 ms step until then stops at the same place, waiting for it.
		const store = new SlowListingStore(900);
		const timestamp = new Date().toISOString();
		await store.create({ id: "s1", version: SESSION_FORMAT_VERSION, createdAt: timestamp, cwd: process.cwd() }, [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "needle reachable", timestamp: Date.now() },
			},
		]);
		const router = createHistoryRouter({ cwd: process.cwd(), sessionStore: () => store, workflows: () => undefined });
		try {
			const result = await runHistorySearch({
				urls: ["history://sessions"],
				pattern: "needle",
				ignoreCase: false,
				contextBefore: 0,
				contextAfter: 0,
				cwd: process.cwd(),
				resources: { internalResourceRouter: router } as InternalResourceContext,
				stepMs: 25,
				timeoutSeconds: 10,
				wait: { kind: "foreground", budgetMs: 10_000 },
				owner: owner?.ownerBinding,
				tempDir: undefined,
			});
			const observation = result.details?.observation;
			assert.ok(observation?.kind === "settled" && observation.result.kind === "completed", text(result));
			assert.match(text(result), /needle reachable/);
			assert.equal(store.listings, 1, "every step waited on the same listing");
		} finally {
			await owner?.close("session-close");
		}
	});
}

test("a source that repeats the same waiting stop at once is asked again at most once a step until the timeout", async () => {
	const stop =
		"history://sessions:0: [searched sessions 0 of 0+; the time budget ran out after scanning 0 sessions; continue with history://sessions?cursor=0.0&listing=1]";
	let calls = 0;
	const result = await runHistorySearch({
		urls: ["history://sessions"],
		pattern: "needle",
		ignoreCase: false,
		contextBefore: 0,
		contextAfter: 0,
		cwd: process.cwd(),
		resources: {
			internalResourceRouter: {
				search: async () => {
					calls++;
					// Bounds this test where a search would spin on its source: it fails here instead of running away.
					if (calls > 1_000) throw new Error("the search kept asking without waiting");
					return stop;
				},
			},
		} as InternalResourceContext,
		stepMs: 100,
		timeoutSeconds: 1,
		owner: undefined,
		tempDir: undefined,
	});
	assert.equal(result.isError, true);
	assert.match(text(result), /timed out after 1 second/);
	assert.match(text(result), /continue with history:\/\/sessions\?cursor=0\.0&listing=1\]/);
	assert.doesNotMatch(text(result), /budget ran out/);
	// About one call a step: the first two at once, then each 100 ms step until the 1 s timeout.
	assert.ok(calls >= 5 && calls <= 15, `${calls} calls`);
});

test("a finished history search counts its matches, not its notes or a match's context", async () => {
	const owner = host(10_000);
	try {
		const result = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: "history://sessions" },
			scriptedRouter(() =>
				[
					"history://sessions/s1-2- before the needle",
					"history://sessions/s1:3: needle one",
					"history://sessions/s2:7: history://sessions:0: [a match that quotes a note]",
					"history://sessions/s2:9: needle two",
					"history://sessions:0: [searched sessions 1-2 of 2, 1 unreadable]",
				].join("\n"),
			),
		);
		const details = result.details as { matchCount?: number; fileCount?: number };
		assert.equal(details.matchCount, 3);
		assert.equal(details.fileCount, 2);
	} finally {
		await owner.close("session-close");
	}
});

test("a task's output read page by page never joins the bytes on the two sides of a gap into one character", () => {
	const decoder = new TaskOutputDecoder();
	// "日" is E6 97 A5: the kept start ends after its first two bytes, and the kept end starts at a third byte.
	const before = decoder.decode({
		requested: { start: "0", end: "10" },
		chunks: [{ offsets: { start: "0", end: "2" }, bytes: Uint8Array.from([0xe6, 0x97]) }],
		omittedRanges: [{ start: "2", end: "10" }],
		nextOffset: "10",
	});
	const after = decoder.decode({
		requested: { start: "10", end: "13" },
		chunks: [{ offsets: { start: "10", end: "13" }, bytes: Uint8Array.from([0xa5, 0x41, 0x42]) }],
		omittedRanges: [],
	});
	assert.equal(before + after + decoder.end(), "\uFFFD\n[Output omitted: bytes 2-10]\n\uFFFDAB");
});

test("a background history search's skip pages what it found once a wait sees it end (#5479)", async () => {
	const owner = host(10_000);
	const router = pagedRouter(4);
	try {
		const tool = searchTool(owner).search;
		const launched = await run(
			tool,
			{ pattern: "needle", paths: "history://sessions", skip: 2, wait: { kind: "background" } },
			router.context,
		);
		const id = (launched.details as { observation: { taskId: string } }).observation.taskId;
		const waited = await run(tool, { action: "wait", id, budgetMs: 10_000 }, router.context);
		assert.equal(text(waited), "history://sessions/s2:1: needle 2\n\nhistory://sessions/s3:1: needle 3");
	} finally {
		await owner.close("session-close");
	}
});

test("a heartbeat or pause notice that names a background search says how to wait for and stop a search (#5479)", () => {
	const search = { taskId: "s", kind: "tool" as const, toolName: "search", title: "search needle in history://" };
	const shell = { taskId: "t", kind: "command" as const, title: "job" };
	const beat = (tasks: object[], more: object[]) =>
		formatTaskHeartbeat({
			scheduledAt: 0,
			tasks: tasks.map((task) => ({ ...task, elapsedMs: 60_000, intervalMs: 60_000 })) as never,
			more: more as never,
			moreCount: more.length,
		});
	for (const text of [beat([search], []), beat([shell], [search])]) {
		assert.match(text, /the shell, search or subagent `wait` action/);
		assert.match(text, /`kill\(\{ id \}\)` for a shell or search,/);
	}
	const paused = {
		completionId: "c",
		taskId: "s",
		ownerId: "o",
		taskKind: "tool" as const,
		toolName: "search",
		result: { kind: "cancelled" as const, cause: "pause" as const },
		display: false as const,
	};
	const task = { kind: "tool" as const, title: "search needle", toolName: "search" };
	assert.match(formatTaskCompletion(paused as never, task), /A pause interrupted this search before it finished/);
	assert.match(
		formatTaskCompletion({ ...paused, interruptedByRestart: true } as never, task),
		/so this search no longer runs and its result and output were not kept\. If its result is still needed, run it again\./,
	);
});
