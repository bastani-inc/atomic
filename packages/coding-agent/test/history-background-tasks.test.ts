import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionStore } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { type HistoryTaskCompletionMessage, HistoryTaskRegistry } from "../src/core/tools/history-tasks.js";
import { createKillToolDefinition } from "../src/core/tools/kill.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import { createHarness } from "./suite/harness.js";

const PROJECT = resolve("/projects/background-history");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
/** The router's own time budget: a slow store runs it out long before the observation budget. */
const ROUTER_TIME_BUDGET_MS = 40;
/** The observation budget the tests give a call that names no wait. */
const OBSERVATION_BUDGET_MS = 150;
/** How long a waiting observation may take before the test calls it hung. */
const SETTLE_WAIT_MS = 5_000;
/** How long a background history task used to scan before it stopped with a continuation. */
const OLD_TIME_LIMIT_MS = 300_000;
/** Entries in a session that takes several store reads to scan. */
const LONG_SESSION_ENTRIES = 1_000;
/** The refusal past the history tasks a session runs at once, worded as the shell commands' limit is. */
const LIMIT_MESSAGE =
	"4 history searches and reads are already running in this session, the most it runs at once. Stop one you no longer need with kill, or wait for one to finish, then run this one again.";

function entry(seq: number, text: string): SessionEntry {
	const at = BASE + seq * 1_000;
	return {
		type: "message",
		id: `e${seq}`,
		parentId: seq === 1 ? null : `e${seq - 1}`,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

/**
 * A store whose entry reads wait for `open()` while the gate is closed, as a remote store that answers slowly. The
 * first `answered` reads pass the gate.
 */
async function gatedStore(
	entries: SessionEntry[] = [entry(1, "first line"), entry(2, "the NEEDLE is here"), entry(3, "last line")],
	answered = 0,
): Promise<{ store: SessionStore; open: () => void; reads: () => number }> {
	const base = new MemorySessionStore();
	await base.create(
		{ id: "slow", version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
		entries,
	);
	let gate: (() => void) | undefined;
	let opened = false;
	let reads = 0;
	const waiting = new Promise<void>((resolve) => {
		gate = resolve;
	});
	const store = new Proxy(base, {
		get(target, key) {
			if (key === "searchIndex") return undefined;
			if (key === "readEntryRange")
				return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
					if (!opened && ++reads > answered) await waiting;
					return target.readEntryRange(...args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as SessionStore;
	return {
		store,
		open: () => {
			opened = true;
			gate?.();
		},
		reads: () => reads,
	};
}

function tools(store: SessionStore) {
	const notices: HistoryTaskCompletionMessage[] = [];
	let delivered: () => void = () => {};
	const noticeArrived = new Promise<void>((resolve) => {
		delivered = resolve;
	});
	const registry = new HistoryTaskRegistry({
		notify: (message) => {
			notices.push(message);
			delivered();
		},
		automaticBudgetMs: () => OBSERVATION_BUDGET_MS,
	});
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => store,
		budget: { timeMs: ROUTER_TIME_BUDGET_MS },
	});
	const ctx = { internalResourceRouter: router, cwd: PROJECT } as InternalResourceContext;
	const historyTasks = () => registry;
	const search = createSearchToolDefinition(PROJECT, { historyTasks });
	const read = createReadToolDefinition(PROJECT, { historyTasks });
	const kill = createKillToolDefinition({ historyTasks });
	const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
		result.content.map((block) => block.text ?? "").join("\n");
	return {
		registry,
		notices,
		noticeArrived,
		search: async (args: Record<string, unknown>) =>
			search.execute("search", args as never, undefined, undefined, ctx as never),
		read: async (args: Record<string, unknown>) =>
			read.execute("read", args as never, undefined, undefined, ctx as never),
		kill: async (id: string) => textOf(await kill.execute("kill", { id }, undefined, undefined, ctx as never)),
		textOf,
		plainSearch: async (args: Record<string, unknown>) =>
			textOf(
				await createSearchToolDefinition(PROJECT).execute(
					"search",
					args as never,
					undefined,
					undefined,
					ctx as never,
				),
			),
	};
}

/**
 * Moves a scan's clocks onto fake time: the timers a call sets, the clock its time budget reads, and the timeout
 * signals that end its store reads (Node runs those on timers of its own, which fake timers leave alone).
 */
function useFakeClock(): () => void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
		return controller.signal;
	});
	return () => {
		timeout.mockRestore();
		vi.useRealTimers();
	};
}

function taskIdOf(result: { details?: unknown }): string {
	const id = (result.details as { historyTask?: { taskId?: string } } | undefined)?.historyTask?.taskId;
	assert.ok(id, "the call went on as a background history task");
	return id;
}

describe("background history tasks", () => {
	it("a search of a slow store returns a task ID within its observation budget, then delivers its whole result", async () => {
		const { store, open } = await gatedStore();
		const t = tools(store);
		const started = performance.now();
		const yielded = await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow" });
		const elapsed = performance.now() - started;
		const id = taskIdOf(yielded);
		assert.ok(elapsed < SETTLE_WAIT_MS, `the call yielded after ${Math.round(elapsed)} ms`);
		assert.ok(elapsed >= OBSERVATION_BUDGET_MS - 5, "the call was observed for its budget first");
		assert.match(t.textOf(yielded), new RegExp(`History search is still running \\(task ${id}\\)`));
		assert.match(t.textOf(yielded), /kill\(\{ id: "history-\d+" \}\)/);

		open();
		await t.noticeArrived;
		const [notice] = t.notices;
		assert.ok(notice);
		assert.equal(notice.customType, "task-completion");
		assert.equal(notice.details.taskId, id);
		assert.equal(notice.details.notification.status, "completed");
		assert.match(notice.content, /^Background history search completed: \/NEEDLE\/ in history:\/\/sessions\/slow$/m);
		assert.match(notice.content, /^history:\/\/sessions\/slow:2: the NEEDLE is here$/m);
		assert.doesNotMatch(notice.content, /time budget/, "the background scan ran past the router's own time budget");
	});

	it("a wait observes a background search and returns its result instead of a notice", async () => {
		const { store, open } = await gatedStore();
		const t = tools(store);
		const id = taskIdOf(
			await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
		);

		const pending = await t.search({ action: "wait", id, budgetMs: 20 });
		assert.equal(taskIdOf(pending), id);

		const settling = t.search({ action: "wait", id, budgetMs: SETTLE_WAIT_MS });
		open();
		const settled = await settling;
		assert.match(t.textOf(settled), /^history:\/\/sessions\/slow:2: the NEEDLE is here$/m);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(t.notices.length, 0, "the waited result is not delivered a second time");

		const late = await t.read({ action: "wait", id });
		assert.match(t.textOf(late), /the NEEDLE is here/, "a finished task still answers a later wait");
	});

	it("kill stops a background read and its scan, with no notice", async () => {
		const { store, open } = await gatedStore();
		const t = tools(store);
		const id = taskIdOf(await t.read({ path: "history://sessions/slow:1-3", wait: { kind: "background" } }));
		assert.match(await t.kill(id), new RegExp(`History read ${id} was stopped`));
		open();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(t.notices.length, 0);
		const after = await t.read({ action: "wait", id });
		assert.equal(after.isError, true);
		assert.match(t.textOf(after), /was stopped before it finished/);
		assert.match(await t.kill(id), /had already finished; nothing to stop/);
	});

	it("a search of a fast store returns inline exactly as without background tasks", async () => {
		const { store, open } = await gatedStore();
		open();
		const t = tools(store);
		const args = { pattern: "NEEDLE|line", paths: "history://sessions/slow" };
		const inline = await t.search(args);
		assert.equal((inline.details as { historyTask?: unknown } | undefined)?.historyTask, undefined);
		assert.equal(t.textOf(inline), await t.plainSearch(args));
		assert.equal(t.notices.length, 0);
	});

	it("closing stops running tasks without notices, and later calls run inline with the default budget", async () => {
		const { store } = await gatedStore();
		const t = tools(store);
		const id = taskIdOf(
			await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
		);
		await t.registry.close();
		await assert.rejects(t.search({ action: "wait", id }), /Unknown history task/);
		const inline = t.textOf(await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow" }));
		assert.match(inline, /time budget ran out/);
		assert.equal(t.notices.length, 0);
	});

	it("runs at most 4 history tasks at once and refuses the next with a message, until one is stopped", async () => {
		const { store, open } = await gatedStore();
		const t = tools(store);
		const ids: string[] = [];
		for (let index = 0; index < 4; index++)
			ids.push(
				taskIdOf(
					await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
				),
			);
		await assert.rejects(
			t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
			{ message: LIMIT_MESSAGE },
		);
		await assert.rejects(t.read({ path: "history://sessions/slow:1-3" }), { message: LIMIT_MESSAGE });
		await t.kill(ids[0]!);
		taskIdOf(await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }));
		open();
		await t.registry.close();
	});

	it("a history task has no time limit: it scans on past the old 300 seconds and delivers its whole result", async () => {
		// Long enough to take several reads. The first is answered, so the scan has started its time budget when the
		// next one waits.
		const { store, open, reads } = await gatedStore(
			[
				...Array.from({ length: LONG_SESSION_ENTRIES - 1 }, (_, index) => entry(index + 1, `filler ${index + 1}`)),
				entry(LONG_SESSION_ENTRIES, "the NEEDLE is here"),
			],
			1,
		);
		const t = tools(store);
		const restoreClock = useFakeClock();
		try {
			const launched = await t.search({
				pattern: "NEEDLE",
				paths: "history://sessions/slow",
				wait: { kind: "background" },
			});
			taskIdOf(launched);
			assert.match(
				t.textOf(launched),
				/It has no time limit: it runs until it finishes, kill stops it, or this session ends/,
			);
			while (reads() < 2) await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(OLD_TIME_LIMIT_MS + 60_000);
			open();
			await t.noticeArrived;
		} finally {
			restoreClock();
		}
		const [notice] = t.notices;
		assert.equal(notice?.details.notification.status, "completed");
		assert.match(
			notice?.content ?? "",
			new RegExp(`^history://sessions/slow:${LONG_SESSION_ENTRIES}: the NEEDLE is here$`, "m"),
		);
		assert.doesNotMatch(notice?.content ?? "", /time budget/);
	});

	it("kill stops a history task that has run past the old 300 seconds", async () => {
		const { store } = await gatedStore();
		const t = tools(store);
		const restoreClock = useFakeClock();
		let id: string;
		try {
			id = taskIdOf(
				await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
			);
			await vi.advanceTimersByTimeAsync(OLD_TIME_LIMIT_MS + 60_000);
		} finally {
			restoreClock();
		}
		assert.equal(taskIdOf(await t.search({ action: "wait", id, budgetMs: 0 })), id, "it is still running");
		assert.match(await t.kill(id), new RegExp(`History search ${id} was stopped`));
		assert.equal(t.notices.length, 0);
	});

	it("refuses a malformed wait like bash does", async () => {
		const { store } = await gatedStore();
		const t = tools(store);
		await assert.rejects(
			t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "foreground", budgetMs: -1 } }),
			/Invalid wait/,
		);
		await assert.rejects(t.search({ action: "wait", id: "history-1", budgetMs: Number.NaN }), /Invalid search wait/);
	});

	it("a session's history tasks stop when the session closes", async () => {
		const harness = await createHarness();
		let stopped: AbortSignal | undefined;
		try {
			const registry = harness.session._getHistoryTasks();
			assert.ok(registry);
			const receipt = await registry.run({
				kind: "search",
				subject: "/x/ in history://sessions",
				wait: { kind: "background" },
				signal: undefined,
				run: (signal) => {
					stopped = signal;
					return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
				},
			});
			assert.ok(HistoryTaskRegistry.isTaskId(taskIdOf(receipt)));
		} finally {
			await harness.cleanup();
		}
		assert.equal(stopped?.aborted, true);
		assert.equal(harness.session._getHistoryTasks(), undefined);
	});
});
