import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelExtensionItems,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
	stopAgentPanelItem,
	subscribeAgentPanel,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore, type OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	AGENT_PANEL_FOCUSED_ROWS,
	AGENT_PANEL_IDLE_ROWS,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	AGENT_PANEL_REFRESH_BUDGET_MS,
	AGENT_PANEL_REFRESH_WINDOW_MS,
	agentPanelRows,
	bindAgentPanel,
	setAgentPanelVisible,
	showAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

test("agentPanelBoardSource subscribes to the extension hub only and reads extension items without reading the task store (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("Background task");
		let taskStoreReads = 0;
		const storeProxy = new Proxy(fixture.store, {
			get(target, prop, receiver) {
				if (prop === "tasks" || prop === "backgroundTasks") taskStoreReads++;
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as OwnerTaskStore;
		const hub = new AgentPanelSourceHub();
		const extListeners = new Set<() => void>();
		const runItem: AgentPanelItem = {
			id: "run:r1",
			kind: "workflow",
			state: "running",
			name: "ralph",
			task: "stage build",
		};
		const items: AgentPanelItem[] = [runItem];
		hub.register({
			items: () => items,
			subscribe: (listener) => {
				extListeners.add(listener);
				return () => extListeners.delete(listener);
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };

		const board = agentPanelBoardSource(session);
		let boardNotifications = 0;
		let panelNotifications = 0;
		const unsubscribeBoard = board.subscribe(() => {
			boardNotifications++;
		});
		const unsubscribePanel = subscribeAgentPanel(session, () => {
			panelNotifications++;
		});
		try {
			bindOwnerTaskStore(session, storeProxy);
			assert.equal(panelNotifications, 1, "store binding notifies subscribeAgentPanel");
			assert.equal(boardNotifications, 0, "store binding must not invoke board source listeners");

			await fixture.start("Second background task");
			fixture.runners[0]!.context.reportActivity({
				reportId: "act-1",
				change: { kind: "action", tool: "bash", text: "ls" },
			});
			fixture.store.drain();
			assert.ok(panelNotifications > 1, "subscribeAgentPanel still receives task store notifications");
			assert.equal(boardNotifications, 0, "task store notifications must not invoke board source listeners");

			for (const listener of extListeners) listener();
			assert.equal(boardNotifications, 1, "extension notifications invoke board source listeners");

			items.push({
				id: "task:ext-shadow",
				kind: "agent",
				state: "running",
				name: "ext-agent",
				task: "extension item with task prefix",
			});
			taskStoreReads = 0;
			assert.deepEqual(
				board.items().map((item) => item.id),
				["run:r1"],
			);
			assert.equal(taskStoreReads, 0, "board.items() must not read the task store");

			for (const listener of extListeners) listener();
			assert.deepEqual(
				agentPanelItems(session).map((item) => item.id),
				["run:r1", ...fixture.store.backgroundTasks.map((task) => `task:${task.ref.taskId}`)],
				"an extension item cannot take a reserved task id",
			);
			assert.ok(taskStoreReads > 0, "agentPanelItems still reads the task store");
			items.pop();
			items[0] = { ...items[0]!, state: "done" };
			for (const listener of extListeners) listener();
			const notificationsBeforeDismiss = boardNotifications;

			board.dismiss?.("run:r1");
			taskStoreReads = 0;
			assert.deepEqual(board.items(), []);
			assert.equal(taskStoreReads, 0);
			assert.deepEqual(
				agentPanelItems(session).map((item) => item.kind),
				["agent", "agent"],
				"dismissing on the board source shares dismissals with the agent panel",
			);
			assert.equal(boardNotifications, notificationsBeforeDismiss + 1);
		} finally {
			unsubscribeBoard();
			unsubscribePanel();
		}
		const notificationsAfterUnsubscribe = boardNotifications;
		for (const listener of extListeners) listener();
		assert.equal(boardNotifications, notificationsAfterUnsubscribe, "unsubscribed board listener is not invoked");
	} finally {
		await fixture.dispose();
	}
});

test("bindAgentPanel skips row projection while hidden and budgets burst refreshes (#4009, #5224)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	try {
		await fixture.start("Background worker");
		let sourceReads = 0;
		let now = 1_000;
		let costMs = 0;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const hub = new AgentPanelSourceHub();
		const extListeners = new Set<() => void>();
		hub.register({
			items: () => {
				sourceReads++;
				now += costMs;
				return [{ id: "run:r1", kind: "workflow", state: "running", name: "ralph", task: "stage build" }];
			},
			subscribe: (listener) => {
				extListeners.add(listener);
				return () => extListeners.delete(listener);
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);
		const ui = {
			setWidget: () => {},
			requestRender: () => {},
		} satisfies Pick<ExtensionUIContext, "setWidget" | "requestRender">;

		const dispose = bindAgentPanel(session, ui);
		try {
			setAgentPanelVisible(session, false);
			sourceReads = 0;
			for (const listener of extListeners) listener();
			assert.equal(sourceReads, 0, "hidden panel must not compute rows on store or extension updates");

			setAgentPanelVisible(session, true);
			assert.equal(sourceReads, 1, "making the panel visible computes rows once");

			costMs = 0;
			const beforeCheap = sourceReads;
			for (let i = 0; i < 20; i++) {
				for (const listener of extListeners) listener();
			}
			assert.equal(sourceReads, beforeCheap, "a burst of changes in one turn is not projected synchronously");
			await Promise.resolve();
			assert.equal(sourceReads - beforeCheap, 1, "a burst of changes in one turn refreshes once");

			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			costMs = AGENT_PANEL_REFRESH_BUDGET_MS + 5;
			const before = sourceReads;
			for (let turn = 0; turn < 6; turn++) {
				for (const listener of extListeners) listener();
				await Promise.resolve();
			}
			const immediate = sourceReads - before;
			assert.ok(immediate < 6, `an expensive burst across turns defers once its budget is spent, got ${immediate}`);
			ui.requestRender = () => {
				throw new Error("Host closed during deferred refresh");
			};
			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			assert.doesNotThrow(
				() => vi.advanceTimersByTime(AGENT_PANEL_REFRESH_WINDOW_MS),
				"deferred refresh contains host errors",
			);
			assert.equal(sourceReads - before, immediate + 1, "the deferred refresh runs once at window end");
		} finally {
			dispose();
		}
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await fixture.dispose();
	}
});

test("extension panel sources validate malformed items and isolate throwing sources and actions (#5224)", async () => {
	const hub = new AgentPanelSourceHub();
	const errors: string[] = [];
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			emitError: (error: { error: string }) => {
				errors.push(error.error);
			},
		},
	};
	const valid: AgentPanelItem = {
		id: "run:ok",
		kind: "workflow",
		state: "input",
		name: "deploy",
		task: "stage approve",
		elapsedMs: 1_000,
		tokens: 500,
		progress: { done: 1, total: 2 },
		question: "Proceed?",
		choices: ["Yes", "No"],
	};
	hub.register({
		items: () => {
			throw Symbol("broken-items");
		},
		subscribe: () => () => {},
	});
	hub.register({
		items: () =>
			[
				valid,
				{ ...valid, id: 42 },
				{ ...valid, id: "run:bad-kind", kind: "unknown" },
				{ ...valid, id: "run:bad-state", state: "bogus" },
				{ ...valid, id: "run:bad-name", name: null },
				{ ...valid, id: "run:bad-task", task: 123 },
				{ ...valid, id: "run:bad-elapsed", elapsedMs: Number.NaN },
				{ ...valid, id: "run:bad-tokens", tokens: 10n },
				{ ...valid, id: "run:bad-progress", progress: { done: -1, total: 3 } },
				{ ...valid, id: "run:bad-question", question: 99 },
				{ ...valid, id: "run:bad-choices", choices: ["Yes", 2] },
				{ ...valid, id: "run:bad-reason", reason: {} },
				null,
				{ ...valid, id: "run:negative-tokens", tokens: -1 },
				{ ...valid, id: "run:string-choices", choices: "Yes" },
			] as unknown as AgentPanelItem[],
		subscribe: () => () => {},
		open: () => {
			throw new Error("open failed");
		},
		stop: async () => ({ ok: false, reason: Symbol("stop-symbol") as unknown as string }),
		answer: async () => {
			throw Object.create(null);
		},
	});

	assert.deepEqual(
		agentPanelExtensionItems(session).map((item) => item.id),
		["run:ok"],
	);
	assert.equal(errors.length, 2);
	assert.deepEqual(
		agentPanelItems(session).map((item) => item.id),
		["run:ok"],
	);
	assert.equal(errors.length, 2, "each malformed or throwing source is reported at most once");

	assert.equal(openAgentPanelItem(session, "run:ok"), false);
	const stopped = await stopAgentPanelItem(session, "run:ok");
	assert.equal(stopped.ok, false);
	if (!stopped.ok) assert.equal(typeof stopped.reason, "string");
	const badStopId = await stopAgentPanelItem(session, 42 as unknown as string);
	assert.equal(badStopId.ok, false);
	const answered = await answerAgentPanelItem(session, "run:ok", "Yes");
	assert.equal(answered.ok, false);
	if (!answered.ok) assert.equal(typeof answered.reason, "string");
});

test("showAgentPanel does not mark a workflow row viewed when open returns false or throws and notifies on false (#5224)", async () => {
	initTheme("dark");
	let now = 10_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const hub = new AgentPanelSourceHub();
		const errors: string[] = [];
		const notices: string[] = [];
		hub.register({
			items: () => [
				{ id: "run:false", kind: "workflow", state: "done", name: "refused-wf", task: "stage 1" },
				{ id: "run:throw", kind: "workflow", state: "done", name: "throwing-wf", task: "stage 1" },
			],
			subscribe: () => () => {},
			open: (id) => {
				if (id === "run:false") return false;
				throw new Error("graph boom");
			},
		});
		const session = {
			extensionRunner: {
				getAgentPanelSourceHub: () => hub,
				emitError: (err: { error: string }) => {
					errors.push(err.error);
				},
			},
		};
		const openRow = async (selectId: string) => {
			await showAgentPanel(
				session,
				{
					notify: (msg) => notices.push(msg),
					custom: async (factory) => {
						let finish = () => {};
						const finished = new Promise<void>((resolve) => {
							finish = resolve;
						});
						const component = await factory(
							{ requestRender() {} } as never,
							theme,
							new KeybindingsManager(),
							finish,
						);
						setImmediate(() => component.handleInput?.("\r"));
						await finished;
						component.dispose?.();
						return undefined as never;
					},
				},
				selectId,
			);
		};

		await openRow("run:false");
		assert.deepEqual(notices, ["Could not open refused-wf."]);
		assert.deepEqual(errors, []);

		await openRow("run:throw");
		assert.deepEqual(notices, ["Could not open refused-wf.", "Could not open throwing-wf."]);
		assert.equal(errors.length, 1);

		now += 24 * 60 * 60_000;
		assert.deepEqual(
			agentPanelRows(session).map((row) => row.id),
			["run:throw", "run:false"],
			"finished workflow rows whose open failed or threw remain unviewed and do not age out",
		);
	} finally {
		clock.mockRestore();
	}
});

