import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { beforeEach, describe, test } from "vitest";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const ESC = "\x1b";

const plain = (line: string): string =>
	line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const THREE: QuestionParams = {
	questions: [
		{
			question: "How should navigation work?",
			header: "Navigation",
			options: [
				{ label: "Build it as shown", description: "Follow the approved mockups exactly" },
				{ label: "Simplify", description: "Drop the agent panel for now" },
			],
		},
		{
			question: "Which packages ship?",
			header: "Packaging",
			multiSelect: true,
			options: [
				{ label: "coding-agent", description: "The CLI" },
				{ label: "workflows", description: "Workflow engine" },
			],
		},
		{
			question: "Which layout?",
			header: "Layout",
			options: [
				{ label: "Sidebar", description: "Navigation on the left", preview: "nav | main" },
				{ label: "Top bar", description: "Navigation on top", preview: "nav\n----\nmain" },
			],
		},
	],
};

const ONE: QuestionParams = { questions: [THREE.questions[0]!] };

function open(params: QuestionParams, columns = 80) {
	let result: QuestionnaireResult | undefined;
	const session = new QuestionnaireSession({
		tui: { terminal: { columns }, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done: (r) => {
			result = r;
		},
	});
	const press = (...keys: string[]) => {
		for (const key of keys) session.component.handleInput(key);
	};
	const lines = (width = columns) => session.component.render(width).map(plain);
	/** The rows inside the frame, without the `│ ` / ` │` sides, trailing space trimmed. */
	const inner = (width = columns) => {
		const all = lines(width);
		const top = all.findIndex((line) => line.startsWith("╭"));
		const bottom = all.findIndex((line) => line.startsWith("╰"));
		return all.slice(top + 1, bottom).map((line) => line.slice(2, -2).trimEnd());
	};
	const hint = (width = columns) => {
		const all = lines(width);
		return (all[all.findIndex((line) => line.startsWith("╰")) + 1] ?? "").trim();
	};
	return { session, press, lines, inner, hint, result: () => result };
}

describe("ask_user_question dialog (#5224)", () => {
	beforeEach(() => initTheme("dark"));

	test("sits in a rounded frame that fits the width, with one hint line under it", () => {
		for (const width of [60, 80, 160]) {
			const dialog = open(THREE, width);
			const all = dialog.lines(width);
			const top = all.findIndex((line) => line.startsWith("╭"));
			const bottom = all.findIndex((line) => line.startsWith("╰"));
			assert.ok(top >= 0 && bottom > top, all.join("\n"));
			assert.ok(all[top]!.endsWith("╮") && all[bottom]!.endsWith("╯"));
			for (const line of all.slice(top + 1, bottom)) {
				assert.ok(line.startsWith("│ ") && line.endsWith(" │"), `${width}: ${line}`);
			}
			for (const line of dialog.session.component.render(width)) assert.ok(visibleWidth(line) <= width);
		}
	});

	test("shows the questions as steps with the current one counted n/m", () => {
		const dialog = open(THREE);
		assert.match(dialog.inner()[0] ?? "", /^Navigation ── Packaging ── Layout ── Review +1\/3$/);
		dialog.press(TAB);
		assert.match(dialog.inner()[0] ?? "", /^Navigation ── Packaging ── Layout ── Review +2\/3$/);
		dialog.press(TAB, TAB);
		assert.match(dialog.inner()[0] ?? "", /Review +Review$/);
	});

	test("numbers the options and indents each description under its label", () => {
		const rows = open(THREE).inner();
		const first = rows.indexOf("❯ 1. Build it as shown");
		assert.ok(first > 0, rows.join("\n"));
		assert.equal(rows[first + 1], "     Follow the approved mockups exactly");
		assert.equal(rows[first + 2], "  2. Simplify");
		assert.equal(rows[first + 3], "     Drop the agent panel for now");
		assert.equal(rows[first + 4], "  3. Type something.");
		assert.ok(rows.includes("  4. Chat about this"), rows.join("\n"));
	});

	test("indents multi-select descriptions under the label, past the checkbox", () => {
		const dialog = open(THREE);
		dialog.press(TAB);
		const rows = dialog.inner();
		const first = rows.indexOf("❯ 1. [ ] coding-agent");
		assert.ok(first > 0, rows.join("\n"));
		assert.equal(rows[first + 1], "         The CLI");
		assert.equal(rows[first + 2], "  2. [ ] workflows");
		assert.equal(rows[first + 3], "         Workflow engine");
		assert.ok(rows.includes("  3. Next"), rows.join("\n"));
		dialog.press(" ");
		assert.ok(dialog.inner().includes("❯ 1. [✔] coding-agent"), dialog.inner().join("\n"));
	});

	test("keeps the preview beside the options at 80 columns", () => {
		const dialog = open(THREE, 80);
		dialog.press(TAB, TAB);
		const rows = dialog.inner();
		const row = rows.findIndex((line) => line.startsWith("❯ 1. Sidebar"));
		assert.ok(rows[row]?.includes("┌"), rows.join("\n"));
		assert.ok(rows[row + 1]?.includes("nav | main"), rows.join("\n"));
	});

	test("hint lines list exactly the keys of each step", () => {
		const dialog = open(THREE);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter/space toggle · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · n add notes · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · tab questions · esc cancel");
		assert.equal(open(ONE).hint(), "↑↓ select · enter choose · esc cancel");
	});

	test("enter answers and moves on; esc cancels the whole dialog", () => {
		const dialog = open(THREE);
		dialog.press(ENTER);
		assert.match(dialog.inner()[0] ?? "", /2\/3$/);
		dialog.press(ESC);
		assert.equal(dialog.result()?.cancelled, true);

		const single = open(ONE);
		single.press(DOWN, ENTER);
		assert.equal(single.result()?.answers[0]?.answer, "Simplify");
	});
});
