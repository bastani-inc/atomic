import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelAnswerOptions,
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { taskClocksFor } from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AGENT_PANEL_FADE_MS,
	AGENT_PANEL_IDLE_ROWS,
	AgentPanelModel,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { taskDisplayText } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelRows, bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
});

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("dismissing a stopped background task in /tasks removes it from the agent panel even when the panel rank cache is warm (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("first task");
	// A second subagent keeps running, so the stopped one stays listed in the panel.
	await fixture.start("second task");
	fixture.runners[0]!.result.resolve({ kind: "cancelled", cause: "user" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	fixture.store.drain();
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	bindOwnerTaskStore(session, fixture.store);
	const taskId = fixture.store.tasks[0]!.ref.taskId;
	assert.ok(agentPanelRows(session).some((row) => row.id === `task:${taskId}`));
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	inspector.setBoardSource(agentPanelBoardSource(session));
	try {
		inspector.renderPicker(100, 12);
		for (let moves = 0; moves < 3 && inspector.navigation.selectedTaskId !== taskId; moves++) {
			inspector.handleInput("\x1b[B");
			inspector.renderPicker(100, 12);
		}
		assert.equal(inspector.navigation.selectedTaskId, taskId);
		inspector.handleInput("x");
		await flushMicrotasks();
		assert.equal(
			inspector.navigation.selectedTaskId === taskId &&
				inspector.renderPicker(100, 12).join("").includes("first task"),
			false,
		);
		assert.deepEqual(
			agentPanelRows(session).filter((row) => row.id === `task:${taskId}`),
			[],
		);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a stopped native task row in the agent panel fades after AGENT_PANEL_FADE_MS and leaves once nothing is active (#5224)", async () => {
	let now = 50_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const model = new AgentPanelModel(() => now);
	const { pass } = model.beginPass();
	model.keepFinished("T1", true, now, pass, true);
	model.endPass(pass);
	assert.equal(model.faded({ id: "task:T1" }), false);
	now += AGENT_PANEL_FADE_MS + 1;
	assert.equal(model.faded({ id: "task:T1" }), true);

	const fixture = taskFixture();
	await fixture.start("fading task");
	await fixture.start("still running");
	fixture.runners[0]!.result.resolve({ kind: "cancelled", cause: "user" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	fixture.store.drain();
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	bindOwnerTaskStore(session, fixture.store);
	const rowId = `task:${fixture.store.tasks[0]!.ref.taskId}`;
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key, factory) {
			widget = typeof factory === "function" ? (factory({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
	});
	try {
		assert.ok(widget);
		const fresh = widget.render(100).join("\n");
		assert.match(stripVTControlCharacters(fresh), /fading task/);
		assert.ok(agentPanelRows(session).some((row) => row.id === rowId));
		now += AGENT_PANEL_FADE_MS + 1;
		const faded = widget.render(100).join("\n");
		assert.notEqual(faded, fresh);
		await fixture.settle(1);
		assert.deepEqual(agentPanelRows(session), [], "nothing is active: the stopped row leaves with the finished one");
	} finally {
		dispose();
		clock.mockRestore();
		await fixture.dispose();
	}
});

test("settling a background task freezes its elapsed clock at the store settlement event rather than the next read (#5224)", async () => {
	let now = 5_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		await fixture.start("clocked task");
		const id = fixture.store.backgroundTasks[0]!.ref.taskId;
		const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
		assert.equal(clocks.elapsedMs(id, 1_000, true), 1_000);
		now += 5_000;
		await fixture.settle(0);
		now += 10_000;
		const settled = fixture.store.backgroundTasks.find((task) => task.ref.taskId === id)!;
		assert.equal(settled.execution.kind, "settled");
		assert.equal(clocks.elapsedMs(id, settled.metrics?.elapsedMs ?? 1_000, false), 6_000);
	} finally {
		clock.mockRestore();
		await fixture.dispose();
	}
});

test("agent panel rank cache refreshes extension row text at group-offset slots and respects the idle row cap (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	let items: AgentPanelItem[] = [
		{ id: "run:w", kind: "agent", state: "input", name: "wf", task: "ask", question: "Go?" },
		{ id: "ext:a", kind: "agent", state: "running", name: "helper", task: "stage build" },
		{ id: "ext:b", kind: "agent", state: "running", name: "helper2", task: "work2" },
	];
	let changed = () => {};
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const firstIds = agentPanelRows(session).map((row) => row.id);
	items = [
		{ id: "run:w", kind: "agent", state: "input", name: "wf", task: "ask", question: "Go?" },
		{ id: "ext:a", kind: "agent", state: "running", name: "helper", task: "stage deploy" },
		{ id: "ext:b", kind: "agent", state: "running", name: "helper2", task: "work2" },
	];
	changed();
	const second = agentPanelRows(session);
	const secondIds = second.map((row) => row.id);
	assert.deepEqual(secondIds, firstIds);
	assert.equal(new Set(secondIds).size, secondIds.length);
	assert.equal(second.find((row) => row.id === "ext:a")?.task, "stage deploy");

	const cappedHub = new AgentPanelSourceHub();
	const cappedItems: AgentPanelItem[] = [
		...Array.from(
			{ length: AGENT_PANEL_IDLE_ROWS },
			(_, i) => ({ id: `run:w${i}`, kind: "agent", state: "done", name: `wf${i}`, task: "done" }) as AgentPanelItem,
		),
		...Array.from(
			{ length: AGENT_PANEL_IDLE_ROWS },
			(_, i) =>
				({ id: `ext:a${i}`, kind: "agent", state: "running", name: `agent${i}`, task: "work" }) as AgentPanelItem,
		),
	];
	const listeners = new Set<() => void>();
	cappedHub.register({
		items: () => cappedItems,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const cappedSession = { extensionRunner: { getAgentPanelSourceHub: () => cappedHub } };
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(cappedSession, {
		setWidget(_key, factory) {
			widget = typeof factory === "function" ? (factory({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
	});
	try {
		assert.ok(widget);
		const initialLines = widget.render(100);
		for (const listener of listeners) listener();
		const cachedLines = widget.render(100);
		assert.equal(cachedLines.length, initialLines.length);
		assert.ok(cachedLines.length <= 1 + AGENT_PANEL_IDLE_ROWS + 1, "main, the capped rows and +N more");
	} finally {
		dispose();
	}
});

test("AgentPanelModel drops unkept finished rows at once, forgets absent native finished tasks, and invalidates cached cap views (#5224)", () => {
	const model = new AgentPanelModel(() => 1_000);
	let { pass } = model.beginPass();
	assert.equal(model.keepFinished("ext:y", true, 1_000, pass), true);
	assert.equal(model.keepFinished("X", true, 1_000, pass, true), true);
	assert.equal(model.keepFinished("Z", false, 1_000, pass, true), false, "a finished row nobody keeps leaves at once");
	model.endPass(pass);

	({ pass } = model.beginPass());
	model.keepFinished("ext:y", true, 1_000, pass);
	model.endPass(pass);
	assert.equal(model.finishedSince("X", true), undefined);
	assert.equal(model.finishedSince("ext:y"), 1_000);
});

test("taskDisplayText replaces Unicode line and paragraph separators with spaces (#5224)", () => {
	assert.equal(taskDisplayText("alpha\u2028beta\u2029gamma"), "alpha beta gamma");
});

test("/tasks keeps a started reply bound to its original prompt, ignores unbound replies on Enter, and treats ? in the filter as text (#5224)", async () => {
	const fixture = taskFixture();
	let item: AgentPanelItem = {
		id: "run:deploy",
		kind: "agent",
		state: "input",
		name: "deploy?",
		task: "stage ask",
		question: "Deploy to staging?",
		promptId: "p1",
		choices: ["yes", "no"],
	};
	let changed = () => {};
	const answers: { text: string; options: AgentPanelAnswerOptions | undefined }[] = [];
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	const makeSource = () => ({
		items: () => [item],
		subscribe: (listener: () => void) => {
			changed = listener;
			return () => {};
		},
		answer: async (_id: string, text: string, options?: AgentPanelAnswerOptions) => {
			answers.push({ text, options });
			return options?.promptId === item.promptId
				? { ok: true as const }
				: { ok: false as const, reason: "The pending prompt changed before the answer was sent." };
		},
	});
	inspector.setBoardSource(makeSource());
	try {
		const paint = () => stripVTControlCharacters(inspector.renderPicker(100, 30).join("\n"));
		paint();
		for (const char of "/deploy?") inspector.handleInput(char);
		const filtered = paint();
		assert.doesNotMatch(filtered, /keys · tasks/);
		assert.match(filtered, /⌕ deploy\?/);
		inspector.handleInput("\x1b");
		paint();

		inspector.handleInput(" ");
		paint();
		for (const char of "ye") inspector.handleInput(char);
		item = { ...item, promptId: "p2", question: "Delete production?" };
		changed();
		inspector.handleInput("s");
		inspector.handleInput("\r");
		await flushMicrotasks();
		assert.equal(answers.length, 1);
		assert.equal(answers[0]!.options?.promptId, "p1");
		const changedFrame = paint();
		assert.match(changedFrame, /Delete production\?/);
		assert.doesNotMatch(changedFrame, /❯ yes/, "a reply started for the first question is cleared");
		answers.length = 0;
		inspector.handleInput("\r");
		await flushMicrotasks();
		assert.deepEqual(answers, [], "nothing typed for the first question reaches the second");

		answers.length = 0;
		inspector.setBoardSource(makeSource());
		paint();
		inspector.handleInput("\r");
		await flushMicrotasks();
		assert.deepEqual(answers, []);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});
