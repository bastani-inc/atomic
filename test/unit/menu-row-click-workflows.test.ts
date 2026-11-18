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
import {
	openWorkflowsListing,
	type WorkflowsListingTarget,
} from "../../packages/workflows/src/tui/workflows-listing.js";
import { type ClickScreen, flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";
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
