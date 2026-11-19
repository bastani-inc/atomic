import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripHintMarkers } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	dismissedAgentPanelItems,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore, setTaskTurnInterrupted } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AGENT_PANEL_FADE_MS,
	AgentPanelFocus,
	type AgentPanelStyle,
	isFinishedPanelRow,
	renderAgentPanelHint,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { dismissedTasks } from "../../packages/coding-agent/src/modes/interactive/components/task-dismissal.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	AGENT_PANEL_REFRESH_WINDOW_MS,
	agentPanelRows,
	bindAgentPanel,
	showAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const plain: AgentPanelStyle = {
	// Hint lines are compared as the terminal shows them, without their zero-width click markers.
	dim: (text) => stripHintMarkers(text),
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

const row = (id: string, state: AgentPanelItem["state"] = "running"): AgentPanelItem => ({
	id,
	kind: "workflow",
	state,
	name: id,
	task: "repair the spawn lock",
	elapsedMs: 1_000,
});

test("workflow panel elapsed advances every second through repeated cached projections (#5239)", () => {
	let now = 100_000;
	const date = vi.spyOn(Date, "now").mockImplementation(() => now);
	const hub = new AgentPanelSourceHub();
	let reads = 0;
	hub.register({
		items: () => {
			reads++;
			return [row("run:clock")];
		},
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		assert.equal(agentPanelRows(session)[0]?.elapsedMs, 1_000);
		for (let seconds = 1; seconds <= 90; seconds++) {
			now += 1_000;
			assert.equal(agentPanelRows(session)[0]?.elapsedMs, (seconds + 1) * 1_000, `second ${seconds}`);
		}
		assert.equal(reads, 1);
	} finally {
		hub.dispose();
		date.mockRestore();
	}
});

const keys = {
	matches: (data: string, action: string) =>
		data === (action === "app.list.stop" ? "x" : action === "app.keys.help" ? "?" : "enter"),
	getKeys: (action: string) =>
		action === "app.list.stop" ? ["x"] : action === "app.keys.help" ? ["?"] : ["enter", "right"],
};
const literalKey = (data: string, key: string) => data === key;

function focusHarness(initial: AgentPanelItem[]) {
	const dismissed: string[] = [];
	const focus = new AgentPanelFocus(keys, {
		open() {},
		stop() {},
		close() {},
		dismiss: (item) => dismissed.push(item.id),
	});
	focus.update(initial);
	focus.enter();
	return { focus, dismissed };
}

test("removing the selected panel row falls forward before falling back (#5239)", () => {
	const items = [row("run:a"), row("run:b"), row("run:c"), row("run:d")];
	const { focus } = focusHarness(items);
	focus.enter("run:c");
	focus.update(items.filter((item) => item.id !== "run:c"));
	assert.equal(focus.selectedId, "run:d");
	focus.update(items.slice(0, 2));
	assert.equal(focus.selectedId, "run:b");
	focus.update([]);
	assert.equal(focus.selectedId, "main");
});

test("moving to an unpainted finished panel row never dismisses it in the same frame (#5239)", () => {
	const items = Array.from({ length: 10 }, (_, index) => row(`run:${index}`, "done"));
	const { focus, dismissed } = focusHarness(items);
	focus.notePainted(items.slice(0, 8));
	focus.handleInput("end", literalKey);
	focus.handleInput("x", literalKey);
	assert.deepEqual(dismissed, []);
	focus.notePainted(items.slice(2));
	focus.handleInput("x", literalKey);
	assert.deepEqual(dismissed, ["run:9"]);
});

test("the finished-while-armed hint names the next x action before and after acknowledgment (#5239)", () => {
	const running = row("run:worker");
	const { focus, dismissed } = focusHarness([running]);
	focus.notePainted([running]);
	focus.handleInput("x", literalKey);
	const finished = { ...running, state: "done" as const };
	focus.update([finished]);
	assert.match(renderAgentPanelHint(focus, 100, plain, keys), /x to acknowledge/);
	focus.handleInput("x", literalKey);
	assert.deepEqual(dismissed, []);
	focus.notePainted([finished]);
	assert.match(renderAgentPanelHint(focus, 100, plain, keys), /x to dismiss/);
	focus.handleInput("x", literalKey);
	assert.deepEqual(dismissed, [running.id]);
});

test("the main panel row lists its live open keys (#5239)", () => {
	const { focus } = focusHarness([{ ...row("task:worker"), kind: "agent" }]);
	focus.handleInput("home", literalKey);
	assert.match(renderAgentPanelHint(focus, 160, plain, keys), /enter\/→ to open/);
	assert.doesNotMatch(renderAgentPanelHint(focus, 160, plain, keys), /x stop/);
});

test("a narrow panel hides a task cell that cannot hold a useful prefix (#5239)", () => {
	for (const width of [51, 52, 53]) {
		const [line] = renderAgentPanelRows(
			[{ ...row("run:long-worker", "paused"), name: "abcdefghijklmn", queued: 1, elapsedMs: 5_460_000 }],
			width,
			plain,
		);
		assert.ok(line);
		assert.doesNotMatch(stripVTControlCharacters(line), /r(?:e(?:p)?)?(?:\.\.\.|…)/, line);
	}
});

test("paused and queued panel rows keep no elapsed repaint timer (#5239)", () => {
	initTheme("dark");
	vi.useFakeTimers();
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [row("run:paused", "paused"), row("run:queued", "queued")],
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let renders = 0;
	const dispose = bindAgentPanel(session, { setWidget() {}, requestRender: () => renders++ } as never);
	try {
		assert.equal(renders, 1);
		vi.advanceTimersByTime(3_600_000);
		assert.equal(renders, 1);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		dispose();
		hub.dispose();
		vi.useRealTimers();
	}
});

test("a focused paused panel has no recurring repaint timer (#5239)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	const hub = new AgentPanelSourceHub();
	hub.register({ items: () => [row("run:paused-focus", "paused")], subscribe: () => () => {} });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		await showAgentPanel(session, {
			custom: async (
				factory: (...args: never[]) => {
					render(width: number): string[];
					handleInput(data: string): void;
					dispose(): void;
				},
			) => {
				let renders = 0;
				const component = factory(
					{ requestRender: () => renders++ } as never,
					theme as never,
					new KeybindingsManager() as never,
					(() => {}) as never,
				);
				try {
					component.render(80);
					vi.advanceTimersByTime(3_600_000);
					assert.equal(renders, 0);
					assert.equal(vi.getTimerCount(), 0);
				} finally {
					component.dispose();
				}
			},
		} as never);
	} finally {
		hub.dispose();
		vi.useRealTimers();
	}
});

