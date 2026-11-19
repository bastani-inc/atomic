import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	AGENT_PANEL_FADE_MS,
	AGENT_PANEL_IDLE_ROWS,
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	type AgentPanelCounts,
	agentPanelCounts,
	bindAgentPanel,
	setAgentPanelVisible,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("a finished workflow run that stays until viewed stops the panel's tick once it has faded (#5224)", () => {
	initTheme("dark");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	let now = 1_800_000_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const retainedCount = AGENT_PANEL_IDLE_ROWS + 1;
	for (const count of [1, retainedCount]) {
		const hub = new AgentPanelSourceHub();
		const ended = Array.from(
			{ length: count },
			(_, index): AgentPanelItem => ({
				id: `run:old-${index}`,
				kind: "workflow",
				state: "done",
				name: `release-${index}`,
				task: "",
				elapsedMs: 60_000,
				endedAt: now - 3 * 24 * 60 * 60_000,
			}),
		);
		hub.register({ items: () => ended, subscribe: () => () => {} });
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		let renders = 0;
		let mountedWidget: { render(width: number): string[] } | undefined;
		let latestCounts: AgentPanelCounts | undefined;
		const dispose = bindAgentPanel(
			session,
			{
				setWidget(_key: string, factory?: () => { render(width: number): string[] }) {
					mountedWidget = factory?.();
				},
				requestRender() {
					renders++;
				},
			} as never,
			(counts) => {
				latestCounts = counts;
			},
		);
		try {
			assert.deepEqual(latestCounts, {
				total: count,
				agents: 0,
				needsInput: 0,
				shells: 0,
				searches: 0,
				subagents: 0,
			});
			assert.ok(mountedWidget);
			const initialLines = mountedWidget.render(80).map((line) => stripVTControlCharacters(line));
			assert.equal(initialLines.length, count === 1 ? 1 : AGENT_PANEL_IDLE_ROWS + 1);
			if (count > AGENT_PANEL_IDLE_ROWS) {
				assert.match(initialLines.at(-1) ?? "", /\+1 more/);
			}
			for (let second = 0; second < 3600; second++) {
				now += 1000;
				vi.advanceTimersByTime(1000);
			}
			assert.ok(
				renders > 0 && renders < 120,
				`an idle hour with ${count} retained workflow(s) repaints only until faded, got ${renders}`,
			);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			dispose();
			hub.dispose();
		}
	}

	const hub = new AgentPanelSourceHub();
	const retainedWorkflows = Array.from(
		{ length: AGENT_PANEL_IDLE_ROWS },
		(_, index): AgentPanelItem => ({
			id: `run:kept-${index}`,
			kind: "workflow",
			state: "done",
			name: `kept-${index}`,
			task: "",
			elapsedMs: 60_000,
			endedAt: now - 3 * 24 * 60 * 60_000,
		}),
	);
	const expiringHidden: AgentPanelItem = {
		id: "ext:expiring-hidden",
		kind: "agent",
		state: "done",
		name: "worker-done",
		task: "done",
		elapsedMs: 5_000,
		endedAt: now - 1_000,
	};
	hub.register({ items: () => [...retainedWorkflows, expiringHidden], subscribe: () => () => {} });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const countsHistory: AgentPanelCounts[] = [];
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(
		session,
		{
			setWidget(_key: string, factory?: () => { render(width: number): string[] }) {
				widget = factory?.();
			},
			requestRender() {},
		} as never,
		(counts) => {
			countsHistory.push(counts);
		},
	);
	try {
		// The finished subagent left the moment it finished: it is neither listed nor counted.
		assert.deepEqual(countsHistory, [
			{ total: AGENT_PANEL_IDLE_ROWS, agents: 0, needsInput: 0, shells: 0, searches: 0, subagents: 0 },
		]);
		assert.ok(widget);
		const lines = widget.render(80).map((line) => stripVTControlCharacters(line));
		assert.equal(lines.length, AGENT_PANEL_IDLE_ROWS);
		assert.doesNotMatch(lines.at(-1) ?? "", /\+1 more/);
		const fadeSeconds = Math.ceil(AGENT_PANEL_FADE_MS / 1000) + 1;
		for (let second = 0; second < fadeSeconds; second++) {
			now += 1000;
			vi.advanceTimersByTime(1000);
		}
		assert.deepEqual(countsHistory.at(-1), {
			total: AGENT_PANEL_IDLE_ROWS,
			agents: 0,
			needsInput: 0,
			shells: 0,
			searches: 0,
			subagents: 0,
		});
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		dispose();
		hub.dispose();
	}
});

test("a failed run's reason is cut at a whole character, never a lone surrogate (#5239)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "run-surrogate",
		name: "release",
		inputs: {},
		status: "failed",
		stages: [{ id: "build", name: "build", status: "failed", parentIds: [], toolEvents: [] } as StageSnapshot],
		toolNodes: [],
		startedAt: 1,
		endedAt: 2,
		error: `${"a".repeat(118)}😀 tail`,
	});
	const [item] = panelItemsFromSnapshot(store.runs(), 3);
	assert.ok(item);
	assert.equal(item.state, "failed");
	assert.ok(item.task.isWellFormed(), `the reason is well formed: ${JSON.stringify(item.task.slice(-4))}`);
	assert.match(item.task, /…$/);
});

