import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, matchesKey, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	dismissedAgentPanelItems,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AGENT_PANEL_DROP_MS,
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { applyAttachedComposer } from "../../packages/coding-agent/src/modes/interactive/components/input-label.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { getEditorTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowPanelSource } from "../../packages/workflows/src/extension/workflow-panel-source.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { injectStageLabelIntoEditorTopRule } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import { testRunId } from "../helpers/run-id.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { makeTestTui } from "../support/fake-tui.js";

const runIds = new Set<string>();
let previousKeys: ReturnType<typeof getKeybindings>;

beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
});

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeStage(id: string, status: StageSnapshot["status"], parentIds: string[] = []): StageSnapshot {
	return { id, name: id, status, parentIds, toolEvents: [] } as StageSnapshot;
}

function makeToolNode(id: string, status: ToolNodeSnapshot["status"]): ToolNodeSnapshot {
	return { kind: "tool", id, name: id, argsHash: id, ordinal: 0, parentIds: [], status, attachable: false };
}

function makePanelRun(id: string, state: AgentPanelItem["state"]): AgentPanelItem {
	return { id, kind: "workflow", state, name: id.slice(4), task: "stage build", elapsedMs: 1_000 };
}

function createPanelHarness(initial: AgentPanelItem[]) {
	let items = initial;
	const listeners = new Set<() => void>();
	const stopped: [string, string][] = [];
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop: async (id) => {
			stopped.push([id, items.find((item) => item.id === id)?.state ?? "gone"]);
			return { ok: true };
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	return {
		session,
		stopped,
		set(next: AgentPanelItem[]) {
			items = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

async function withFocusedPanel(
	session: object,
	body: (component: {
		handleInput?(data: string): void;
		render(width: number): string[];
		dispose?(): void;
	}) => Promise<void> | void,
) {
	await showAgentPanel(session as never, {
		custom: async (factoryFn) => {
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const component = await factoryFn({ requestRender() {} } as never, theme, new KeybindingsManager(), finish);
			await body(component as never);
			component.handleInput?.("\x1b");
			await finished;
			component.dispose?.();
			return undefined as never;
		},
	});
}

test("focused panel second x does not stop a run that already finished while refresh was deferred (#5224)", async () => {
	const harness = createPanelHarness([makePanelRun("run:deploy", "running")]);
	let tick = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => (tick += 5));
	await withFocusedPanel(harness.session, async (component) => {
		component.render(100);
		component.handleInput?.("x");
		harness.set([makePanelRun("run:deploy", "running")]);
		harness.set([makePanelRun("run:deploy", "running")]);
		harness.set([{ ...makePanelRun("run:deploy", "done"), endedAt: Date.now() }]);
		component.handleInput?.("x");
		await flush();
	});
	assert.deepEqual(harness.stopped, []);
});

test("focused panel single x does not dismiss a row painted as running that finished before the next paint (#5224)", async () => {
	const harness = createPanelHarness([makePanelRun("run:deploy", "running")]);
	await withFocusedPanel(harness.session, async (component) => {
		const painted = component
			.render(100)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(painted, /deploy/);
		harness.set([{ ...makePanelRun("run:deploy", "done"), endedAt: Date.now() }]);
		await Promise.resolve();
		component.handleInput?.("x");
	});
	assert.equal(dismissedAgentPanelItems(harness.session).has("run:deploy"), false);
});

test("quit workflow run ages out of the panel and is dismissable with x (#5224)", () => {
	const runId = testRunId("quit-row");
	runIds.add(runId);
	store.recordRunStart({
		id: runId,
		name: "ralph",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [makeStage("impl", "running")],
		startedAt: Date.now(),
	});
	store.recordRunPaused(runId, undefined, { exitReason: "quit", resumable: true });
	const item = panelItemsFromSnapshot(store.runs()).find((row) => row.id === `run:${runId}`)!;
	assert.ok(item);

	let now = 0;
	const model = new AgentPanelModel(() => now);
	model.rows([item]);
	now = AGENT_PANEL_DROP_MS + 1_000;
	const stillThere = model.rows([item]).some((row) => row.id === item.id);

	const calls: string[] = [];
	const focus = new AgentPanelFocus(new KeybindingsManager(), {
		open: (row) => calls.push(`open ${row.id}`),
		stop: (row) => calls.push(`stop ${row.id}`),
		dismiss: (row) => calls.push(`dismiss ${row.id}`),
		close: () => calls.push("close"),
	});
	focus.update([item]);
	focus.enter();
	focus.notePainted([item]);
	const press = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	press("x");
	press("x");
	assert.equal(stillThere, false);
	assert.ok(calls.includes(`dismiss ${item.id}`));
});

test("focused panel clamps scroll when main is selected (#5224)", () => {
	const focus = new AgentPanelFocus({ matches: () => false }, { open() {}, stop() {}, dismiss() {}, close() {} });
	const rows = (count: number): AgentPanelRow[] =>
		Array.from({ length: count }, (_, index) => ({
			id: `r${index}`,
			kind: "agent",
			name: `n${index}`,
			task: "t",
			state: "running",
		}));
	focus.update(rows(12));
	focus.enter("r11");
	assert.ok(focus.scroll > 0);
	focus.update(rows(0));
	assert.equal(focus.selectedId, "main");
	assert.equal(focus.scroll, 0);
	focus.update(rows(12));
	assert.equal(focus.selectedId, "main");
	assert.equal(focus.scroll, 0);
});

test("running workflow delegating to a tool-only child workflow keeps its stage progress incomplete (#5224)", () => {
	const rootId = testRunId("toolonly-root");
	runIds.add(rootId);
	store.recordRunStart({
		id: rootId,
		name: "root",
		inputs: {},
		status: "running",
		toolNodes: [],
		startedAt: Date.now(),
		stages: [
			makeStage("plan", "completed"),
			{
				...makeStage("delegate", "running", ["plan"]),
				workflowChildRun: { alias: "child", workflow: "child-wf", runId: `${rootId}-child` },
			} as StageSnapshot,
		],
	});
	const before = panelItemsFromSnapshot(store.runs()).find((item) => item.id === `run:${rootId}`);
	assert.deepEqual(before?.progress, { done: 1, total: 2 });

	runIds.add(`${rootId}-child`);
	store.recordRunStart({
		id: `${rootId}-child`,
		name: "child-wf",
		inputs: {},
		status: "running",
		parentRunId: rootId,
		parentStageId: "delegate",
		rootRunId: rootId,
		toolNodes: [makeToolNode("fetch", "running")],
		stages: [],
		startedAt: Date.now(),
	});
	const item = panelItemsFromSnapshot(store.runs()).find((candidate) => candidate.id === `run:${rootId}`);
	assert.equal(item?.state, "running");
	assert.deepEqual(item?.progress, { done: 1, total: 2 });
});

test("opening a finished workflow run without custom UI returns false and does not mark it viewed (#5224)", () => {
	let registered: Parameters<NonNullable<ExtensionAPI["registerAgentPanelSource"]>>[0] | undefined;
	const pi = {
		events: { on() {}, emit() {} },
		on() {},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		registerAgentPanelSource(source: NonNullable<typeof registered>) {
			registered = source;
			return { dispose() {} };
		},
	} as unknown as ExtensionAPI;
	factory(pi);
	assert.ok(registered);
	const hub = new AgentPanelSourceHub();
	hub.register(registered as never);
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };

	const runId = testRunId("open-no-ui");
	runIds.add(runId);
	store.recordRunStart({
		id: runId,
		name: "done-run",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [makeStage("s1", "completed")],
		startedAt: Date.now(),
	});
	store.recordRunEnd(runId, "completed");
	const opened = openAgentPanelItem(session, `run:${runId}`);
	assert.equal(opened, false);
});

test("attached composer keeps heavy rules and label when the draft overflows below with ↓ N more (#5224)", () => {
	const style = { accent: (t: string) => `<a>${t}</a>`, text: (t: string) => t, dim: (t: string) => t };
	const plain = (line: string | undefined) => stripVTControlCharacters(line ?? "");
	const editor = new CustomEditor(makeTestTui(24), getEditorTheme(), new KeybindingsManager());
	editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
	for (let i = 0; i < 60; i++) editor.handleInput("\x1b[A");
	const source = editor.render(80);
	assert.match(plain(source[source.length - 1]), /↓ \d+ more/);
	const out = applyAttachedComposer(style, "debugger · fix · 2m", undefined, source);
	assert.ok(plain(out[0]).includes("debugger"));
	assert.ok(out[0]!.includes("━"));
	assert.ok(out[out.length - 1]!.includes("━"));
});

test("attached composer strips control sequences from the label on a scrolled ↑ N more rule (#5224)", () => {
	const id = (t: string) => t;
	const style = { accent: id, text: id, dim: id };
	const hostileLabel = "stage · deploy\x1b]0;pwned\x07\nnext · 3m";
	const scrolled = `──── ↑ 3 more ${"─".repeat(46)}`;
	const [top] = applyAttachedComposer(style, hostileLabel, undefined, [scrolled, "❯ x", "─".repeat(60)]);
	assert.equal(/[\x00-\x1f]/.test(top!.replace(/\x1b\[[0-9;]*m/g, "")), false);
	assert.equal(visibleWidth(top!), 60);

	const ctx = {
		theme: { accent: "#5fafff", text: "#d0d0d0", dim: "#808080" },
		chatHost: { hasInputText: () => true },
	} as never;
	const stage = {
		id: "s1",
		name: "review\x1b]0;pwned\x07 a.ts",
		status: "running",
		startedAt: Date.now() - 5_000,
	} as never;
	const [scrolledStageTop] = injectStageLabelIntoEditorTopRule(
		ctx,
		(stage as { name: string }).name,
		[scrolled, "❯ x", "─".repeat(60)],
		stage,
	);
	assert.equal(/\x1b\]|\x07/.test(scrolledStageTop!), false);
});

test("focused panel retains no clocks for extension rows that have left the source (#5224)", async () => {
	let now = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const job = (id: string, state: AgentPanelItem["state"], elapsedMs: number): AgentPanelItem => ({
		id,
		kind: "agent",
		state,
		name: id.slice(4),
		task: "work",
		elapsedMs,
	});
	const ids = Array.from({ length: 12 }, (_, index) => `ext:job${index}`);
	const harness = createPanelHarness(ids.map((id) => job(id, "running", 0)));
	await withFocusedPanel(harness.session, async (panel) => {
		panel.render(100);
		now += 2_000;
		harness.set(ids.map((id) => job(id, "running", 0)));
		await Promise.resolve();
		panel.render(100);
		harness.set([job("ext:other", "running", 0)]);
		await Promise.resolve();
		now += 5_000;
		panel.render(100);
		harness.set([job("ext:job0", "running", 0)]);
		await Promise.resolve();
		const line = stripVTControlCharacters(panel.render(100).join("\n")).match(/job0[^\n]*/)?.[0] ?? "";
		assert.match(line, /\b0s\b/);
	});
});

test("after an extension row settles, the focused panel and /tasks show the same frozen time (#5224)", async () => {
	let now = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const job = (id: string, state: AgentPanelItem["state"], elapsedMs: number): AgentPanelItem => ({
		id,
		kind: "agent",
		state,
		name: id.slice(4),
		task: "work",
		elapsedMs,
	});
	const harness = createPanelHarness([job("ext:job", "running", 0)]);
	let panelLine = "";
	await withFocusedPanel(harness.session, (panel) => {
		panel.render(100);
		now += 1_000;
		harness.set([job("ext:job", "running", 0)]);
		panel.render(100);
		now += 1_900;
		panel.render(100);
		now += 50;
		harness.set([job("ext:job", "done", 500)]);
		now += 5_000;
		panelLine = stripVTControlCharacters(panel.render(100).join("\n")).match(/job[^\n]*/)?.[0] ?? "";
	});
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(agentPanelBoardSource(harness.session as never));
		const boardLine =
			stripVTControlCharacters(inspector.renderPicker(100, 20).join("\n")).match(/job[^\n]*/)?.[0] ?? "";
		const extractTime = (text: string) => text.match(/(\d+s)\s*$/)?.[1];
		assert.equal(extractTime(panelLine), extractTime(boardLine));
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("workflowPanelSource memoizes items across repeated reads and task store metrics refreshes do not re-read unchanged extension sources (#4009, #5224)", async () => {
	const runId = testRunId("memo-source");
	runIds.add(runId);
	let stageReads = 0;
	const s1 = makeStage("s1", "running");
	Object.defineProperty(s1, "status", {
		enumerable: true,
		get() {
			stageReads++;
			return "running";
		},
	});
	store.recordRunStart({
		id: runId,
		name: "memo-wf",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [s1],
		startedAt: 1_000,
	});
	const wfSource = workflowPanelSource(captureWorkflowOwnerResources(), {
		open: () => {},
		quit: async () => ({ status: "stopped", runId, message: "stopped" }) as never,
	});
	let extReads = 0;
	const hub = new AgentPanelSourceHub();
	hub.register(wfSource);
	hub.register({
		items: () => {
			extReads++;
			return [
				{ id: "ext:worker", kind: "agent", state: "running", name: "worker", task: "build", elapsedMs: 1_000 },
			];
		},
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const fixture = taskFixture();
	bindOwnerTaskStore(session, fixture.store);
	let dispose = () => {};
	try {
		await fixture.start("Background worker");
		dispose = bindAgentPanel(session, { setWidget() {}, requestRender() {} });
		const wfReadsBefore = stageReads;
		wfSource.items();
		const wfReadsAfterFirst = stageReads;
		wfSource.items();
		wfSource.items();
		assert.equal(stageReads, wfReadsAfterFirst);
		assert.ok(wfReadsAfterFirst >= wfReadsBefore);

		const extReadsBeforeStream = extReads;
		for (let i = 0; i < 10; i++) {
			taskValue(
				fixture.runners[0]!.context.reportActivity({
					reportId: `metrics-${i}`,
					change: { kind: "metrics", elapsedMs: 1_000 + i * 100, tokenCount: 500 + i },
				}),
			);
			fixture.store.drain();
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(extReads, extReadsBeforeStream);
	} finally {
		dispose();
		await fixture.dispose();
	}
});