test("a finished workflow opened outside the panel leaves it without another source event (#5239)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	const hub = new AgentPanelSourceHub();
	hub.register({ items: () => [row("run:opened", "done")], subscribe: () => () => {}, open: () => true });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let widget: object | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, value: object | undefined) {
			widget = value;
		},
		requestRender() {},
	} as never);
	try {
		vi.advanceTimersByTime(31_000);
		assert.ok(widget);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(openAgentPanelItem(session, "run:opened"), true);
		await vi.advanceTimersByTimeAsync(AGENT_PANEL_REFRESH_WINDOW_MS);
		assert.equal(widget, undefined);
	} finally {
		dispose();
		hub.dispose();
		vi.useRealTimers();
	}
});

test("newly scrolled panel rows show their elapsed time on the first frame (#5239)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	try {
		for (let index = 0; index < 10; index++) {
			await fixture.start(`worker ${index}`);
			taskValue(
				fixture.runners[index]!.context.reportActivity({
					reportId: `elapsed-${index}`,
					change: { kind: "metrics", elapsedMs: 12_000 },
				}),
			);
		}
		fixture.store.drain();
		const session = {};
		bindOwnerTaskStore(session, fixture.store);
		await showAgentPanel(session, {
			custom: async (
				factory: (...args: never[]) => {
					render(width: number): string[];
					handleInput(data: string): void;
					dispose(): void;
				},
			) => {
				const component = factory(
					{ requestRender() {} } as never,
					theme as never,
					new KeybindingsManager() as never,
					(() => {}) as never,
				);
				try {
					component.render(100);
					component.handleInput("\x1b[F");
					const lines = component.render(100).map(stripVTControlCharacters);
					const selected = lines.find((line) => line.startsWith("❯"));
					assert.match(selected ?? "", /12s$/, lines.join("\n"));
				} finally {
					component.dispose();
				}
			},
		} as never);
	} finally {
		await fixture.dispose();
	}
});

