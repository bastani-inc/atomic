import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { createToolHtmlRenderer } from "../../packages/coding-agent/src/core/export-html/tool-renderer.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	buildItemsForQuestion,
	buildQuestionnaireResponse,
	createAskUserQuestionToolDefinition,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import {
	summarizeAnswers,
	summarizeQuestions,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/transcript-summary.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import {
	adaptiveLeftWidth,
	previewSourceWidth,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const stripAllowedStyling = (line: string): string =>
	line.replace(/\x1b\[[0-9;:]*m|\x1b_(?:pi:(?:c|\/?fc)|atomic:active)(?:\x07|\x1b\\)/g, "");

let previousKeybindings: ReturnType<typeof getKeybindings>;

beforeAll(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	setKeybindings(previousKeybindings);
});

describe("ask_user_question layout and summary safety (#5244)", () => {
	beforeEach(() => initTheme("dark"));

	test("preview layout measures sanitized option labels and previews so escaped bidi controls do not misalign columns (#5244)", () => {
		const rawLabel = "Long label \u202e here!";
		const displayedLabel = "Long label <U+202E> here!";
		const rawPreview = `${"w".repeat(30)}\u202e\u202e\u202e\u202e`;
		const displayedPreview = `${"w".repeat(30)}<U+202E><U+202E><U+202E><U+202E>`;

		const makeParams = (label: string, preview: string): QuestionParams => ({
			questions: [
				{
					question: "Layout?",
					header: "L",
					options: [
						{ label, description: "d", preview },
						{ label: "Other choice", description: "e", preview: "p" },
					],
				},
			],
		});

		const rawParams = makeParams(rawLabel, rawPreview);
		const displayedParams = makeParams(displayedLabel, displayedPreview);

		assert.equal(
			adaptiveLeftWidth(buildItemsForQuestion(rawParams.questions[0]!), 3, 100),
			adaptiveLeftWidth(buildItemsForQuestion(displayedParams.questions[0]!), 3, 100),
		);
		assert.equal(previewSourceWidth(rawParams.questions[0]!), previewSourceWidth(displayedParams.questions[0]!));

		for (const width of [80, 100, 120]) {
			const rawSession = new QuestionnaireSession({
				tui: { terminal: { columns: width }, requestRender() {} },
				theme,
				params: rawParams,
				itemsByTab: rawParams.questions.map(buildItemsForQuestion),
				done: () => {},
			});
			const displayedSession = new QuestionnaireSession({
				tui: { terminal: { columns: width }, requestRender() {} },
				theme,
				params: displayedParams,
				itemsByTab: displayedParams.questions.map(buildItemsForQuestion),
				done: () => {},
			});
			assert.deepEqual(
				rawSession.component.render(width).map(stripAllowedStyling),
				displayedSession.component.render(width).map(stripAllowedStyling),
				`mismatch at width ${width}`,
			);
		}
	});

	test("collapses line breaks in step headers and multi-select option labels so dialog frames stay one line per row (#5244)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "First?",
					header: "Nav\nX\r\nY",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Second?",
					header: "Pkg\nZ",
					multiSelect: true,
					options: [
						{ label: "Option\nOne\r\nHere", description: "c" },
						{ label: "Option\t\nTwo", description: "d" },
					],
				},
			],
		};

		const session = new QuestionnaireSession({
			tui: { terminal: { columns: 80 }, requestRender() {} },
			theme,
			params,
			itemsByTab: params.questions.map(buildItemsForQuestion),
			done: () => {},
		});

		const tab0Lines = session.component.render(80);
		for (const line of tab0Lines) {
			assert.equal(/[\n\r]/.test(line), false, `unexpected line break in tab 0 row: ${JSON.stringify(line)}`);
		}
		assert.match(tab0Lines.map(stripAllowedStyling).join("\n"), /Nav X Y ── Pkg Z ── Review/);

		session.component.handleInput("\t");
		const tab1Lines = session.component.render(80);
		for (const line of tab1Lines) {
			assert.equal(/[\n\r]/.test(line), false, `unexpected line break in tab 1 row: ${JSON.stringify(line)}`);
		}
		const tab1Plain = tab1Lines.map(stripAllowedStyling).join("\n");
		assert.match(tab1Plain, /1\. \[ \] Option One Here/);
		assert.match(tab1Plain, /2\. \[ \] Option Two/);
	});

	test("collapses line breaks in Review headers and missing-question footer prompts so dialog rows stay one line per row (#5224)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "First?",
					header: "Nav\nX",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Second?",
					header: "Pkg\r\nZ",
					options: [
						{ label: "C", description: "c" },
						{ label: "D", description: "d" },
					],
				},
			],
		};

		const session = new QuestionnaireSession({
			tui: { terminal: { columns: 80 }, requestRender() {} },
			theme,
			params,
			itemsByTab: params.questions.map(buildItemsForQuestion),
			done: () => {},
		});

		session.component.handleInput("\t");
		session.component.handleInput("\t");
		const reviewLines = session.component.render(80);
		for (const line of reviewLines) {
			assert.equal(/[\n\r]/.test(line), false, `unexpected line break in review row: ${JSON.stringify(line)}`);
		}
		const reviewPlain = reviewLines.map(stripAllowedStyling).join("\n");
		assert.match(reviewPlain, /Answer remaining questions before submitting: Nav X, Pkg Z/);

		session.component.handleInput("\t");
		session.component.handleInput("\r");
		session.component.handleInput("\t");
		const answeredReviewLines = session.component.render(80);
		for (const line of answeredReviewLines) {
			assert.equal(
				/[\n\r]/.test(line),
				false,
				`unexpected line break in answered review row: ${JSON.stringify(line)}`,
			);
		}
		const answeredReviewPlain = answeredReviewLines.map(stripAllowedStyling).join("\n");
		assert.match(answeredReviewPlain, /● Nav X/);
		assert.match(answeredReviewPlain, /Answer remaining questions before submitting: Pkg Z/);

		const singleParams: QuestionParams = {
			questions: [params.questions[0]!],
		};
		const singleSession = new QuestionnaireSession({
			tui: { terminal: { columns: 80 }, requestRender() {} },
			theme,
			params: singleParams,
			itemsByTab: singleParams.questions.map(buildItemsForQuestion),
			done: () => {},
		});
		const singleLines = singleSession.component.render(80);
		for (const line of singleLines) {
			assert.equal(
				/[\n\r]/.test(line),
				false,
				`unexpected line break in single-question row: ${JSON.stringify(line)}`,
			);
		}
		assert.match(singleLines.map(stripAllowedStyling).join("\n"), / Nav X /);
	});

	test("renders full error output and summaries when questions is missing or not an array (#5244)", () => {
		const malformedCases: readonly unknown[] = [
			undefined,
			null,
			"invalid",
			{ question: "Pick one?" },
			{ questions: undefined },
			{ questions: null },
			{ questions: "invalid" },
			{ questions: { question: "Pick one?" } },
		];
		for (const malformedArgs of malformedCases) {
			assert.equal(summarizeQuestions(malformedArgs as never), "Questions");
			assert.deepEqual(summarizeAnswers(malformedArgs as never, { answers: [], cancelled: true }), []);
		}
		const malformedElementArgs = {
			questions: [null, { header: 123, question: 456, options: "invalid" }],
		};
		assert.equal(summarizeQuestions(malformedElementArgs as never), "Questions · Q1 · Q2");
		assert.deepEqual(summarizeAnswers(malformedElementArgs as never, { answers: [], cancelled: true }), [
			"Declined · Q1 ()",
			"Declined · Q2 ()",
		]);

		const tool = createAskUserQuestionToolDefinition();
		const errorText = Array.from({ length: 14 }, (_, i) => `Validation failed line ${i + 1}`).join("\n");
		const errorResult = { content: [{ type: "text" as const, text: errorText }], details: undefined, isError: true };

		for (const [index, malformedArgs] of [...malformedCases, malformedElementArgs].entries()) {
			const callId = `malformed-q-${index}`;
			const component = new ToolExecutionComponent(
				"ask_user_question",
				callId,
				malformedArgs,
				{},
				tool,
				{ requestRender() {} } as TUI,
				process.cwd(),
			);
			try {
				const pending = component.render(120).map(stripAllowedStyling).join("\n");
				assert.match(pending, /Questions/);
				component.markExecutionStarted();
				component.setArgsComplete();
				component.updateResult(errorResult);
				const collapsed = component.render(120).map(stripAllowedStyling).join("\n");
				assert.match(collapsed, /Validation failed line 14/);
				assert.doesNotMatch(collapsed, /more lines/);
			} finally {
				component.dispose();
			}

			const htmlRenderer = createToolHtmlRenderer({
				getToolRenderers: () => tool,
				theme,
				cwd: process.cwd(),
			});
			const callHtml = htmlRenderer.renderCall(callId, "ask_user_question", malformedArgs);
			const resultHtml = htmlRenderer.renderResult(
				callId,
				"ask_user_question",
				errorResult.content,
				undefined,
				true,
			);
			assert.ok(callHtml?.includes("Questions"));
			assert.ok(resultHtml?.expanded?.includes("Validation failed line 14"));
		}

		const validParams: QuestionParams = {
			questions: [
				{
					question: "How should navigation work?",
					header: "Navigation",
					options: [
						{ label: "Build it as shown", description: "d1" },
						{ label: "Simplify", description: "d2" },
					],
				},
			],
		};
		const transitionRow = new ToolExecutionComponent(
			"ask_user_question",
			"transition-malformed",
			validParams,
			{},
			tool,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			transitionRow.markExecutionStarted();
			transitionRow.setArgsComplete();
			transitionRow.updateResult({
				...buildQuestionnaireResponse(
					{
						answers: [{ questionIndex: 0, question: "q", kind: "option", answer: "Build it as shown" }],
						cancelled: false,
					},
					validParams,
				),
				isError: false,
			});
			assert.match(transitionRow.render(120).map(stripAllowedStyling).join("\n"), /Navigation → Build it as shown/);
			transitionRow.updateArgs({ questions: "invalid" });
			transitionRow.updateResult(errorResult);
			const rendered = transitionRow.render(120).map(stripAllowedStyling).join("\n");
			assert.match(rendered, /Validation failed line 14/);
			assert.doesNotMatch(rendered, /Navigation → Build it as shown/);
		} finally {
			transitionRow.dispose();
		}
	});
});
