import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { WrappingSelect, type WrappingSelectItem } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";

function makeParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which option?",
				header: "Choice",
				options: [
					{ label: "Alpha", description: "First option" },
					{ label: "Beta", description: "Second option" },
				],
			},
		],
	};
}

test("ask_user_question custom response draft survives moving to another option", () => {
	initTheme("dark");
	const params = makeParams();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 100 }, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done() {},
	});

	// Move from Alpha -> Beta -> Type something.
	session.component.handleInput(DOWN);
	session.component.handleInput(DOWN);
	for (const ch of "custom") session.component.handleInput(ch);

	// Leave the custom row, then return to it. The draft should still be there.
	session.component.handleInput(UP);
	session.component.handleInput(DOWN);

	const rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.match(rendered, /custom/);
});

test("ask_user_question custom response renders the main chat cursor at the editing caret", () => {
	const items: WrappingSelectItem[] = [{ kind: "other", label: "Type something." }];
	const select = new WrappingSelect(items, 1, {
		selectedText: (s) => s,
		description: (s) => s,
		scrollInfo: (s) => s,
	});
	select.setInputBuffer("abc");
	select.setInputCursor(2);

	const rendered = select.render(40).join("\n");
	assert.match(rendered, /ab\x1b\[7mc\x1b\[0m/);
});

test("ask_user_question custom response editor keeps typing at the moved caret", () => {
	initTheme("dark");
	const params = makeParams();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 100 }, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done() {},
	});

	session.component.handleInput(DOWN);
	session.component.handleInput(DOWN);
	for (const ch of "abc") session.component.handleInput(ch);
	session.component.handleInput(LEFT);
	session.component.handleInput("X");

	const rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.match(rendered, /abXc/);
});