test("finished rows the panel keeps read dim after thirty seconds (#5239)", () => {
	assert.equal(AGENT_PANEL_FADE_MS, 30_000);
});

test("a source's viewed flag drops the finished workflow row (#5239)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	const hub = new AgentPanelSourceHub();
	let viewed = false;
	let changed = () => {};
	hub.register({
		items: () => [{ ...row("run:viewed", "stopped"), viewed }],
		subscribe: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let widget: object | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, value: object | undefined) {
			widget = value;
		},
		requestRender() {},
	} as never);
	try {
		vi.advanceTimersByTime(31_000);
		assert.ok(widget);
		viewed = true;
		changed();
		await vi.advanceTimersByTimeAsync(AGENT_PANEL_REFRESH_WINDOW_MS);
		assert.equal(widget, undefined);
	} finally {
		dispose();
		hub.dispose();
		vi.useRealTimers();
	}
});

test("an interrupted-but-running subagent is treated as live for x in the panel and stays in /tasks until stopped (#5239)", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	try {
		await fixture.start("Inspect concurrent spawn locks.");
		// Another subagent still runs, so the interrupted one stays listed.
		await fixture.start("Keep working.");
		const session = {};
		bindOwnerTaskStore(session, fixture.store);
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		setTaskTurnInterrupted(fixture.store, taskId, true);

		const initialRows = agentPanelRows(session);
		assert.equal(initialRows.length, 2);
		const interruptedRow = initialRows.find((candidate) => candidate.id === `task:${taskId}`);
		assert.equal(interruptedRow?.state, "stopped");
		assert.equal(isFinishedPanelRow(interruptedRow!), false);

		await showAgentPanel(session, {
			custom: async (
				factory: (...args: never[]) => {
					render(width: number): string[];
					handleInput(data: string): void;
					dispose(): void;
				},
			) => {
				const component = factory(
					{ requestRender() {} } as never,
					theme as never,
					new KeybindingsManager() as never,
					(() => {}) as never,
				);
				try {
					let initialLines = component.render(100).map(stripVTControlCharacters);
					for (let moves = 0; moves < 3; moves++) {
						if (initialLines.find((line) => line.startsWith("❯"))?.includes("Inspect concurrent")) break;
						component.handleInput("\x1b[B");
						initialLines = component.render(100).map(stripVTControlCharacters);
					}
					assert.match(initialLines.find((line) => line.startsWith("❯")) ?? "", /Inspect concurrent/);
					assert.match(initialLines.join("\n"), /stopped/);
					assert.match(initialLines.at(-1) ?? "", /\bx stop\b/);
					assert.doesNotMatch(initialLines.at(-1) ?? "", /\bx dismiss\b/);

					component.handleInput("x");
					const afterFirstX = component.render(100).map(stripVTControlCharacters);
					assert.match(afterFirstX.at(-1) ?? "", /Press x again within 3s to stop/);
					assert.equal(dismissedAgentPanelItems(session).has(`task:${taskId}`), false);
					assert.equal(dismissedTasks(ownerTaskViewSource(fixture.store)).has(taskId), false);
					assert.equal(agentPanelRows(session).length, 2);

					const inspector = new TaskInspector(
						ownerTaskViewSource(fixture.store),
						() => {},
						() => {},
					);
					try {
						const pickerText = inspector.renderPicker(100, 16).map(stripVTControlCharacters).join("\n");
						assert.match(pickerText, /Inspect concurrent spawn locks\./);
						assert.match(pickerText, /\bx stop\b/);
						assert.doesNotMatch(pickerText, /\bx dismiss\b/);
					} finally {
						inspector.dispose();
					}

					component.handleInput("x");
					await new Promise<void>((resolve) => setImmediate(resolve));
					fixture.store.drain();
					assert.equal(fixture.store.tasks[0]!.execution.kind, "settled");
				} finally {
					component.dispose();
				}
			},
		} as never);
	} finally {
		await fixture.dispose();
		setKeybindings(previousKeys);
	}
});
