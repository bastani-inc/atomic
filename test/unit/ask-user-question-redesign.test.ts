import assert from "node:assert/strict";
import { type TUI, visibleWidth } from "@bastani/atomic-tui";
import { beforeEach, describe, test } from "vitest";
import {
	buildItemsForQuestion,
	createAskUserQuestionToolDefinition,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
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
		assert.match(dialog.inner()[0] ?? "", /Review +0\/3 answered$/);
	});

	test("numbers the options and indents each description under its label", () => {
		const rows = open(THREE).inner();
		const first = rows.indexOf("∀ 1. Build it as shown");
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
		const first = rows.indexOf("∀ 1. [ ] coding-agent");
		assert.ok(first > 0, rows.join("\n"));
		assert.equal(rows[first + 1], "         The CLI");
		assert.equal(rows[first + 2], "  2. [ ] workflows");
		assert.equal(rows[first + 3], "         Workflow engine");
		assert.ok(rows.includes("  3. Next"), rows.join("\n"));
		assert.ok(rows.includes("  4. Chat about this"), rows.join("\n"));
		dialog.press(" ");
		assert.ok(dialog.inner().includes("∀ 1. [✔] coding-agent"), dialog.inner().join("\n"));
	});

	test("keeps the preview beside the options at 80 columns", () => {
		const dialog = open(THREE, 80);
		dialog.press(TAB, TAB);
		const rows = dialog.inner();
		const row = rows.findIndex((line) => line.startsWith("∀ 1. Sidebar"));
		assert.ok(rows[row]?.includes("┌"), rows.join("\n"));
		assert.ok(rows[row + 1]?.includes("nav | main"), rows.join("\n"));
	});

	test("side-by-side previews start at a 68-column terminal after frame padding (#5244)", () => {
		for (const width of [67, 68]) {
			const dialog = open(THREE, width);
			dialog.press(TAB, TAB);
			const firstOption = dialog.inner().find((line) => line.startsWith("∀ 1. Sidebar"));
			assert.equal(firstOption?.includes("┌"), width === 68);
		}
	});

	test("hint lines list exactly the keys of each step", () => {
		const dialog = open(THREE);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter/space toggle · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · n add notes · tab next question · esc cancel");
		dialog.press("n", "x");
		assert.equal(dialog.hint(), "type a note · enter/esc close notes");
		dialog.press(ENTER);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · n add notes · tab next question · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ select · enter choose · tab questions · esc cancel");
		assert.equal(open(ONE).hint(), "↑↓ select · enter choose · esc cancel");
	});

	test("narrow hint lines keep cancellation and every question key visible (#5244)", () => {
		const dialog = open(THREE, 60);
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ · enter/space · tab · esc cancel");
		dialog.press(TAB);
		assert.equal(dialog.hint(), "↑↓ · enter · n notes · tab · esc cancel");
		assert.equal(dialog.hint(40), "↑↓ · enter · n · tab · esc");
		dialog.press("n");
		assert.equal(dialog.hint(), "type a note · enter/esc close notes");
	});

	test("hint lines follow the focused option, Next, chat and custom answer rows (#5244)", () => {
		const multi = open(THREE);
		multi.press(TAB, DOWN, DOWN);
		assert.equal(multi.hint(), "↑↓ select · enter choose · tab next question · esc cancel");
		multi.press(DOWN);
		assert.equal(multi.hint(), "↑↓ select · enter choose · tab next question · esc cancel");
		multi.press(TAB);
		assert.equal(multi.hint(), "↑↓ select · enter choose · n add notes · tab next question · esc cancel");
		multi.press("\x1b[A");
		assert.equal(multi.hint(), "↑↓ select · enter choose · tab next question · esc cancel");

		const custom = open(THREE);
		custom.press(DOWN, DOWN);
		assert.equal(custom.hint(), "↑↓ select · esc cancel");
		custom.press(TAB);
		assert.match(custom.inner()[0] ?? "", /1\/3$/);
	});

	test("custom-answer hints offer Enter only for a nonblank draft (#5244)", () => {
		for (const draft of ["", " ", "  "]) {
			const dialog = open(ONE);
			dialog.press(DOWN, DOWN);
			if (draft) dialog.press(`\x1b[200~${draft}\x1b[201~`);
			assert.equal(dialog.hint(), "↑↓ select · esc cancel");
			dialog.press(ENTER);
			assert.equal(dialog.result(), undefined);
			dialog.press("x");
			assert.equal(dialog.hint(), "↑↓ select · enter choose · esc cancel");
			dialog.press(ENTER);
			assert.equal(dialog.result()?.answers[0]?.answer, `${draft}x`);
		}
		const chat = open(ONE);
		chat.press("\x1b[A");
		assert.equal(chat.hint(), "↑↓ select · enter choose · esc cancel");
		chat.press(ENTER);
		assert.equal(chat.result()?.answers[0]?.kind, "chat");
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

describe("ask_user_question transcript summary (#5224)", () => {
	beforeEach(() => initTheme("dark"));

	const render = (result: QuestionnaireResult | undefined, params: QuestionParams = THREE) => {
		const tool = createAskUserQuestionToolDefinition();
		const state = {};
		const context = {
			args: params,
			toolCallId: "t1",
			invalidate: () => {},
			lastComponent: undefined,
			state,
			cwd: "/",
			executionStarted: true,
			argsComplete: true,
			isPartial: result === undefined,
			expanded: false,
			showImages: false,
			isError: false,
			durationMs: undefined,
		} as unknown as Parameters<NonNullable<typeof tool.renderCall>>[2];
		const rendered = () => ({
			call: (tool.renderCall?.(params as never, theme, context).render(120) ?? [])
				.map(plain)
				.map((l) => l.trimEnd()),
			result:
				result === undefined
					? []
					: (
							tool
								.renderResult?.(
									{ content: [], details: result },
									{ expanded: false, isPartial: false },
									theme,
									context,
								)
								.render(120) ?? []
						)
							.map(plain)
							.map((l) => l.trimEnd()),
		});
		const first = rendered();
		return result === undefined ? first : rendered();
	};

	test("while waiting, the call line names the questions", () => {
		assert.deepEqual(render(undefined).call, ["Questions · Navigation · Packaging · Layout"]);
	});

	test("one answered question is one line: header → answer", () => {
		const out = render(
			{
				answers: [
					{ questionIndex: 0, question: ONE.questions[0]!.question, kind: "option", answer: "Build it as shown" },
				],
				cancelled: false,
			},
			ONE,
		);
		assert.deepEqual(out.call, ["Questions · Navigation"]);
		assert.deepEqual(out.result, [" ● Navigation → Build it as shown"]);
	});

	test("several answers get a line each, multi-select joined, with notes", () => {
		const out = render({
			answers: [
				{ questionIndex: 0, question: "q0", kind: "option", answer: "Simplify" },
				{ questionIndex: 1, question: "q1", kind: "multi", answer: null, selected: ["coding-agent", "workflows"] },
				{ questionIndex: 2, question: "q2", kind: "option", answer: "Sidebar", notes: "keep it narrow" },
			],
			cancelled: false,
		});
		assert.deepEqual(out.call, ["Questions · Navigation · Packaging · Layout"]);
		assert.deepEqual(out.result, [
			" ● Navigation → Simplify",
			"   ⎿  Packaging → coding-agent, workflows",
			"   ⎿  Layout → Sidebar · notes: keep it narrow",
		]);
	});

	test("questionnaire errors stay visible instead of appearing declined (#5244)", async () => {
		const tool = createAskUserQuestionToolDefinition();
		const result = await tool.execute("no-ui", ONE, undefined, undefined, {
			hasUI: false,
			ui: {},
		} as Parameters<typeof tool.execute>[4]);
		const row = new ToolExecutionComponent(
			"ask_user_question",
			"no-ui",
			ONE,
			{},
			tool,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			row.updateResult({ ...result, isError: false });
			const output = row.render(120).map(plain).join("\n");
			assert.ok(output.includes("Error: UI not available"), output);
			assert.ok(!output.includes("Declined"), output);
		} finally {
			row.dispose();
		}
	});

	test("a cancelled questionnaire renders a stopped header (#5350)", () => {
		const out = render({ answers: [], cancelled: true }, ONE);
		assert.deepEqual(out.call, ["Questions · Navigation"]);
		assert.deepEqual(out.result, [" ◼ Questions cancelled"]);
	});
});