test("extension agent and shell items share one session clock across the agent panel and /tasks (#5224)", async () => {
	initTheme("dark");
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		await fixture.start("native worker");
		const hub = new AgentPanelSourceHub();
		let state: "running" | "stopped" = "running";
		let reportedMs = 1_000;
		let notify = () => {};
		hub.register({
			items: () => [
				{
					id: "run:wf-1",
					kind: "workflow",
					state: "running",
					name: "wf",
					task: "stage 1",
				},
				{
					id: "ext:agent-shared",
					kind: "agent",
					state,
					name: "ext-helper",
					task: "check cluster",
					elapsedMs: reportedMs,
				},
			],
			subscribe: (listener) => {
				notify = listener;
				return () => {};
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		bindOwnerTaskStore(session, fixture.store);

		const initialRows = agentPanelRows(session);
		assert.deepEqual(
			initialRows.map((row) => row.id),
			["run:wf-1", `task:${fixture.store.backgroundTasks[0]!.ref.taskId}`, "ext:agent-shared"],
		);
		assert.equal(initialRows[2]?.elapsedMs, 1_000);
		now += 60_000;
		assert.equal(agentPanelRows(session)[2]?.elapsedMs, 61_000);

		const inspector = new TaskInspector(
			fixture.store,
			() => {},
			() => {},
		);
		inspector.setBoardSource(agentPanelBoardSource(session));
		inspector.open();
		try {
			const rendered = inspector.renderViewport(120, 20).join("\n");
			assert.match(
				stripVTControlCharacters(rendered),
				/ext-helper +check cluster +1m\b/,
				"opening /tasks must not jump the extension item's elapsed time back to 1s",
			);
			assert.equal(agentPanelRows(session)[2]?.elapsedMs, 61_000);

			state = "stopped";
			notify();
			assert.equal(agentPanelRows(session)[2]?.elapsedMs, 61_000);
			now += 30_000;
			state = "running";
			reportedMs = 2_000;
			notify();
			assert.equal(agentPanelRows(session)[2]?.elapsedMs, 2_000, "restarted extension item starts a fresh clock");
		} finally {
			inspector.dispose();
		}
	} finally {
		clock.mockRestore();
		await fixture.dispose();
	}
});

test.each(["agent", "shell"] as const)(
	"an extension %s entering the panel window keeps time from its first listing (#5233)",
	async (kind) => {
		initTheme("dark");
		let now = 100_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const fixture = taskFixture();
		const hub = new AgentPanelSourceHub();
		let items: AgentPanelItem[] = Array.from({ length: 5 }, (_, index) => ({
			id: `ext:${index}`,
			kind,
			state: "running",
			name: `helper-${index}`,
			task: "check",
			elapsedMs: 1_000,
		}));
		hub.register({ items: () => items, subscribe: () => () => {} });
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		const release = bindAgentPanel(session, { setWidget() {}, requestRender() {} });
		try {
			now += 60_000;
			items = items.slice(0, 4);
			const rows = agentPanelRows(session);
			if (kind === "shell")
				assert.equal(
					rows.some((row) => row.id === "ext:0"),
					false,
					"a shell is listed in /tasks, not the panel",
				);
			else assert.equal(rows.find((row) => row.id === "ext:0")?.elapsedMs, 61_000);
			const inspector = new TaskInspector(
				fixture.store,
				() => {},
				() => {},
			);
			try {
				inspector.setBoardSource(agentPanelBoardSource(session));
				assert.match(
					stripVTControlCharacters(inspector.renderViewport(120, 20).join("\n")),
					/helper-0 +check +1m\b/,
				);
			} finally {
				inspector.dispose();
			}
		} finally {
			release();
			clock.mockRestore();
			await fixture.dispose();
		}
	},
);

test("bindAgentPanel and showAgentPanel project and clock only the drawn rows and keep hidden counts (#5224)", async () => {
	initTheme("dark");
	const now = 50_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		for (let i = 0; i < 20; i++) {
			await fixture.start(`Task ${i}`);
		}
		let hiddenTitleReads = 0;
		let hiddenMetricsReads = 0;
		const rawTasks = fixture.store.backgroundTasks;
		const guardedTasks = rawTasks.map((task, index) => {
			if (index >= rawTasks.length - AGENT_PANEL_FOCUSED_ROWS) return task;
			const copy = { ...task };
			Object.defineProperty(copy, "title", {
				enumerable: true,
				get() {
					hiddenTitleReads++;
					return task.title;
				},
			});
			Object.defineProperty(copy, "metrics", {
				enumerable: true,
				get() {
					hiddenMetricsReads++;
					return task.metrics;
				},
			});
			return copy;
		});
		vi.spyOn(fixture.store, "backgroundTasks", "get").mockReturnValue(guardedTasks);

		const session = {};
		bindOwnerTaskStore(session, fixture.store);
		let widget: { render(width: number): string[] } | undefined;
		const dispose = bindAgentPanel(session, {
			setWidget(_key, factory) {
				widget = typeof factory === "function" ? (factory({} as never, {} as never) as never) : undefined;
			},
			requestRender() {},
		});
		try {
			assert.ok(widget);
			const idleLines = widget.render(100);
			assert.equal(idleLines.length, 1 + AGENT_PANEL_IDLE_ROWS + 1, "main, the capped rows and +N more");
			assert.match(idleLines.at(-1)!, new RegExp(`\\+${20 - AGENT_PANEL_IDLE_ROWS} more`));
			assert.equal(hiddenTitleReads, 0, "unfocused panel must not project titles of hidden native tasks");
			assert.equal(hiddenMetricsReads, 0, "unfocused panel must not read metrics/clocks of hidden native tasks");

			await showAgentPanel(session, {
				custom: async (factory) => {
					let finish = () => {};
					const finished = new Promise<void>((resolve) => {
						finish = resolve;
					});
					const component = await factory(
						{ requestRender() {} } as never,
						theme,
						new KeybindingsManager(),
						finish,
					);
					const focusedLines = component.render(100);
					assert.equal(focusedLines.length, 1 + AGENT_PANEL_FOCUSED_ROWS + 1 + 1);
					assert.match(focusedLines.at(-2)!, new RegExp(`\\+${20 - AGENT_PANEL_FOCUSED_ROWS} more`));
					assert.equal(hiddenTitleReads, 0, "focused panel at top must not project hidden native tasks");
					assert.equal(hiddenMetricsReads, 0, "focused panel at top must not clock hidden native tasks");
					setImmediate(() => finish());
					await finished;
					component.dispose?.();
					return undefined as never;
				},
			});
		} finally {
			dispose();
		}
	} finally {
		clock.mockRestore();
		await fixture.dispose();
	}
});