test("between 40 and 56 columns a row keeps its state word whole instead of clipping the right column (#5239)", () => {
	const row: AgentPanelRow = {
		id: "task:debugger",
		kind: "agent",
		state: "input",
		name: "debugger",
		task: "Which approach should the fix take for the spawn lock?",
		elapsedMs: 5_460_000,
	};
	for (let width = 40; width <= 56; width++) {
		const [line] = renderAgentPanelRows([row], width, plain).map((text) => stripVTControlCharacters(text));
		assert.ok(line !== undefined);
		assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		assert.match(line, /needs input( · 1h 31m)?$/, `${width}: the right column ends whole: ${JSON.stringify(line)}`);
	}
});

test("workflow panel rows aggregate stage tokens including nested child runs without double counting and render the stage bar without the stage name (#5239)", () => {
	const stageWithUsage = (
		id: string,
		status: StageSnapshot["status"],
		inputTokens?: number,
		outputTokens?: number,
		extra: Partial<StageSnapshot> = {},
	): StageSnapshot => ({
		id,
		name: id,
		status,
		parentIds: [],
		toolEvents: [],
		...(inputTokens === undefined && outputTokens === undefined
			? {}
			: {
					modelAttempts: [
						{ model: "mock/model", success: true, usage: { input: inputTokens ?? 0, output: outputTokens ?? 0 } },
					],
				}),
		...extra,
	});
	const runs: RunSnapshot[] = [
		{
			id: "root-wf",
			name: "ralph",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			toolNodes: [],
			stages: [
				stageWithUsage("plan", "completed", 5_000, 15_000),
				stageWithUsage("delegate", "running", 50_000, 49_000, {
					workflowChildRun: { runId: "child-wf", workflow: "child", alias: "child" },
				}),
				stageWithUsage("verify", "pending"),
			],
		},
		{
			id: "child-wf",
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: "root-wf",
			parentStageId: "delegate",
			rootRunId: "root-wf",
			startedAt: 2_000,
			toolNodes: [],
			stages: [
				stageWithUsage("impl-a", "completed", 10_000, 15_000),
				stageWithUsage("impl-b", "completed", 6_000, 10_000),
				stageWithUsage("impl-c", "running"),
			],
		},
	];
	const [item] = panelItemsFromSnapshot(runs, 1_000 + 12 * 60_000);
	assert.ok(item);
	assert.equal(item.task, "stage impl-c");
	assert.deepEqual(item.progress, { done: 3, total: 5 });
	assert.equal(item.tokens, 61_000);

	for (const width of [80, 160]) {
		const [rendered] = renderAgentPanelRows([item], width, plain).map((text) => stripVTControlCharacters(text));
		assert.ok(rendered);
		assert.equal(visibleWidth(rendered), width);
		assert.equal(
			rendered.replace(/ {2,}/g, "  ").trimEnd(),
			"  ∀ ralph  ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱  3/5 stages  12m · ↓ 61.0k tokens",
		);
		assert.doesNotMatch(rendered, /impl-c/);
	}

	const store = createStore();
	store.recordRunStart({
		id: "published-token-run",
		name: "ralph",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [stageWithUsage("plan", "completed", 20_000, 41_000), stageWithUsage("build", "running")],
	});
	const [publishedItem] = panelItemsFromSnapshot(store.graphSnapshot(), 1_000 + 12 * 60_000, store);
	assert.equal(publishedItem?.tokens, 61_000);
});

test("bindAgentPanel reports cap-independent total and needsInput counts, deduplicates unchanged ticks, contains callback throws, preserves counts while hidden, and resets on empty or dispose (#5239)", () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	let items: AgentPanelItem[] = Array.from({ length: 10 }, (_, index) => ({
		id: `ext:item-${index}`,
		kind: "agent" as const,
		state: index < 3 ? ("input" as const) : ("running" as const),
		name: `worker-${index}`,
		task: `task-${index}`,
		...(index < 3 ? { question: `Question ${index}?` } : {}),
		elapsedMs: 5_000,
	}));
	let notifySource = () => {};
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			notifySource = listener;
			return () => {};
		},
		open: () => true,
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const recorded: AgentPanelCounts[] = [];
	let shouldThrow = true;
	const dispose = bindAgentPanel(
		session,
		{
			setWidget() {},
			requestRender() {},
		} as never,
		(counts) => {
			recorded.push(counts);
			if (shouldThrow) {
				shouldThrow = false;
				throw new Error("host callback boom");
			}
		},
	);
	try {
		assert.deepEqual(recorded, [{ total: 10, agents: 10, needsInput: 3, shells: 0, searches: 0, subagents: 0 }]);
		assert.deepEqual(agentPanelCounts(session), {
			total: 10,
			agents: 10,
			needsInput: 3,
			shells: 0,
			searches: 0,
			subagents: 0,
		});

		openAgentPanelItem(session, "ext:item-0");
		assert.deepEqual(agentPanelCounts(session), {
			total: 10,
			agents: 10,
			needsInput: 3,
			shells: 0,
			searches: 0,
			subagents: 0,
		});

		notifySource();
		assert.equal(recorded.length, 1, "unchanged counts are not re-emitted");

		setAgentPanelVisible(session, false);
		assert.equal(recorded.length, 1, "hiding the panel keeps the published counts");
		setAgentPanelVisible(session, true);
		assert.equal(recorded.length, 1, "showing the panel with unchanged counts does not re-emit");

		items = [];
		notifySource();
	} finally {
		dispose();
	}
	assert.deepEqual(recorded.at(-1), { total: 0, agents: 0, needsInput: 0, shells: 0, searches: 0, subagents: 0 });
});
