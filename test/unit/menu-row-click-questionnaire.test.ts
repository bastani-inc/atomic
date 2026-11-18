/**
 * One left click answers an ask_user_question option, opens a question's tab, and submits from the review tab as
 * moving there and pressing Enter would, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.js";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { ReservedBottomOverlay } from "../../packages/coding-agent/src/modes/interactive/components/reserved-bottom-overlay.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { type ClickScreen, makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Shows the questionnaire as the host does: bounded so the transcript keeps its rows, over the bottom of the screen. */
function ask(ui: ClickScreen, params: QuestionParams): QuestionnaireResult[] {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession({
		tui: ui.tui,
		theme,
		params,
		itemsByTab: params.questions.map(buildItemsForQuestion),
		done: (result) => results.push(result),
	});
	ui.mount(new ReservedBottomOverlay(session.component, () => ui.terminal.rows));
	return results;
}

const option = (label: string, description = `${label} details`) => ({ label, description });

const answers = (results: readonly QuestionnaireResult[]) =>
	results.map((result) => ({
		cancelled: result.cancelled,
		answers: result.answers.map(({ kind, answer, selected }) => `${kind}:${selected?.join(",") ?? answer}`),
	}));

for (const width of [80, 160]) {
	test(`a click on a question's option answers it, label or description line, at ${width} columns`, async () => {
		for (const [pattern, text] of [
			[/\bBeta\b(?! details)/, "Beta"],
			[/Beta details/, "Beta details"],
		] as const) {
			const ui = makeClickScreen(width, 40);
			const results = ask(ui, {
				questions: [
					{
						question: "Which one?",
						header: "Choice",
						options: [option("Alpha"), option("Beta"), option("Gamma")],
					},
				],
			});
			await ui.click(pattern, text);
			assert.deepEqual(answers(results), [{ cancelled: false, answers: ["option:Beta"] }], ui.screen().join("\n"));
			ui.tui.stop();
		}
	});
}

test("a click on Chat about this answers with it, as moving there and pressing enter does", async () => {
	const ui = makeClickScreen(100, 40);
	const results = ask(ui, {
		questions: [{ question: "Which one?", header: "Choice", options: [option("Alpha"), option("Beta")] }],
	});
	await ui.click(/Chat about this/, "Chat about this");
	assert.deepEqual(answers(results), [{ cancelled: false, answers: ["chat:Chat about this"] }]);
	ui.tui.stop();
});

test("a double-click on an option answers it once", async () => {
	const ui = makeClickScreen(100, 40);
	const results = ask(ui, {
		questions: [{ question: "Which one?", header: "Choice", options: [option("Alpha"), option("Beta")] }],
	});
	await ui.doubleClick(/\bAlpha\b(?! details)/, "Alpha");
	assert.deepEqual(answers(results), [{ cancelled: false, answers: ["option:Alpha"] }]);
	ui.tui.stop();
});

test("with several questions, a click opens a tab, toggles a checkbox, moves on from its last row and submits from Review", async () => {
	const ui = makeClickScreen(120, 40);
	const results = ask(ui, {
		questions: [
			{ question: "Which plan?", header: "Plan", options: [option("Small"), option("Large")] },
			{
				question: "Which colors?",
				header: "Colors",
				multiSelect: true,
				options: [option("Red"), option("Green"), option("Blue")],
			},
		],
	});
	await ui.click(/Colors/, "Colors");
	assert.ok(ui.rowOf(/Which colors\?/) >= 0);
	await ui.click(/\bGreen\b(?! details)/, "Green");
	assert.match(ui.screen()[ui.rowOf(/\bGreen\b(?! details)/)] ?? "", /\[✔\] Green/);
	// The last question's Next row reads Submit and moves on to the review tab.
	await ui.click(/4\. Submit/, "Submit");
	await ui.click(/Submit answers/, "Submit answers");
	assert.deepEqual(answers(results), [{ cancelled: false, answers: ["multi:Green"] }], ui.screen().join("\n"));
	ui.tui.stop();
});

test("a click on Cancel in the review tab cancels, as enter on it does", async () => {
	const ui = makeClickScreen(120, 40);
	const results = ask(ui, {
		questions: [
			{ question: "Which plan?", header: "Plan", options: [option("Small"), option("Large")] },
			{ question: "Which size?", header: "Size", options: [option("S"), option("M")] },
		],
	});
	await ui.click(/Review/, "Review");
	await ui.click(/\bCancel\b/, "Cancel");
	assert.deepEqual(
		results.map((result) => result.cancelled),
		[true],
	);
	ui.tui.stop();
});

test("on a terminal too short for the whole dialog, a click answers the option drawn under it", async () => {
	const ui = makeClickScreen(80, 16);
	const results = ask(ui, {
		questions: [
			{
				question: "Which one?",
				header: "Choice",
				options: ["One", "Two", "Three", "Four", "Five", "Six"].map((label) => option(label)),
			},
		],
	});
	// Move down so the dialog crops its top rows away, then click a row that is still drawn.
	for (let step = 0; step < 4; step++) ui.terminal.input("\x1b[B");
	ui.tui.renderNow();
	assert.ok(
		ui.screen().some((line) => line.includes("more rows hidden")),
		ui.screen().join("\n"),
	);
	await ui.click(/\bFour\b(?! details)/, "Four");
	assert.deepEqual(answers(results), [{ cancelled: false, answers: ["option:Four"] }], ui.screen().join("\n"));
	ui.tui.stop();
});

for (const key of ["o", "ctrl+y"] as const) {
	test(`a click on an option answers it when the confirm key is ${key}, as that key does`, async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": [key] }));
		const ui = makeClickScreen(100, 40);
		const results = ask(ui, {
			questions: [{ question: "Which one?", header: "Choice", options: [option("Alpha"), option("Beta")] }],
		});
		await ui.click(/\bBeta\b(?! details)/, "Beta");
		assert.deepEqual(answers(results), [{ cancelled: false, answers: ["option:Beta"] }], ui.screen().join("\n"));
		ui.tui.stop();
	});
}
