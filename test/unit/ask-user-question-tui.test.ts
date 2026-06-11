import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import {
	SENTINEL_LABELS,
	type QuestionParams,
	type QuestionnaireResult,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { WrappingSelect, type WrappingSelectItem } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";

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

function makePreviewParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which preview option?",
				header: "Preview",
				options: [
					{ label: "Alpha", description: "First option", preview: "# Alpha" },
					{ label: "Beta", description: "Second option" },
				],
			},
		],
	};
}

function makeMultiParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which options?",
				header: "Multi",
				multiSelect: true,
				options: [
					{ label: "Alpha", description: "First option" },
					{ label: "Beta", description: "Second option" },
				],
			},
		],
	};
}

function makeSession(params: QuestionParams, done: (result: QuestionnaireResult) => void = () => {}): QuestionnaireSession {
	return new QuestionnaireSession({
		tui: { terminal: { columns: 100 }, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done,
	});
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

test("ask_user_question chat row captures typed inline text as a chat answer", () => {
	initTheme("dark");
	const params = makeParams();
	let result: QuestionnaireResult | undefined;
	const session = makeSession(params, (r) => {
		result = r;
	});

	session.component.handleInput(UP);
	for (const ch of "Let's discuss another approach") session.component.handleInput(ch);
	session.component.handleInput(ENTER);

	assert.ok(result);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0]?.kind, "chat");
	assert.equal(result.answers[0]?.answer, "Let's discuss another approach");
});

test("ask_user_question chat row arrow keys edit the inline caret in multi-question dialogs", () => {
	initTheme("dark");
	const params: QuestionParams = {
		questions: [
			{
				question: "First question?",
				header: "First",
				options: [{ label: "Alpha", description: "First option" }],
			},
			{
				question: "Second question?",
				header: "Second",
				options: [{ label: "Beta", description: "Second option" }],
			},
		],
	};
	let result: QuestionnaireResult | undefined;
	const session = makeSession(params, (r) => {
		result = r;
	});

	session.component.handleInput(UP);
	for (const ch of "abc") session.component.handleInput(ch);
	session.component.handleInput(LEFT);
	session.component.handleInput(LEFT);
	session.component.handleInput(RIGHT);
	session.component.handleInput("X");
	session.component.handleInput(ENTER);

	assert.ok(result);
	assert.equal(result.cancelled, false);
	assert.equal(result.answers.length, 1);
	assert.equal(result.answers[0]?.questionIndex, 0);
	assert.equal(result.answers[0]?.kind, "chat");
	assert.equal(result.answers[0]?.answer, "abXc");
});

test("ask_user_question chat row preserves legacy sentinel answer for empty or whitespace input", () => {
	initTheme("dark");
	for (const typed of ["", "   "]) {
		const params = makeParams();
		let result: QuestionnaireResult | undefined;
		const session = makeSession(params, (r) => {
			result = r;
		});

		session.component.handleInput(UP);
		for (const ch of typed) session.component.handleInput(ch);
		session.component.handleInput(ENTER);

		assert.ok(result);
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]?.kind, "chat");
		assert.equal(result.answers[0]?.answer, SENTINEL_LABELS.chat);
	}
});

test("ask_user_question chat and custom inline drafts stay isolated when focus moves", () => {
	initTheme("dark");
	const params = makeParams();
	const session = makeSession(params);

	session.component.handleInput(DOWN);
	session.component.handleInput(DOWN);
	for (const ch of "custom draft") session.component.handleInput(ch);
	session.component.handleInput(DOWN);
	let rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.doesNotMatch(rendered, /custom draft/);

	for (const ch of "chat draft") session.component.handleInput(ch);
	rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.match(rendered, /chat draft/);

	session.component.handleInput(UP);
	rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.match(rendered, /custom draft/);
	assert.doesNotMatch(rendered, /chat draft/);

	session.component.handleInput(DOWN);
	rendered = stripAnsi(session.component.render(100).join("\n"));
	assert.match(rendered, /chat draft/);
	assert.doesNotMatch(rendered, /custom draft/);
});

test("ask_user_question chat row accepts typed text when preview suppresses custom input", () => {
	initTheme("dark");
	const params = makePreviewParams();
	let result: QuestionnaireResult | undefined;
	const session = makeSession(params, (r) => {
		result = r;
	});

	session.component.handleInput(UP);
	for (const ch of "Discuss the previews") session.component.handleInput(ch);
	session.component.handleInput(ENTER);

	assert.ok(result);
	assert.equal(result.answers[0]?.kind, "chat");
	assert.equal(result.answers[0]?.answer, "Discuss the previews");
});

test("ask_user_question chat row accepts typed text on multi-select questions", () => {
	initTheme("dark");
	const params = makeMultiParams();
	let result: QuestionnaireResult | undefined;
	const session = makeSession(params, (r) => {
		result = r;
	});

	session.component.handleInput(UP);
	for (const ch of "Discuss multi-select instead") session.component.handleInput(ch);
	session.component.handleInput(ENTER);

	assert.ok(result);
	assert.equal(result.answers[0]?.kind, "chat");
	assert.equal(result.answers[0]?.answer, "Discuss multi-select instead");
});

test("ask_user_question chat row renders inline input through WrappingSelect metadata", () => {
	const items: WrappingSelectItem[] = [{ kind: "chat", label: SENTINEL_LABELS.chat }];
	const select = new WrappingSelect(items, 1, {
		selectedText: (s) => s,
		description: (s) => s,
		scrollInfo: (s) => s,
	});
	select.setInputBuffer("chat");
	select.setInputCursor(4);

	const rendered = select.render(40).join("\n");
	assert.match(rendered, /chat\x1b\[7m \x1b\[0m/);
});
