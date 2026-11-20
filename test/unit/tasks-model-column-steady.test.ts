import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Component, TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import {
	MODEL_LEVEL_WAIT_MS,
	ModelColumn,
} from "../../packages/coding-agent/src/modes/interactive/components/model-column.js";
import {
	boardModelColumn,
	boardModelFits,
	type TaskBoardItem,
	type TaskBoardRow,
} from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

const TASK = "Read the template and do what it says for each package";
const plainStyle: AgentPanelStyle = {
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
const fixtures: Array<ReturnType<typeof taskFixture>> = [];

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	vi.useRealTimers();
	while (fixtures.length > 0) await fixtures.pop()!.dispose();
});

async function boardWith(tasks: readonly string[]) {
	const fixture = taskFixture();
	fixtures.push(fixture);
	for (const task of tasks) await fixture.start(task);
	let renders = 0;
	const inspector = new TaskInspector(
		fixture.store,
		() => {
			renders++;
		},
		() => {},
	);
	const report = (index: number, model: string, thinking?: string) => {
		fixture.runners[index]!.context.reportActivity({
			reportId: `model-${index}-${model}-${thinking ?? "none"}`,
			change: { kind: "model", model, ...(thinking === undefined ? {} : { thinking }) },
		});
		fixture.store.drain();
	};
	const row = (task: string, width = 140) => {
		const lines = inspector.renderViewport(width, 24).map((line) => stripVTControlCharacters(line));
		return lines.find((line) => line.includes(task)) ?? lines.join("\n");
	};
	return { fixture, inspector, report, row, renders: () => renders };
}

test("/tasks keeps a new subagent's task in place while its model is known but its reasoning level is not, then shows both at once", async () => {
	const board = await boardWith([TASK]);
	try {
		const before = board.row(TASK);
		const origin = before.indexOf(TASK);
		assert.ok(origin > 0, before);
		board.report(0, "faux/thinker");
		const modelOnly = board.row(TASK);
		assert.equal(modelOnly.indexOf(TASK), origin, `the task did not move:\n${modelOnly}`);
		assert.doesNotMatch(modelOnly, /faux\/thinker/);
		board.report(0, "faux/thinker", "medium");
		assert.match(board.row(TASK), /worker {8}faux\/thinker medium {2}Read the template/);
	} finally {
		board.inspector.dispose();
	}
});

test("/tasks shows a model alone once its reasoning level has not arrived within a second, repainting without another change", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const board = await boardWith([TASK]);
	try {
		board.row(TASK);
		board.report(0, "faux/thinker");
		assert.doesNotMatch(board.row(TASK), /faux\/thinker/);
		vi.advanceTimersByTime(MODEL_LEVEL_WAIT_MS - 1);
		assert.doesNotMatch(board.row(TASK), /faux\/thinker/);
		const painted = board.renders();
		vi.advanceTimersByTime(1);
		assert.ok(board.renders() > painted, "the board asks for a repaint when the wait ends");
		assert.match(board.row(TASK), /worker {8}faux\/thinker {2}Read the template/);
	} finally {
		board.inspector.dispose();
	}
});

