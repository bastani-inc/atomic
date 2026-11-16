import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
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
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	AGENT_PANEL_REFRESH_BUDGET_MS,
	AGENT_PANEL_REFRESH_BURST,
	AGENT_PANEL_REFRESH_WINDOW_MS,
	bindAgentPanel,
	setAgentPanelVisible,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
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

			assert.deepEqual(
				agentPanelItems(session).map((item) => item.id),
				["run:r1", "task:ext-shadow", ...fixture.store.backgroundTasks.map((task) => `task:${task.ref.taskId}`)],
			);
			assert.ok(taskStoreReads > 0, "agentPanelItems still reads the task store");
			items.pop();

			board.dismiss?.("run:r1");
			taskStoreReads = 0;
			assert.deepEqual(board.items(), []);
			assert.equal(taskStoreReads, 0);
			assert.deepEqual(
				agentPanelItems(session).map((item) => item.kind),
				["agent", "agent"],
				"dismissing on the board source shares dismissals with the agent panel",
			);
		} finally {
			unsubscribeBoard();
			unsubscribePanel();
		}
		for (const listener of extListeners) listener();
		assert.equal(boardNotifications, 1, "unsubscribed board listener is not invoked");
	} finally {
		await fixture.dispose();
	}
});

test("panelItemsFromSnapshot over store.graphSnapshot().runs does not walk settled stages as a long run advances (#4642)", () => {
	const store = createStore();
	const stages: StageSnapshot[] = Array.from({ length: 200 }, (_, index) => ({
		id: `stage-${index}`,
		name: `stage-${index}`,
		status: "completed",
		parentIds: index === 0 ? [] : [`stage-${index - 1}`],
		toolEvents: [],
	}));
	const run: RunSnapshot = {
		id: "run-long",
		name: "long-run",
		inputs: {},
		status: "running",
		stages,
		toolNodes: [],
		startedAt: 1_000,
	};
	store.recordRunStart(run);
	assert.deepEqual(panelItemsFromSnapshot(store.graphSnapshot().runs, 5_000), [
		{
			id: "run:run-long",
			kind: "workflow",
			state: "running",
			name: "long-run",
			task: "",
			elapsedMs: 4_000,
			progress: { done: 200, total: 200 },
		},
	]);

	store.recordStageStart("run-long", {
		id: "stage-200",
		name: "active-stage",
		status: "running",
		parentIds: ["stage-199"],
		toolEvents: [],
	});
	const snap = store.graphSnapshot();
	let settledStageReads = 0;
	for (let i = 0; i < 200; i++) {
		const settledStage = snap.runs[0]!.stages[i]!;
		Object.defineProperty(snap.runs[0]!.stages, i, {
			get() {
				settledStageReads++;
				return settledStage;
			},
		});
	}
	const items = panelItemsFromSnapshot(snap.runs, 6_000);
	assert.equal(settledStageReads, 0, "panelItemsFromSnapshot must not scan settled stages");
	assert.equal(items[0]?.task, "stage active-stage");
	assert.deepEqual(items[0]?.progress, { done: 200, total: 201 });
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
			assert.equal(sourceReads - beforeCheap, 20, "cheap refreshes follow every change immediately");

			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			costMs = 3;
			const before = sourceReads;
			for (let i = 0; i < 50; i++) {
				for (const listener of extListeners) listener();
			}
			const immediate = sourceReads - before;
			assert.ok(
				immediate <= Math.max(AGENT_PANEL_REFRESH_BURST, Math.ceil(AGENT_PANEL_REFRESH_BUDGET_MS / costMs) + 1),
				`expected bounded immediate refreshes in burst, got ${immediate}`,
			);
			assert.equal(vi.getTimerCount(), 2, "one panel tick and one coalesced trailing refresh");
			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			vi.advanceTimersByTime(AGENT_PANEL_REFRESH_WINDOW_MS);
			assert.equal(sourceReads - before, immediate + 1, "trailing refresh runs once at window end");

			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			for (const listener of extListeners) listener();
			assert.equal(sourceReads - before, immediate + 2, "next quiet window refreshes immediately again");

			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			for (let i = 0; i < 50; i++) {
				for (const listener of extListeners) listener();
			}
			assert.equal(vi.getTimerCount(), 2);
			ui.requestRender = () => {
				throw new Error("Host closed during deferred refresh");
			};
			now += AGENT_PANEL_REFRESH_WINDOW_MS;
			assert.doesNotThrow(
				() => vi.advanceTimersByTime(AGENT_PANEL_REFRESH_WINDOW_MS),
				"deferred refresh contains host errors",
			);
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
