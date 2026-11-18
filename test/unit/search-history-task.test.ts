import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { SettlementReceipt, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createKillToolDefinition } from "../../packages/coding-agent/src/core/tools/kill.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../../packages/coding-agent/src/core/tools/search.js";
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
	const tempDir = (await import("node:fs/promises")).mkdtemp(
		(await import("node:path")).join((await import("node:os")).tmpdir(), "search-full-"),
	);
	try {
		const big = "x".repeat(30_000);
		const result = await run(
			searchTool(owner, await tempDir).search,
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