test("/tasks shows at once a model without reasoning levels, a finished row's model, and a model already known when it opens", async () => {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider("local", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "local-key",
		api: "openai-completions",
		models: [
			{
				id: "plain",
				name: "plain",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	});
	const board = await boardWith(["plain work", "finished work", "known work"]);
	bindOwnerTaskStore({ modelRuntime }, board.fixture.store);
	board.report(2, "faux/known");
	const reopened = new TaskInspector(
		board.fixture.store,
		() => {},
		() => {},
	);
	try {
		const row = (task: string) =>
			reopened
				.renderViewport(140, 24)
				.map((line) => stripVTControlCharacters(line))
				.find((line) => line.includes(task)) ?? "";
		assert.match(row("known work"), /worker {8}faux\/known {2}known work/, "known when the board opened");
		board.report(0, "local/plain");
		assert.match(row("plain work"), /worker {8}local\/plain {2}plain work/, "no levels to wait for");
		board.report(1, "faux/thinker");
		await board.fixture.settle(1);
		assert.match(row("finished work"), /worker {8}faux\/thinker {2}finished work/, "finished: nothing more comes");
		board.report(2, "faux/known", "high");
		assert.match(row("known work"), /worker {8}faux\/known high {2}known work/);
	} finally {
		reopened.dispose();
		board.inspector.dispose();
	}
});

test("/tasks keeps its model column's width while open when the widest model leaves, and measures it again on reopen or resize", async () => {
	const board = await boardWith([TASK, "fix shipping batches"]);
	try {
		board.report(0, "github-copilot/claude-opus-5.5", "medium");
		board.report(1, "faux/faux-2", "low");
		const wide = board.row("fix shipping batches");
		const origin = wide.indexOf("fix shipping batches");
		assert.equal(origin, wide.indexOf("faux/faux-2 low") + "github-copilot/claude-opus-5.5 medium".length + 2);
		board.report(0, "faux/backup", "low");
		const after = board.row("fix shipping batches");
		assert.equal(after.indexOf("fix shipping batches"), origin, `the column did not narrow:\n${after}`);
		const resized = board.row("fix shipping batches", 150);
		assert.equal(
			resized.indexOf("fix shipping batches"),
			resized.indexOf("faux/faux-2 low") + "faux/backup low".length + 2,
		);
		const reopened = new TaskInspector(
			board.fixture.store,
			() => {},
			() => {},
		);
		try {
			const line =
				reopened
					.renderViewport(140, 24)
					.map((text) => stripVTControlCharacters(text))
					.find((text) => text.includes("fix shipping batches")) ?? "";
			assert.equal(
				line.indexOf("fix shipping batches"),
				line.indexOf("faux/faux-2 low") + "faux/backup low".length + 2,
			);
		} finally {
			reopened.dispose();
		}
	} finally {
		board.inspector.dispose();
	}
});

test("a board's model column does not narrow while it fits, gives way to the column a row needs, and drops only when no label fits", () => {
	const waiting: TaskBoardRow = {
		id: "waiting",
		kind: "item",
		item: {
			id: "waiting",
			kind: "agent",
			state: "waiting",
			name: "worker",
			task: "wait for the build",
			waitingOn: "bash, read, edit, write, grep",
			model: "faux/a",
		},
	};
	const roomy = boardModelFits([waiting], 140);
	// 40 cells leave the waiting row's task under 8 cells at 100 columns; 6 do not.
	const tight = boardModelFits([waiting], 100);
	assert.equal(tight(40), false);
	assert.equal(tight(6), true);
	const column = new ModelColumn();
	assert.equal(
		column.column(100, 40, () => true),
		40,
	);
	assert.equal(
		column.column(100, 6, () => true),
		40,
		"held while it fits",
	);
	assert.equal(column.column(100, 6, tight), 6, "the held width no longer fits: the column the labels need");
	assert.equal(column.column(100, 0, tight), 6, "the last painted width still fits: kept");
	assert.equal(
		column.column(100, 6, () => true),
		40,
		"the held width fits again",
	);
	assert.equal(
		column.column(100, 41, (width) => width <= 40),
		0,
		"a label wider than any fitting column",
	);
	assert.equal(column.column(140, 6, roomy), 6, "another width is measured afresh");
	assert.equal(boardModelColumn([waiting], [{ text: "faux/a", width: 6 }], 140), 6);
	assert.equal(boardModelColumn([waiting], [{ text: "", width: 0 }], 140), 0);
});

async function panelWith(tasks: readonly string[]) {
	const fixture = taskFixture();
	fixtures.push(fixture);
	const session = {};
	let widget: Component | undefined;
	let renders = 0;
	const unbind = bindAgentPanel(
		session as never,
		{
			setWidget(_key, content) {
				widget = typeof content === "function" ? content({} as TUI, theme) : undefined;
			},
			requestRender() {
				renders++;
			},
		} as Pick<ExtensionUIContext, "setWidget" | "requestRender"> as ExtensionUIContext,
	);
	bindOwnerTaskStore(session, fixture.store);
	for (const task of tasks) await fixture.start(task);
	const report = async (index: number, model: string, thinking?: string) => {
		const before = renders;
		fixture.runners[index]!.context.reportActivity({
			reportId: `model-${index}-${model}-${thinking ?? "none"}`,
			change: { kind: "model", model, ...(thinking === undefined ? {} : { thinking }) },
		});
		fixture.store.drain();
		await vi.waitFor(() => assert.ok(renders > before, "the report asks for a repaint"));
	};
	const row = (task: string, width = 160) =>
		stripVTControlCharacters(widget?.render(width).find((line) => line.includes(task)) ?? "");
	return { report, row, unbind, renders: () => renders, start: (task: string) => fixture.start(task) };
}

test("the agent panel keeps a new subagent's task in place until its model and reasoning level arrive together", async () => {
	const panel = await panelWith([TASK]);
	try {
		await vi.waitFor(() => assert.ok(panel.row(TASK).includes(TASK)));
		const origin = panel.row(TASK).indexOf(TASK);
		await panel.report(0, "faux/thinker");
		const modelOnly = panel.row(TASK);
		assert.equal(modelOnly.indexOf(TASK), origin, `the task did not move:\n${modelOnly}`);
		assert.doesNotMatch(modelOnly, /faux\/thinker/);
		await panel.report(0, "faux/thinker", "medium");
		assert.match(panel.row(TASK), /worker {2}faux\/thinker medium {2}Read the template/);
	} finally {
		panel.unbind();
	}
});

test("the agent panel shows a model alone once its reasoning level has not arrived within a second, repainting by itself", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const panel = await panelWith([TASK]);
	try {
		await vi.waitFor(() => assert.ok(panel.row(TASK).includes(TASK)));
		await panel.report(0, "faux/thinker");
		assert.doesNotMatch(panel.row(TASK), /faux\/thinker/);
		vi.advanceTimersByTime(MODEL_LEVEL_WAIT_MS - 1);
		assert.doesNotMatch(panel.row(TASK), /faux\/thinker/);
		const painted = panel.renders();
		vi.advanceTimersByTime(1);
		assert.ok(panel.renders() > painted, "the panel asks for a repaint when the wait ends");
		assert.match(panel.row(TASK), /worker {2}faux\/thinker {2}Read the template/);
	} finally {
		panel.unbind();
	}
});

