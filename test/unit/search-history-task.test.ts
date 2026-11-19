import assert from "node:assert/strict";
import { test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
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
import { createKillToolDefinition } from "../../packages/coding-agent/src/core/tools/kill.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import {
	createSearchPageDefinition,
	createSearchToolDefinition,
} from "../../packages/coding-agent/src/core/tools/search.js";
import { executeSupervisedToolTask } from "../../packages/coding-agent/src/core/tools/tool-task.js";
import { taskListSections } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { sleep } from "../helpers/runtime.js";

/** One real session entry per page. A delayed provider call still honours the task's abort. */
const sessionUrl = "history://sessions/s";
function pagedRouter(pages: number, pageMs = 0) {
	const calls: InternalSearchRequest[] = [];
	const store = new MemorySessionStore();
	const timestamp = new Date(0).toISOString();
	const ready = store.create(
		{ id: "s", cwd: process.cwd(), version: 4, createdAt: timestamp },
		Array.from({ length: pages }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			timestamp,
			message: { role: "user", content: `needle ${i}`, timestamp: i },
		})),
	);
	const router = createHistoryRouter({
		cwd: process.cwd(),
		currentSessionId: "s",
		sessionStore: () => store,
		workflows: () => undefined,
		budget: { rows: 1 },
	});
	return {
		calls,
		context: {
			internalResourceRouter: {
				search: async (requested: string, request: InternalSearchRequest) => {
					calls.push(request);
					await ready;
					if (pageMs > 0) {
						const until = Date.now() + pageMs;
						while (Date.now() < until) {
							request.signal?.throwIfAborted();
							await sleep(5);
						}
					}
					request.signal?.throwIfAborted();
					return router.search!(requested, request);
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

function searchTool(owner: AgentTaskHost | undefined) {
	return {
		search: createSearchToolDefinition(process.cwd(), {
			...(owner === undefined ? {} : { taskOwner: () => owner.ownerBinding }),
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

test("a history:// search yields at the owner's automatic budget and goes on as a task that notifies once", async () => {
	const notices: SettlementReceipt[] = [];
	const owner = host(60, notices);
	const router = pagedRouter(4, 80);
	try {
		const result = await run(searchTool(owner).search, { pattern: "needle", paths: sessionUrl }, router.context);
		const observation = (result.details as { observation?: { kind: string; taskId?: TaskId } }).observation;
		assert.equal(observation?.kind, "yielded");
		const ordinary = createSearchPageDefinition(process.cwd());
		const expected = (path: string) =>
			ordinary.execute(
				"page",
				{ pattern: "needle", paths: path },
				undefined,
				undefined,
				pagedRouter(4).context as never,
			);
		const first = await expected(sessionUrl);
		assert.deepEqual(result, { ...first, details: { ...first.details, observation } });
		const id = observation!.taskId!;
		const record = await settledRecord(owner, id);
		assert.equal(record.kind, "tool");
		assert.equal(record.toolName, "search");
		assert.equal(record.agentName, undefined);
		assert.ok(record.execution.kind === "settled" && record.execution.result.kind === "completed");
		await sleep(50);
		assert.equal(notices.filter((notice) => notice.taskId === id).length, 1);
		for (const index of [1, 2, 3]) {
			const waited = await run(searchTool(owner).search, { action: "wait", id }, router.context);
			const next = await expected(`${sessionUrl}?cursor=${index + 1}`);
			assert.equal(waited.details?.observation?.kind, "settled");
			assert.deepEqual(waited, {
				...next,
				details: { ...next.details, observation: waited.details?.observation, remainingPages: 3 - index },
			});
		}
		assert.equal(router.calls.length, 4, "the search ran each page once");
	} finally {
		await owner.close("session-close");
	}
});

test("cancelling the caller during a continuation aborts that ordinary search with the caller's reason (#5479)", async () => {
	const owner = host(0),
		caller = new AbortController(),
		reason = new Error("workspace changed");
	const entered = Promise.withResolvers<AbortSignal>();
	const path = "history://sessions/s",
		next = `${path}?cursor=2`;
	const fixture = pagedRouter(2);
	const ctx = {
		internalResourceRouter: {
			search: async (url: string, q: InternalSearchRequest) => {
				if (url === path) return fixture.context.internalResourceRouter.search(url, q);
				assert.equal(url, next);
				const signal = q.signal!;
				entered.resolve(signal);
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				signal.throwIfAborted();
				return "No matches found";
			},
		},
	};
	try {
		const tool = searchTool(owner).search;
		const result = await tool.execute(
			"launch",
			{ paths: path, pattern: "needle", wait: { kind: "background" } },
			caller.signal,
			undefined,
			ctx as never,
		);
		const observed = result.details!.observation!;
		assert.equal(observed.kind, "yielded");
		const running = await entered.promise;
		caller.abort(reason);
		const record = await settledRecord(owner, observed.taskId);
		assert.equal(running.reason, reason);
		assert.ok(record.execution.kind === "settled" && record.execution.result.kind === "cancelled");
		const waited = await run(tool, { action: "wait", id: observed.taskId }, ctx);
		assert.deepEqual(waited.details?.continueWith, [next]);
	} finally {
		caller.abort();
		await owner.close("session-close");
	}
});

test("explicit background yields at once, and a foreground budget yields when it elapses", async () => {
	const owner = host(10_000);
	try {
		const background = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: sessionUrl, wait: { kind: "background" } },
			pagedRouter(3, 50).context,
		);
		assert.equal((background.details as { observation?: { kind: string } }).observation?.kind, "yielded");
		const started = Date.now();
		const foreground = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: sessionUrl, wait: { kind: "foreground", budgetMs: 40 } },
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
			{ pattern: "needle", paths: sessionUrl, timeout: 0.15 },
			pagedRouter(10, 60).context,
		);
		const observed = result.details?.observation;
		assert.ok(observed?.kind === "settled" && observed.result.kind === "cancelled");
		assert.equal(observed.result.cause, "execution-timeout");
		assert.match(text(result), /needle 0/);
		const waited = await run(searchTool(owner).search, { action: "wait", id: observed.taskId }, {});
		assert.match(waited.details!.continueWith![0]!, /^history:\/\/sessions\/s\?cursor=\d+$/);
	} finally {
		await owner.close("session-close");
	}
});

test("kill stops a background history:// search", async () => {
	const owner = host(0);
	const tools = searchTool(owner);
	try {
		const launched = await run(tools.search, { pattern: "needle", paths: sessionUrl }, pagedRouter(100, 50).context);
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

test("/tasks lists a background search in its own section, never as an agent", async () => {
	const owner = host(0);
	try {
		const launched = await run(
			searchTool(owner).search,
			{ pattern: "needle", paths: sessionUrl },
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
