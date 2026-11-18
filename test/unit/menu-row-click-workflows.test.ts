/**
 * One left click opens a `/workflows` row as moving there and pressing Enter would, driven through Atomic's
 * fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.js";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import {
	openWorkflowsListing,
	type WorkflowsListingTarget,
} from "../../packages/workflows/src/tui/workflows-listing.js";
import { type ClickScreen, flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";
import { defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";
import {
	createStore,
	deriveGraphTheme,
	makeFakeKeybindings,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	StageUiBroker,
	setupRun,
} from "./stage-chat-view-helpers.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function runs(): RunSnapshot[] {
	return ["alpha-objective", "bravo-objective", "charlie-objective"].map(
		(objective, index) =>
			({
				id: `run-${index + 1}-0000`,
				name: "ralph",
				status: "running",
				inputs: { objective },
				stages: [],
				toolNodes: [],
				startedAt: 100_000 - index,
			}) as RunSnapshot,
	);
}

/** Opens `/workflows`; `picked()` is what it settled on, or `"open"` while it is still showing. */
function listing(ui: ClickScreen): { picked(): WorkflowsListingTarget | undefined | "open" } {
	let result: WorkflowsListingTarget | undefined | "open" = "open";
	void openWorkflowsListing(
		{
			custom: ((factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) =>
				new Promise<void>((resolve) => {
					ui.dock(
						factory({ requestRender: () => ui.tui.requestRender(), terminal: ui.terminal }, {}, {}, resolve),
					);
				})) as never,
		},
		{ runs },
	).then((target) => {
		result = target;
	});
	return { picked: () => result };
}

for (const width of [80, 160]) {
	test(`a click on a /workflows run opens it, title or detail line, at ${width} columns`, async () => {
		const ui = makeClickScreen(width);
		const view = listing(ui);
		await flushClicks();
		ui.tui.renderNow();
		const row = ui.rowOf(/bravo-objective/);
		await ui.clickAt(6, row);
		await flushClicks();
		assert.deepEqual(view.picked(), { kind: "run", runId: "run-2-0000" });
		ui.tui.stop();
	});
}

test("the mouse wheel over /workflows moves its selection", async () => {
	const ui = makeClickScreen();
	const view = listing(ui);
	await flushClicks();
	ui.tui.renderNow();
	const row = ui.rowOf(/alpha-objective/);
	await ui.wheel("down", 6, row);
	await ui.wheel("down", 6, row);
	ui.terminal.input("\r");
	await flushClicks();
	assert.deepEqual(view.picked(), { kind: "run", runId: "run-3-0000" });
	ui.tui.stop();
});

/** A run's graph full screen with its stage switcher open, as `/` opens it; `attached` lists the stages it opened. */
function stageSwitcher(ui: ClickScreen) {
	const attached: string[] = [];
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([makeStage("alpha"), makeStage("bravo"), makeStage("charlie")])),
		graphTheme: defaultTheme,
		piTui: ui.tui,
		onStageAttach: (_runId: string, stageId: string) => attached.push(stageId),
	});
	ui.mount(view);
	ui.terminal.input("/");
	ui.tui.renderNow();
	assert.equal(view._switcherOpen, true, ui.screen().join("\n"));
	return { view, attached };
}