test("the agent panel keeps its model column's width while the widest model leaves, and measures it again at another width", async () => {
	const panel = await panelWith([TASK, "fix shipping batches"]);
	try {
		await panel.report(0, "github-copilot/claude-opus-5.5", "medium");
		await panel.report(1, "faux/faux-2", "low");
		const wide = panel.row("fix shipping batches");
		const origin = wide.indexOf("fix shipping batches");
		assert.equal(origin, wide.indexOf("faux/faux-2 low") + "github-copilot/claude-opus-5.5 medium".length + 2);
		await panel.report(0, "faux/backup", "low");
		assert.equal(panel.row("fix shipping batches").indexOf("fix shipping batches"), origin);
		const resized = panel.row("fix shipping batches", 150);
		assert.equal(
			resized.indexOf("fix shipping batches"),
			resized.indexOf("faux/faux-2 low") + "faux/backup low".length + 2,
		);
	} finally {
		panel.unbind();
	}
});

test("a panel's held model column gives way to the narrower column a row needs, and comes back once it fits again", () => {
	const plain = plainStyle;
	const column = new ModelColumn();
	const wide: AgentPanelRow = {
		id: "wide",
		kind: "agent",
		state: "running",
		name: "worker",
		task: "write the docs",
		model: "github-copilot/claude-opus-5.5",
		thinking: "medium",
	};
	const short: AgentPanelRow = {
		...wide,
		id: "short",
		task: "fix shipping batches",
		model: "faux/a",
		thinking: "low",
	};
	const paint = (rows: readonly AgentPanelRow[]) =>
		renderAgentPanelRows(rows, 100, plain, { modelColumn: column }).map((line) => stripVTControlCharacters(line));
	const taskAt = (lines: readonly string[]) => {
		const line = lines.find((text) => text.includes("fix shipping")) ?? "";
		return line.indexOf("fix shipping");
	};
	const held = taskAt(paint([wide, short]));
	assert.equal(taskAt(paint([short])), held, "held while it fits");
	// A row whose right column leaves no room for the held column: the column it needs is painted instead.
	const waiting: AgentPanelRow = {
		...short,
		id: "waiting",
		state: "waiting",
		waitingOn: "bash, read, edit, write, grep",
	};
	const tight = paint([short, waiting]);
	assert.match(tight.find((text) => text.includes("fix shipping")) ?? "", /worker {2}faux\/a low {2}fix shipping/);
	assert.equal(taskAt(paint([short])), held, "the held width comes back once it fits");
});

