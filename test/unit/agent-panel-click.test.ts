import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import type { TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskRecord } from "../helpers/task-record.js";

type MouseComponent = Component & {
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	dispose?(): void;
};

beforeAll(() => initTheme("dark"));

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function agent(id: string): TaskRecord {
	return { ...taskRecord(id), agentName: "worker", title: `job ${id}` };
}

function extensionAgent(id: string, name: string): AgentPanelItem {
	return { id, kind: "agent", state: "running", name, task: "stage build", progress: { done: 1, total: 3 } };
}

/** A session whose panel lists `tasks` (subagents) and `runs` (extension rows that record what opened them). */
function panelSession(tasks: readonly TaskRecord[], runs: readonly AgentPanelItem[]) {
	const opened: string[] = [];
	const hub = new AgentPanelSourceHub();
	hub.register({ items: () => runs, subscribe: () => () => {}, open: (id) => opened.push(id) });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const store = {
		tasks,
		backgroundTasks: tasks,
		ownerTasks: tasks,
		ownerBackgroundTasks: tasks,
		settlementOrder: new Map(),
		panelRevision: 1,
		taskRecord: (id: string) => tasks.find((task) => task.ref.taskId === id),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: () => () => {},
	};
	bindOwnerTaskStore(session, store as never);
	return { session, opened };
}

function click(component: MouseComponent, y: number, width: number, height: number) {
	return component.handleMouse?.({
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: 30 + y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	});
}

const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

function mountWidget(session: object, inspector?: TaskInspectorUi, requestRender = () => {}) {
	let widget: MouseComponent | undefined;
	const dispose = bindAgentPanel(
		session as never,
		{
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function" ? (content({} as never, {} as never) as MouseComponent) : undefined;
			},
			requestRender,
		} as never,
		undefined,
		inspector,
	);
	disposers.push(dispose);
	if (!widget) throw new Error("the panel did not mount");
	return widget;
}

const noInspector: TaskInspectorUi = {
	custom: async () => {
		throw new Error("no task view is expected here");
	},
};

for (const width of [80, 160]) {
	test(`a click on a row of the panel below the prompt opens that row, and main and +N more open nothing, at ${width} columns`, () => {
		const { session, opened } = panelSession(
			[agent("a1"), agent("a2"), agent("a3")],
			[extensionAgent("run:first", "first-run"), extensionAgent("run:second", "second-run")],
		);
		const widget = mountWidget(session, noInspector);
		const lines = plain(widget.render(width));
		assert.equal(lines[0], "  ● main", lines.join("\n"));
		const more = lines.findIndex((line) => /^ {2}\+\d+ more$/.test(line));
		assert.notEqual(more, -1, lines.join("\n"));
		const second = lines.findIndex((line) => line.includes("second-run"));
		const first = lines.findIndex((line) => line.includes("first-run"));
		assert.ok(first !== -1 || second !== -1, lines.join("\n"));
		const target = first !== -1 ? { row: first, id: "run:first" } : { row: second, id: "run:second" };

		assert.equal(click(widget, more, width, lines.length), undefined, "+N more opens nothing");
		assert.deepEqual(opened, []);
		click(widget, 0, width, lines.length);
		assert.deepEqual(opened, [], "the main row is where the reader already is");
		assert.equal(click(widget, target.row, width, lines.length)?.handled, true);
		assert.deepEqual(opened, [target.id]);
	});
}

