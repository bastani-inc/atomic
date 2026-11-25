import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionStore } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import {
	type HistoryTaskCompletionMessage,
	HistoryTaskRegistry,
	MAX_ACTIVE_HISTORY_TASKS,
} from "../src/core/tools/history-tasks.js";
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

/** A store whose entry reads wait for `open()` while the gate is closed, as a remote store that answers slowly. */
async function gatedStore(): Promise<{ store: SessionStore; open: () => void }> {
	const base = new MemorySessionStore();
	await base.create(
		{ id: "slow", version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
		[entry(1, "first line"), entry(2, "the NEEDLE is here"), entry(3, "last line")],
	);
	let gate: (() => void) | undefined;
	let opened = false;
	const waiting = new Promise<void>((resolve) => {
		gate = resolve;
	});
	const store = new Proxy(base, {
		get(target, key) {
			if (key === "searchIndex") return undefined;
			if (key === "readEntryRange")
				return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
					if (!opened) await waiting;
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

	it(`runs at most ${MAX_ACTIVE_HISTORY_TASKS} history tasks at once; a call past them runs inline`, async () => {
		const { store, open } = await gatedStore();
		const t = tools(store);
		for (let index = 0; index < MAX_ACTIVE_HISTORY_TASKS; index++)
			taskIdOf(
				await t.search({ pattern: "NEEDLE", paths: "history://sessions/slow", wait: { kind: "background" } }),
			);
		const extra = await t.search({
			pattern: "NEEDLE",
			paths: "history://sessions/slow",
			wait: { kind: "background" },
		});
		assert.equal((extra.details as { historyTask?: unknown } | undefined)?.historyTask, undefined);
		assert.match(t.textOf(extra), /time budget ran out/);
		open();
		await t.registry.close();
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