test("/tasks asks the model registry about a model only when the model becomes known while shown, not on every paint", async () => {
	let lookups = 0;
	const board = await boardWith(["known work", "new work"]);
	bindOwnerTaskStore(
		{
			modelRuntime: {
				getModel() {
					lookups++;
					return undefined;
				},
			},
		},
		board.fixture.store,
	);
	board.report(0, "custom/unlisted");
	const reopened = new TaskInspector(
		board.fixture.store,
		() => {},
		() => {},
	);
	try {
		const paint = () => reopened.renderViewport(140, 24);
		for (let i = 0; i < 20; i++) paint();
		assert.equal(lookups, 0, "a model known when the board opened needs no lookup");
		board.report(1, "custom/unlisted");
		for (let i = 0; i < 20; i++) paint();
		assert.equal(lookups, 1, "one lookup when the model arrived");
	} finally {
		reopened.dispose();
		board.inspector.dispose();
	}
});

test("/tasks repaints by itself only when a wait ends with the model still without its level", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const board = await boardWith(["first work", "second work"]);
	try {
		board.row("first work");
		board.report(0, "faux/a");
		board.row("first work");
		vi.advanceTimersByTime(200);
		board.report(1, "faux/b");
		board.row("first work");
		vi.advanceTimersByTime(300);
		board.report(0, "faux/a", "high");
		assert.match(board.row("first work"), /faux\/a high/);
		const painted = board.renders();
		vi.advanceTimersByTime(500);
		assert.equal(board.renders(), painted, "the first row's wait ended with its level: nothing to repaint");
		assert.doesNotMatch(board.row("second work"), /faux\/b/);
		vi.advanceTimersByTime(200);
		assert.equal(board.renders(), painted + 1, "the second row's wait ends");
		assert.match(board.row("second work"), /worker {8}faux\/b {7}second work/);
	} finally {
		board.inspector.dispose();
	}
});

test("a row whose model arrived while the view was too narrow for the column shows it at once when the view widens", async () => {
	const board = await boardWith([TASK]);
	const panel = await panelWith([TASK]);
	try {
		await vi.waitFor(() => assert.ok(panel.row(TASK).includes(TASK)));
		board.row(TASK, 90);
		panel.row(TASK, 90);
		board.report(0, "faux/thinker");
		await panel.report(0, "faux/thinker");
		board.row(TASK, 90);
		panel.row(TASK, 90);
		assert.match(board.row(TASK, 140), /worker {8}faux\/thinker {2}Read the template/);
		assert.match(panel.row(TASK, 140), /worker {2}faux\/thinker {2}Read the template/);
	} finally {
		panel.unbind();
		board.inspector.dispose();
	}
});