test("a click on a stage in the stage switcher opens it, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 30);
	const { view, attached } = stageSwitcher(ui);
	try {
		await ui.click(/│.*charlie/, "charlie");
		assert.deepEqual(attached, ["charlie"], ui.screen().join("\n"));
		assert.equal(view._switcherOpen, false);
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

test("a drag across the stage switcher's stages selects their text and opens none", async () => {
	const ui = makeClickScreen(100, 30);
	const { view, attached } = stageSwitcher(ui);
	try {
		const from = ui.rowOf(/│.*bravo/);
		const to = ui.rowOf(/│.*charlie/);
		await ui.drag(
			{ column: ui.columnOf(from, "bravo"), row: from },
			{ column: ui.columnOf(to, "charlie") + 3, row: to },
		);
		assert.deepEqual(attached, [], ui.screen().join("\n"));
		assert.equal(view._switcherOpen, true);
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

/** A run's graph full screen with two stages; `attached` lists the stages it opened. */
function graph(ui: ClickScreen) {
	const attached: string[] = [];
	const view = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap([makeStage("alpha"), makeStage("bravo", ["alpha"])])),
		graphTheme: defaultTheme,
		piTui: ui.tui,
		onStageAttach: (_runId: string, stageId: string) => attached.push(stageId),
	});
	ui.mount(view);
	return { view, attached };
}

test("a click on a graph node opens its stage, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 30);
	const { view, attached } = graph(ui);
	try {
		await ui.click(/╭.*bravo/, "bravo");
		assert.deepEqual(attached, ["bravo"], ui.screen().join("\n"));
		assert.equal(view._focusedIndex, 1);
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

test("a drag across graph nodes selects their text and opens no stage", async () => {
	const ui = makeClickScreen(100, 30);
	const { view, attached } = graph(ui);
	try {
		const from = ui.rowOf(/╭.*alpha/);
		const to = ui.rowOf(/╭.*bravo/);
		await ui.drag(
			{ column: ui.columnOf(from, "alpha"), row: from },
			{ column: ui.columnOf(to, "bravo") + 3, row: to },
		);
		assert.deepEqual(attached, [], ui.screen().join("\n"));
		assert.equal(view._focusedIndex, 0);
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

test("a click on a stage in the switcher of a run's full-screen view opens that stage's chat", async () => {
	const ui = makeClickScreen(100, 30);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	store.recordStageStart("run-1", {
		id: "stage-b",
		name: "review-b",
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		onClose: () => {},
		piTui: ui.tui,
		piKeybindings: makeFakeKeybindings(),
	});
	try {
		ui.mount(pane);
		ui.terminal.input("/");
		await ui.click(/│.*review-b/, "review-b");
		await flushClicks();
		ui.tui.renderNow();
		assert.equal(
			ui.screen().some((line) => line.includes("STAGES")),
			false,
			ui.screen().join("\n"),
		);
		assert.equal(
			(pane as unknown as { lastAttachedStageId: string | null }).lastAttachedStageId,
			"stage-b",
			ui.screen().join("\n"),
		);
	} finally {
		pane.dispose();
		ui.tui.stop();
	}
});

test("a click on the stage switcher's heading leaves it open with the selection where it was", async () => {
	const ui = makeClickScreen(100, 30);
	const { view, attached } = stageSwitcher(ui);
	try {
		await ui.click("STAGES");
		assert.deepEqual(attached, []);
		assert.equal(view._switcherOpen, true);
		assert.equal(view._switcherState.selectedIndex, 0);
	} finally {
		view.dispose();
		ui.tui.stop();
	}
});

/** A stage chat showing the stage's question, attached full screen as the graph attaches it. */
function stageQuestion(ui: ClickScreen, prompt: ReturnType<typeof makePendingPrompt>) {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
	const answers: unknown[] = [];
	void store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then((value) => answers.push(value));
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: makeHandle().handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: ui.tui,
		piKeybindings: makeFakeKeybindings(),
	});
	ui.mount(view);
	return { view, answers };
}

for (const width of [80, 160]) {
	test(`a click on a choice of a stage's select question answers it, at ${width} columns`, async () => {
		const ui = makeClickScreen(width, 30);
		const { view, answers } = stageQuestion(
			ui,
			makePendingPrompt({ kind: "select", choices: ["alpha", "beta", "gamma"] }),
		);
		await ui.click(/\bgamma\b/, "gamma");
		await flushClicks();
		assert.deepEqual(answers, ["gamma"], ui.screen().join("\n"));
		view.dispose();
		ui.tui.stop();
	});
}

test("a click on yes or no in a stage's confirm question answers it, as moving there and pressing enter does", async () => {
	for (const [answer, expected] of [
		["yes", true],
		["no", false],
	] as const) {
		const ui = makeClickScreen(100, 30);
		const { view, answers } = stageQuestion(ui, makePendingPrompt({ kind: "confirm", message: "Ship it?" }));
		await ui.click(new RegExp(`○ ${answer}|● ${answer}`), answer);
		await flushClicks();
		assert.deepEqual(answers, [expected], ui.screen().join("\n"));
		view.dispose();
		ui.tui.stop();
	}
});

test("a click on an option of a question a stage asked in its chat answers it", async () => {
	const ui = makeClickScreen(100, 30);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const broker = new StageUiBroker(store);
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: makeHandle().handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: ui.tui,
		piTheme: {},
		piKeybindings: makeFakeKeybindings(),
		stageUiBroker: broker,
	});
	ui.mount(view);
	const params: QuestionParams = {
		questions: [
			{
				question: "Which channel?",
				header: "Channel",
				options: [
					{ label: "Alpha", description: "First option" },
					{ label: "Beta", description: "Second option" },
				],
			},
		],
	};
	const answers: QuestionnaireResult[] = [];
	void broker
		.requestCustomUi<QuestionnaireResult>(
			"run-1",
			"stage-a",
			(_tui, _theme, _kb, done): PiCustomComponent =>
				new QuestionnaireSession({
					tui: { terminal: { columns: 100 }, requestRender: () => ui.tui.requestRender() },
					theme,
					params,
					itemsByTab: params.questions.map(buildItemsForQuestion),
					done: done as (result: QuestionnaireResult) => void,
				}).component,
			{ overlay: true },
		)
		.then((result) => answers.push(result));
	await flushClicks();
	await ui.click(/Second option/, "Second option");
	await flushClicks();
	assert.deepEqual(
		answers.map((result) => result.answers.map(({ answer }) => answer)),
		[["Beta"]],
		ui.screen().join("\n"),
	);
	view.dispose();
	ui.tui.stop();
});