test("a click on a row of the focused panel opens it, and a click on main returns to the prompt", async () => {
	const { session, opened } = panelSession([agent("a1")], [extensionAgent("run:first", "first-run")]);
	const run = (row: (lines: readonly string[]) => number) =>
		showAgentPanel(session as never, {
			custom: async (factory) => {
				let finish = () => {};
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const component = (await factory(
					{ requestRender() {} } as never,
					theme,
					new KeybindingsManager(),
					finish as never,
				)) as MouseComponent;
				const lines = plain(component.render(80));
				click(component, row(lines), 80, lines.length);
				await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 50))]);
				component.dispose?.();
				return undefined as never;
			},
		});

	await run((lines) => lines.findIndex((line) => line.includes("first-run")));
	assert.deepEqual(opened, ["run:first"]);

	opened.length = 0;
	let closedWithoutOpening = false;
	await showAgentPanel(session as never, {
		custom: async (factory) => {
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const component = (await factory(
				{ requestRender() {} } as never,
				theme,
				new KeybindingsManager(),
				finish as never,
			)) as MouseComponent;
			const lines = plain(component.render(80));
			const main = lines.findIndex((line) => line.endsWith("● main"));
			assert.notEqual(main, -1, lines.join("\n"));
			click(component, main, 80, lines.length);
			closedWithoutOpening = await Promise.race([
				finished.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
			]);
			component.dispose?.();
			return undefined as never;
		},
	});
	assert.equal(closedWithoutOpening, true, "main closes the panel");
	assert.deepEqual(opened, []);
});

test("a click opens the row that was painted under it, even after the rows changed before the next paint", async () => {
	const opened: string[] = [];
	let runs: AgentPanelItem[] = [extensionAgent("run:b", "run-b"), extensionAgent("run:a", "run-a")];
	const listeners = new Set<() => void>();
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => runs,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		open: (id) => opened.push(id),
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let repaint = () => {};
	const widget = mountWidget(session, noInspector, () => repaint());
	const painted = plain(widget.render(80));
	const row = painted.findIndex((line) => /run-[ab]/.test(line));
	assert.notEqual(row, -1, painted.join("\n"));
	const [top, other] = painted[row]?.includes("run-a") ? ["a", "b"] : ["b", "a"];

	// The other run now waits for an answer and ranks first; the panel has not painted that yet.
	runs = [
		{ ...extensionAgent(`run:${other}`, `run-${other}`), state: "input", question: "Ship it?" },
		extensionAgent(`run:${top}`, `run-${top}`),
	];
	const refreshed = Promise.withResolvers<void>();
	repaint = refreshed.resolve;
	for (const listener of listeners) listener();
	await refreshed.promise;

	click(widget, row, 80, painted.length);
	assert.deepEqual(opened, [`run:${top}`], "the click opens the row the reader saw");
	assert.match(
		plain(widget.render(80))[row] ?? "",
		new RegExp(`run-${other}`),
		"the next paint moves the other run there",
	);
});

test("a press and release on a panel row whose item was swapped for one with the same text opens nothing", async () => {
	const { TuiAltScreen, stripTerminalSequences } = await import("@bastani/atomic-tui");
	const { RecordingTerminal } = await import(
		"../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts"
	);
	const opened: string[] = [];
	let runs: AgentPanelItem[] = [extensionAgent("run:x", "same-name")];
	const listeners = new Set<() => void>();
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => runs,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		open: (id) => opened.push(id),
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 6;
	const tui = new TuiAltScreen(terminal);
	let widget: MouseComponent | undefined;
	const dispose = bindAgentPanel(
		session as never,
		{
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function" ? (content({} as never, {} as never) as MouseComponent) : undefined;
				if (widget) tui.addChild(widget);
			},
			requestRender: () => tui.requestRender(),
		} as never,
		undefined,
		noInspector,
	);
	disposers.push(dispose);
	try {
		tui.start();
		tui.renderNow();
		const row = tui.getScreenLines().findIndex((line) => stripTerminalSequences(line).includes("same-name"));
		assert.notEqual(row, -1);
		terminal.input(`\x1b[<0;5;${row + 1}M`);
		runs = [extensionAgent("run:x2", "same-name")];
		for (const listener of listeners) listener();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		tui.renderNow();
		terminal.input(`\x1b[<0;5;${row + 1}m`);
		tui.renderNow();
		assert.deepEqual(opened, [], "the row now shows another item");
	} finally {
		tui.stop();
	}
});
