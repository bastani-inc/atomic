import assert from "node:assert/strict";
import { CURSOR_MARKER, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterAll, beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	escapeBidiControls,
	MAX_CONTROL_STRING_LENGTH,
	TerminalTextSanitizer,
	terminalDisplayText,
	UNTERMINATED_CONTROL_SEQUENCE_MARKER,
} from "../../packages/coding-agent/src/utils/terminal-text.ts";

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ENTER = "\r";
const SHIFT_TAB = "\x1b[Z";
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const ALLOWED_ANSI = /\x1b\[[0-9;:]*m|\x1b_(?:pi:(?:c|\/?fc)|atomic:active)(?:\x07|\x1b\\)/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const stripAllowedAnsi = (text: string): string => text.replace(ALLOWED_ANSI, "");
const sanitizedPrefix = (raw: string): string => escapeBidiControls(new TerminalTextSanitizer().write(raw));

let previousKeybindings: ReturnType<typeof getKeybindings>;

beforeAll(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	setKeybindings(previousKeybindings);
});

describe("ask_user_question sanitizer and editor caret regressions (#5244)", () => {
	test("control-string length limit does not split a surrogate pair into a lone surrogate", () => {
		const raw = `\x1b]${"a".repeat(MAX_CONTROL_STRING_LENGTH - 1)}🙂tail`;
		const expected = `${UNTERMINATED_CONTROL_SEQUENCE_MARKER}tail`;
		const out = terminalDisplayText(raw);
		assert.equal(LONE_SURROGATE.test(out), false, `unexpected lone surrogate in ${JSON.stringify(out)}`);
		assert.equal(out, expected);

		const splitPoint = 2 + MAX_CONTROL_STRING_LENGTH;
		const chunked = new TerminalTextSanitizer();
		const streamed = chunked.write(raw.slice(0, splitPoint)) + chunked.write(raw.slice(splitPoint)) + chunked.end();
		assert.equal(LONE_SURROGATE.test(streamed), false);
		assert.equal(streamed, expected);

		const params: QuestionParams = {
			questions: [
				{
					question: raw,
					header: "Nav",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const session = new QuestionnaireSession({
			tui: { terminal: { columns: 120 }, requestRender() {} },
			theme,
			params,
			itemsByTab: params.questions.map(buildItemsForQuestion),
			done: () => {},
		});
		const lines = session.component.render(120);
		assert.equal(
			lines.some((line) => LONE_SURROGATE.test(line)),
			false,
		);
	});

	test("caret inside a pasted control string stays at the prefix boundary without splitting surrogates across all three editors", () => {
		const previewParams: QuestionParams = {
			questions: [
				{
					question: "Pick?",
					header: "Nav",
					options: [
						{ label: "A", description: "a", preview: "preview A" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const plainParams: QuestionParams = {
			questions: [
				{
					question: "Pick plain?",
					header: "Plain",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		};
		const segmenter = new Intl.Segmenter();
		const editors = [
			{ name: "other", params: plainParams, enterKeys: [DOWN, DOWN], marker: "\x1b[7m" },
			{ name: "chat", params: previewParams, enterKeys: [DOWN, DOWN], marker: "\x1b[7m" },
			{ name: "notes", params: previewParams, enterKeys: ["n"], marker: CURSOR_MARKER },
		] as const;

		for (const editor of editors) {
			for (const seq of ["\x1b]0;title\x07", "\u009d0;title\u009c", "\x1bPq\x1b\\"]) {
				for (const xs of [36, 37, 38, 39]) {
					const tail = `${"x".repeat(xs)}🙂🙂`;
					const raw = `ab${seq}${tail}`;
					const graphemes = [...segmenter.segment(raw)];
					const minLefts = [...segmenter.segment(tail)].length + 1;
					const maxLefts = graphemes.length - 2;
					for (let lefts = minLefts; lefts <= maxLefts; lefts++) {
						const session = new QuestionnaireSession({
							tui: { terminal: { columns: 200 }, requestRender() {} },
							theme,
							params: editor.params,
							itemsByTab: editor.params.questions.map(buildItemsForQuestion),
							done: () => {},
						});
						session.component.render(200);
						for (const key of editor.enterKeys) session.component.handleInput(key);
						session.component.handleInput(paste(raw));
						for (let i = 0; i < lefts; i++) session.component.handleInput(LEFT);
						const lines = session.component.render(200);
						for (const line of lines) {
							assert.equal(
								LONE_SURROGATE.test(line),
								false,
								`${editor.name} xs=${xs} lefts=${lefts} emitted lone surrogate`,
							);
						}
						const cursorLine = lines.find((line) => line.includes(editor.marker));
						assert.ok(cursorLine, `${editor.name}: expected cursor row`);
						const before = stripAllowedAnsi(cursorLine.slice(0, cursorLine.indexOf(editor.marker)));
						const shown = before.slice(before.indexOf("ab"));
						const cursorIndex = graphemes[graphemes.length - lefts]!.index;
						const expected = sanitizedPrefix(raw.slice(0, cursorIndex));
						assert.equal(shown, expected, `${editor.name} xs=${xs} lefts=${lefts}`);
					}
				}
			}
		}
	});

	test("confirmed custom answer with sanitized control or bidi characters keeps its check mark when returning to the tab", () => {
		const twoQuestions: QuestionParams = {
			questions: [
				{
					question: "First?",
					header: "One",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Second?",
					header: "Two",
					options: [
						{ label: "C", description: "c" },
						{ label: "D", description: "d" },
					],
				},
			],
		};

		const cases: ReadonlyArray<readonly [string, string]> = [
			["hi\x1b[2J", "3. hi ✔"],
			["hi\u202e", "3. hi<U+202E> ✔"],
			["hi\u009b2J", "3. hi ✔"],
		];

		for (const [typed, expectedRow] of cases) {
			const session = new QuestionnaireSession({
				tui: { terminal: { columns: 120 }, requestRender() {} },
				theme,
				params: twoQuestions,
				itemsByTab: twoQuestions.questions.map(buildItemsForQuestion),
				done: () => {},
			});
			session.component.render(120);
			session.component.handleInput(DOWN);
			session.component.handleInput(DOWN);
			session.component.handleInput(paste(typed));
			session.component.handleInput(ENTER);
			session.component.render(120);
			session.component.handleInput(SHIFT_TAB);
			const lines = session.component.render(120).map(stripAllowedAnsi);
			const row = lines.find((line) => line.includes("3. "));
			assert.ok(row, `expected row 3 for ${JSON.stringify(typed)}`);
			assert.equal(
				row.includes(expectedRow),
				true,
				`expected ${JSON.stringify(expectedRow)} in ${JSON.stringify(row)}`,
			);
		}
	});
});