test("/tasks shows at once the model a waiting row falls back to when that model has no reasoning levels", async () => {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	const model = {
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	modelRuntime.registerProvider("example", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "example-key",
		api: "openai-completions",
		models: [
			{ ...model, id: "reasoning", name: "reasoning", reasoning: true },
			{ ...model, id: "plain", name: "plain", reasoning: false },
		],
	});
	const board = await boardWith([TASK]);
	bindOwnerTaskStore({ modelRuntime }, board.fixture.store);
	try {
		board.row(TASK);
		board.report(0, "example/reasoning");
		assert.doesNotMatch(board.row(TASK), /example\//);
		board.report(0, "example/plain");
		assert.match(board.row(TASK), /worker {8}example\/plain {2}Read the template/);
	} finally {
		board.inspector.dispose();
	}
});

test("/tasks waits again for the level of a model reported anew after the row reported none", async () => {
	const board = await boardWith([TASK]);
	try {
		board.report(0, "faux/first", "low");
		assert.match(board.row(TASK), /worker {8}faux\/first low {2}Read the template/);
		board.fixture.runners[0]!.context.reportActivity({ reportId: "model-none", change: { kind: "model" } });
		board.fixture.store.drain();
		assert.doesNotMatch(board.row(TASK), /faux\//);
		board.report(0, "faux/second");
		assert.doesNotMatch(board.row(TASK), /faux\//);
		board.report(0, "faux/second", "high");
		assert.match(board.row(TASK), /faux\/second high/);
	} finally {
		board.inspector.dispose();
	}
});

test("a subagent row that first appears in an open /tasks or panel with its model but not its level waits for the level", async () => {
	const board = await boardWith(["first work"]);
	const panel = await panelWith(["first work"]);
	try {
		board.report(0, "faux/first", "low");
		await panel.report(0, "faux/first", "low");
		board.row("first work");
		panel.row("first work");
		await board.fixture.start("second work");
		board.report(1, "faux/thinker");
		assert.doesNotMatch(board.row("second work"), /faux\/thinker/);
		board.report(1, "faux/thinker", "medium");
		assert.match(board.row("second work"), /worker {8}faux\/thinker medium {2}second work/);
		await panel.start("second work");
		await panel.report(1, "faux/thinker");
		assert.doesNotMatch(panel.row("second work"), /faux\/thinker/);
		await panel.report(1, "faux/thinker", "medium");
		assert.match(panel.row("second work"), /worker {2}faux\/thinker medium {2}second work/);
	} finally {
		panel.unbind();
		board.inspector.dispose();
	}
});

test("no model column appears while a waiting row's model is too wide for any column, as without the wait", async () => {
	const fixture = taskFixture();
	fixtures.push(fixture);
	type Item = TaskBoardItem & Record<string, unknown>;
	let items: Item[] = [
		{
			id: "w",
			kind: "agent",
			state: "waiting",
			name: "waiter",
			task: "wait for the build",
			waitingOn: "bash, read, edit, write, grep",
		},
		{ id: "a", kind: "agent", state: "running", name: "alpha", task: "Alpha task: read the template and do it" },
		{ id: "b", kind: "agent", state: "running", name: "bravo", task: "Bravo task: read the template and do it" },
	];
	const listeners = new Set<() => void>();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	inspector.open();
	const column = new ModelColumn();
	const set = (id: string, patch: Partial<Item>) => {
		items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
		for (const listener of listeners) listener();
	};
	const origins = () => {
		const board = inspector.renderViewport(101, 24).map((line) => stripVTControlCharacters(line));
		const panel = renderAgentPanelRows(items, 100, plainStyle, { modelColumn: column }).map((line) =>
			stripVTControlCharacters(line),
		);
		const at = (lines: readonly string[]) => (lines.find((line) => line.includes("Bravo")) ?? "").indexOf("Bravo");
		return `${at(board)}/${at(panel)}`;
	};
	try {
		const seen = [origins()];
		set("a", { model: "openrouter/anthropic/claude-sonnet-4.5" });
		seen.push(origins());
		set("b", { model: "faux/s" });
		seen.push(origins());
		set("b", { thinking: "low" });
		seen.push(origins());
		set("a", { thinking: "high" });
		seen.push(origins());
		assert.deepEqual(seen, Array(5).fill(seen[0]), "Bravo's task never moves");
	} finally {
		inspector.dispose();
	}
});

test("an open panel's model column reads only the rows it draws, however many rows the list has", () => {
	const reads = new Array<number>(4096).fill(0);
	const rows = Array.from({ length: 4096 }, (_, index): AgentPanelRow => {
		const row = {
			kind: "agent",
			state: "running",
			name: "worker",
			task: "read rows",
			model: "faux/m",
			thinking: "low",
			elapsedMs: 1000,
		} as const;
		return Object.defineProperty({ ...row }, "id", {
			enumerable: true,
			get() {
				reads[index]!++;
				return `r${index}`;
			},
		}) as AgentPanelRow;
	});
	const column = new ModelColumn();
	/** The reads of rows outside the drawn window `[start, start + 8)` during one draw. */
	const hiddenReads = (list: readonly AgentPanelRow[], scroll: number) => {
		reads.fill(0);
		renderAgentPanelRows(list, 120, plainStyle, {
			selectedId: `r${scroll}`,
			scroll,
			showMain: true,
			modelColumn: column,
		});
		return reads.reduce((sum, count, index) => (index >= scroll && index < scroll + 8 ? sum : sum + count), 0);
	};
	try {
		assert.equal(hiddenReads(rows, 0), 0, "first draw");
		assert.equal(hiddenReads(rows, 0), 0, "unchanged draw");
		assert.equal(hiddenReads([...rows], 0), 0, "a new list, nothing remembered off screen");
		const scrolled = [...rows];
		hiddenReads(scrolled, 8);
		assert.equal(hiddenReads(scrolled, 8), 0, "unchanged draw after scrolling");
	} finally {
		column.dispose();
	}
});

test("rows already listed show their known models at once when they scroll into view, in the panel and in /tasks", async () => {
	// Models known, levels not reported, unknown to any registry: shown as they are, as when the list opened.
	const items = Array.from(
		{ length: 16 },
		(_, index): TaskBoardItem => ({
			id: `r${index}`,
			kind: "agent",
			state: "running",
			name: "worker",
			task: `work ${String(index).padStart(2, "0")}`,
			model: `faux/m${index % 3}`,
		}),
	);
	const column = new ModelColumn();
	const panel = (scroll: number) =>
		renderAgentPanelRows(items, 120, plainStyle, {
			selectedId: `r${scroll}`,
			scroll,
			showMain: true,
			modelColumn: column,
		})
			.map((line) => stripVTControlCharacters(line))
			.filter((line) => /work \d\d/.test(line));
	const fixture = taskFixture();
	fixtures.push(fixture);
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	inspector.setBoardSource({ items: () => items, subscribe: () => () => {} });
	inspector.open();
	const board = () =>
		inspector
			.renderViewport(120, 12)
			.map((line) => stripVTControlCharacters(line))
			.filter((line) => /work \d\d/.test(line));
	try {
		assert.equal(panel(0).filter((line) => /faux\/m\d/.test(line)).length, 8);
		const page2 = panel(8);
		assert.equal(page2.filter((line) => /faux\/m\d/.test(line)).length, 8, page2.join("\n"));
		const first = board();
		assert.ok(first.length > 0 && first.every((line) => /faux\/m\d/.test(line)), first.join("\n"));
		for (let press = 0; press < 15; press++) inspector.handleInput("\u001b[B");
		const scrolled = board();
		assert.ok(
			scrolled.some((line) => line.includes("work 15")),
			scrolled.join("\n"),
		);
		assert.ok(
			scrolled.every((line) => /faux\/m\d/.test(line)),
			scrolled.join("\n"),
		);
	} finally {
		column.dispose();
		inspector.dispose();
	}
});
