import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.ts";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.ts";
import { makeTestTui } from "../support/fake-tui.ts";
import { flush, makeHandle, setupRun, stripAnsi } from "./stage-chat-view-helpers.ts";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

let previousKeybindings: ReturnType<typeof getKeybindings>;
let keys: KeybindingsManager;
const views: StageChatView[] = [];

beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	keys = new KeybindingsManager();
	setKeybindings(keys);
});

afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
	setKeybindings(previousKeybindings);
});

const option = (label: string) => ({ label, description: label });

async function openQuestionnaire(
	questions: { question: string; header: string; options: { label: string; description: string }[] }[],
) {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const broker = new StageUiBroker(store);
	const { handle } = makeHandle();
	let settled = false;
	const detached: number[] = [];
	const params = { questions };
	void broker
		.requestCustomUi<QuestionnaireResult>(
			"run-1",
			"stage-a",
			(_tui, _theme, _kb, done): PiCustomComponent =>
				new QuestionnaireSession({
					tui: { terminal: { columns: 100 }, requestRender() {} },
					theme,
					params,
					itemsByTab: questions.map((question) => buildItemsForQuestion(question)),
					done: done as (value: QuestionnaireResult) => void,
				}).component,
			{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } },
		)
		.then(() => {
			settled = true;
		});
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "release",
		handle,
		onDetach: () => detached.push(1),
		onClose: () => {},
		piTui: makeTestTui(32),
		piTheme: theme,
		piKeybindings: keys,
		stageUiBroker: broker,
	});
	views.push(view);
	await flush();
	return {
		view,
		detachCount: () => detached.length,
		settled: () => settled,
		screen: () => stripAnsi(view.render(100).join("\n")),
	};
}

test("← on the first tab of a multi-question stage questionnaire returns to the graph, and later tabs keep ← for the previous tab", async () => {
	const stage = await openQuestionnaire([
		{ question: "Approve the shipping plan?", header: "Plan", options: [option("Yes"), option("No")] },
		{ question: "Which region?", header: "Region", options: [option("us"), option("eu")] },
	]);
	assert.match(stage.screen(), /← graph/);

	stage.view.handleInput(RIGHT);
	await flush();
	assert.match(stage.screen(), /Which region\?/);
	assert.doesNotMatch(stage.screen(), /← graph/);
	stage.view.handleInput(LEFT);
	await flush();
	assert.equal(stage.detachCount(), 0);
	assert.match(stage.screen(), /Approve the shipping plan\?/);
	assert.match(stage.screen(), /← graph/);

	stage.view.handleInput(LEFT);
	await flush();
	assert.equal(stage.detachCount(), 1);
	assert.equal(stage.settled(), false);
});

test.each([
	["←", LEFT],
	["Backspace", BACKSPACE],
])("%s on the empty typed-answer row of a stage questionnaire returns to the graph", async (_name, key) => {
	const stage = await openQuestionnaire([
		{ question: "Approve the shipping plan?", header: "Plan", options: [option("Yes"), option("No")] },
	]);
	stage.view.handleInput(DOWN);
	stage.view.handleInput(DOWN);
	await flush();
	assert.match(stage.screen(), /← graph/);

	stage.view.handleInput(key);
	await flush();
	assert.equal(stage.detachCount(), 1);
	assert.equal(stage.settled(), false);
});

test("a typed answer in a stage questionnaire keeps ← for its cursor and drops the graph hint", async () => {
	const stage = await openQuestionnaire([
		{ question: "Approve the shipping plan?", header: "Plan", options: [option("Yes"), option("No")] },
	]);
	stage.view.handleInput(DOWN);
	stage.view.handleInput(DOWN);
	stage.view.handleInput("x");
	await flush();
	assert.doesNotMatch(stage.screen(), /← graph/);

	stage.view.handleInput(LEFT);
	await flush();
	assert.equal(stage.detachCount(), 0);
	assert.match(stage.screen(), /← graph/);
});
