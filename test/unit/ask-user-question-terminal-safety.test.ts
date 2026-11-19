import assert from "node:assert/strict";
import { getKeybindings, type TUI } from "@bastani/atomic-tui";
import { beforeEach, describe, test } from "vitest";
import {
	buildItemsForQuestion,
	buildQuestionnaireResponse,
	buildToolResult,
	createAskUserQuestionToolDefinition,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireState } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/state.ts";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { PreviewBlockRenderer } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-block-renderer.ts";
import { WrappingSelect } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.ts";
import { SubmitTabStrategy } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/tab-content-strategy.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const OSC52 = "\x1b]52;c;aGk=\x07";
const CLEAR = "\x1b[2J";
const C1_CSI = "\u009b2J";
const BEL = "\x07";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";

const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

const stripAllowedStyling = (line: string): string =>
	line
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b_(?:pi:(?:c|\/?fc|\/h|h:[^\x07\x1b]*)|atomic:active)(?:\x07|\x1b\\)/g, "");

function assertNoControlEscapes(lines: readonly string[], label: string): void {
	const raw = lines.join("\n");
	assert.equal(raw.includes("\x1b]"), false, `${label}: raw OSC present`);
	assert.equal(raw.includes("\x1b[2J"), false, `${label}: raw CSI 2J present`);
	assert.equal(raw.includes("\u009b"), false, `${label}: raw C1 CSI present`);
	const stripped = lines.map(stripAllowedStyling).join("\n");
	assert.equal(stripped.includes("\x1b"), false, `${label}: unexpected ESC present in ${JSON.stringify(stripped)}`);
	assert.equal(stripped.includes(BEL), false, `${label}: unexpected BEL present in ${JSON.stringify(stripped)}`);
	assert.equal(stripped.includes("\u009b"), false, `${label}: unexpected C1 present in ${JSON.stringify(stripped)}`);
}

function renderRow(params: QuestionParams, result: QuestionnaireResult | undefined, id: string) {
	const tool = createAskUserQuestionToolDefinition();
	const component = new ToolExecutionComponent(
		"ask_user_question",
		id,
		params,
		{},
		tool,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
	try {
		if (result) {
			component.markExecutionStarted();
			component.setArgsComplete();
			component.updateResult({ ...buildQuestionnaireResponse(result, params), isError: false });
		}
		const collapsed = component.render(160);
		component.setExpanded(true);
		const expanded = component.render(160);
		return { collapsed, expanded };
	} finally {
		component.dispose();
	}
}

describe("ask_user_question terminal escape sanitization (#5244)", () => {
	beforeEach(() => initTheme("dark"));

	test("strips OSC 52, CSI 2J, BEL and C1 0x9b across pending, folded single, multi-select, declined and fallback transcript rows (#5244)", () => {
		const single: QuestionParams = {
			questions: [
				{
					question: `Pick ${CLEAR}one?`,
					header: `${OSC52}Nav`,
					options: [
						{ label: `A${CLEAR}`, description: "first" },
						{ label: `B${C1_CSI}`, description: "second" },
					],
				},
			],
		};
		const noHeader: QuestionParams = {
			questions: [
				{
					question: `Which${OSC52}${C1_CSI}?`,
					header: "",
					options: [
						{ label: `C${CLEAR}`, description: "third" },
						{ label: `D${C1_CSI}`, description: "fourth" },
					],
				},
			],
		};
		const multi: QuestionParams = {
			questions: [
				single.questions[0]!,
				{
					question: `Second${OSC52}?`,
					header: `Pkg${OSC52}${C1_CSI}`,
					multiSelect: true,
					options: [
						{ label: `M${CLEAR}`, description: "m" },
						{ label: `N${C1_CSI}`, description: "n" },
					],
				},
			],
		};

		const pendingHeader = renderRow(single, undefined, "p-header");
		assertNoControlEscapes(pendingHeader.collapsed, "pending.header.collapsed");
		assertNoControlEscapes(pendingHeader.expanded, "pending.header.expanded");
		assert.match(pendingHeader.collapsed.map(stripAllowedStyling).join("\n"), /Questions · Nav/);

		const pendingQuestion = renderRow(noHeader, undefined, "p-question");
		assertNoControlEscapes(pendingQuestion.collapsed, "pending.question.collapsed");
		assertNoControlEscapes(pendingQuestion.expanded, "pending.question.expanded");
		assert.match(pendingQuestion.collapsed.map(stripAllowedStyling).join("\n"), /Questions · Which\?/);

		const singleOption = renderRow(
			single,
			{ answers: [{ questionIndex: 0, question: "q", kind: "option", answer: `A${CLEAR}` }], cancelled: false },
			"a-option",
		);
		assertNoControlEscapes(singleOption.collapsed, "single.option.collapsed");
		assertNoControlEscapes(singleOption.expanded, "single.option.expanded");
		assert.match(singleOption.collapsed.map(stripAllowedStyling).join("\n"), /Nav → A/);

		const singleNotes = renderRow(
			single,
			{
				answers: [{ questionIndex: 0, question: "q", kind: "option", answer: "B", notes: `note${OSC52}${C1_CSI}` }],
				cancelled: false,
			},
			"a-notes",
		);
		assertNoControlEscapes(singleNotes.collapsed, "single.notes.collapsed");
		assertNoControlEscapes(singleNotes.expanded, "single.notes.expanded");
		assert.match(singleNotes.collapsed.map(stripAllowedStyling).join("\n"), /Nav → B · notes: note/);

		const singleCustom = renderRow(
			noHeader,
			{
				answers: [{ questionIndex: 0, question: "q", kind: "custom", answer: `typed${CLEAR}${C1_CSI}` }],
				cancelled: false,
			},
			"a-custom",
		);
		assertNoControlEscapes(singleCustom.collapsed, "single.custom.collapsed");
		assertNoControlEscapes(singleCustom.expanded, "single.custom.expanded");
		assert.match(singleCustom.collapsed.map(stripAllowedStyling).join("\n"), /Which\? → "typed"/);

		const multiAnswered = renderRow(
			multi,
			{
				answers: [
					{ questionIndex: 0, question: "q1", kind: "option", answer: `A${CLEAR}`, notes: `n1${OSC52}` },
					{
						questionIndex: 1,
						question: "q2",
						kind: "multi",
						answer: null,
						selected: [`M${CLEAR}`, `N${C1_CSI}`],
						notes: `n2${C1_CSI}`,
					},
				],
				cancelled: false,
			},
			"a-multi",
		);
		assertNoControlEscapes(multiAnswered.collapsed, "multi.collapsed");
		assertNoControlEscapes(multiAnswered.expanded, "multi.expanded");
		const multiText = multiAnswered.collapsed.map(stripAllowedStyling).join("\n");
		assert.match(multiText, /Nav → A · notes: n1/);
		assert.match(multiText, /Pkg → M, N · notes: n2/);

		const declined = renderRow(multi, { answers: [], cancelled: true }, "d-multi");
		assertNoControlEscapes(declined.collapsed, "declined.collapsed");
		assertNoControlEscapes(declined.expanded, "declined.expanded");
		const declinedText = declined.collapsed.map(stripAllowedStyling).join("\n");
		assert.deepEqual(
			declinedText.split("\n").filter((line) => line.trim()),
			[" ◼ Questions cancelled"],
		);
		assert.doesNotMatch(declinedText, /Nav|Pkg|Declined/);

		const tool = createAskUserQuestionToolDefinition();
		const fallbackRow = new ToolExecutionComponent(
			"ask_user_question",
			"fallback-1",
			single,
			{},
			tool,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			fallbackRow.updateResult({
				content: [{ type: "text", text: `Line1 ${OSC52}ok\nLine2 ${CLEAR}${C1_CSI}done` }],
				details: undefined,
				isError: false,
			});
			const collapsed = fallbackRow.render(160);
			fallbackRow.setExpanded(true);
			const expanded = fallbackRow.render(160);
			assertNoControlEscapes(collapsed, "fallback.collapsed");
			assertNoControlEscapes(expanded, "fallback.expanded");
			const text = collapsed.map(stripAllowedStyling).join("\n");
			assert.match(text, /Line1 ok/);
			assert.match(text, /Line2 done/);
		} finally {
			fallbackRow.dispose();
		}
	});

	test("collapses newlines and tabs in one-line transcript summaries (#5244)", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "What\n\tnext?",
					header: "Nav\n\tStep",
					options: [
						{ label: "Build\n\tit", description: "d1" },
						{ label: "Skip\n\tnow", description: "d2" },
					],
				},
			],
		};
		const pending = renderRow(params, undefined, "ws-pending");
		assert.match(pending.collapsed.map(stripAllowedStyling).join("\n"), /Questions · Nav Step/);

		const answered = renderRow(
			params,
			{
				answers: [
					{
						questionIndex: 0,
						question: params.questions[0]!.question,
						kind: "option",
						answer: "Build\n\tit",
						notes: "first\n\tsecond",
					},
				],
				cancelled: false,
			},
			"ws-answered",
		);
		const nonEmpty = answered.collapsed
			.map(stripAllowedStyling)
			.map((l) => l.trim())
			.filter(Boolean);
		assert.deepEqual(nonEmpty, ["● Nav Step → Build it · notes: first second"]);

		const declined = renderRow(params, { answers: [], cancelled: true }, "ws-declined");
		const declinedNonEmpty = declined.collapsed
			.map(stripAllowedStyling)
			.map((l) => l.trim())
			.filter(Boolean);
		assert.deepEqual(declinedNonEmpty, ["◼ Questions cancelled"]);
	});

	test("transitions from answered summary to error result without duplicating error lines (#5244)", () => {
		const params: QuestionParams = {
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
		const answeredResult: QuestionnaireResult = {
			answers: [{ questionIndex: 0, question: "q", kind: "option", answer: "Build it as shown" }],
			cancelled: false,
		};

		const tool = createAskUserQuestionToolDefinition();
		const rowDetailsError = new ToolExecutionComponent(
			"ask_user_question",
			"transition-details-err",
			params,
			{},
			tool,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			rowDetailsError.markExecutionStarted();
			rowDetailsError.setArgsComplete();
			rowDetailsError.updateResult({ ...buildQuestionnaireResponse(answeredResult, params), isError: false });
			assert.match(
				rowDetailsError.render(120).map(stripAllowedStyling).join("\n"),
				/Navigation → Build it as shown/,
			);

			const errEnvelope = buildToolResult("Error: UI not available (running in non-interactive mode)", {
				answers: [],
				cancelled: true,
				error: "no_ui",
			});
			rowDetailsError.updateResult({ ...errEnvelope, isError: false });
			const firstRender = rowDetailsError.render(120).map(stripAllowedStyling).join("\n");
			assert.equal(firstRender.split("Error: UI not available").length - 1, 1, firstRender);
			assert.equal(firstRender.includes("Navigation → Build it as shown"), false, firstRender);

			rowDetailsError.invalidate();
			const secondRender = rowDetailsError.render(120).map(stripAllowedStyling).join("\n");
			assert.equal(secondRender.split("Error: UI not available").length - 1, 1, secondRender);
		} finally {
			rowDetailsError.dispose();
		}

		const rowIsError = new ToolExecutionComponent(
			"ask_user_question",
			"transition-is-error",
			params,
			{},
			tool,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			rowIsError.markExecutionStarted();
			rowIsError.setArgsComplete();
			rowIsError.updateResult({ ...buildQuestionnaireResponse(answeredResult, params), isError: false });
			rowIsError.render(120);

			rowIsError.updateResult({
				content: [{ type: "text", text: `Fatal ${OSC52}${CLEAR}${C1_CSI}error` }],
				details: answeredResult,
				isError: true,
			});
			const firstLines = rowIsError.render(120);
			assertNoControlEscapes(firstLines, "transition.isError.first");
			const firstText = firstLines.map(stripAllowedStyling).join("\n");
			assert.equal(firstText.split("Fatal error").length - 1, 1, firstText);
			assert.equal(firstText.includes("Navigation → Build it as shown"), false, firstText);

			rowIsError.invalidate();
			const secondText = rowIsError.render(120).map(stripAllowedStyling).join("\n");
			assert.equal(secondText.split("Fatal error").length - 1, 1, secondText);
		} finally {
			rowIsError.dispose();
		}
	});

	test("strips terminal escapes in dialog headers, questions, options, previews, pasted notes, inline inputs and review while preserving raw result (#5244)", () => {
		getKeybindings();
		const singleParams: QuestionParams = {
			questions: [
				{
					question: `How ${CLEAR}should ${C1_CSI}navigation work?`,
					header: `${OSC52}Nav`,
					options: [
						{ label: `Build${CLEAR}`, description: `Follow${C1_CSI}` },
						{ label: `Simplify${OSC52}`, description: `Drop${CLEAR}` },
					],
				},
			],
		};
		const singleSession = new QuestionnaireSession({
			tui: { terminal: { columns: 80 }, requestRender() {} },
			theme,
			params: singleParams,
			itemsByTab: singleParams.questions.map(buildItemsForQuestion),
			done: () => {},
		});
		const singleLines = singleSession.component.render(80);
		assertNoControlEscapes(singleLines, "dialog.single");
		const singlePlain = singleLines.map(stripAllowedStyling).join("\n");
		assert.match(singlePlain, /Nav/);
		assert.match(singlePlain, /How should navigation work\?/);
		assert.match(singlePlain, /1\. Build/);
		assert.match(singlePlain, /Follow/);

		const multiParams: QuestionParams = {
			questions: [
				{
					question: `Layout ${CLEAR}choice?`,
					header: `${OSC52}Layout`,
					options: [
						{
							label: `Sidebar${CLEAR}`,
							description: `Left${C1_CSI}`,
							preview: `nav ${OSC52}| main\n${CLEAR}${C1_CSI}body`,
						},
						{ label: `Top${C1_CSI}`, description: `Up${OSC52}`, preview: "top" },
					],
				},
				{
					question: `Packages ${OSC52}?`,
					header: `Pkg${C1_CSI}`,
					multiSelect: true,
					options: [
						{ label: `agent${CLEAR}`, description: `cli${C1_CSI}` },
						{ label: `workflows${OSC52}`, description: `dag${CLEAR}` },
					],
				},
				{
					question: `Confirm ${C1_CSI}?`,
					header: `End${OSC52}`,
					options: [
						{ label: "Yes", description: "y" },
						{ label: "No", description: "n" },
					],
				},
			],
		};
		let completedResult: QuestionnaireResult | undefined;
		const multiSession = new QuestionnaireSession({
			tui: { terminal: { columns: 100 }, requestRender() {} },
			theme,
			params: multiParams,
			itemsByTab: multiParams.questions.map(buildItemsForQuestion),
			done: (res) => {
				completedResult = res;
			},
		});
		const tab0Lines = multiSession.component.render(100);
		assertNoControlEscapes(tab0Lines, "dialog.multi.tab0");
		assert.match(tab0Lines.map(stripAllowedStyling).join("\n"), /Layout ── Pkg ── End ── Review/);

		const rawNote = `note${OSC52}${CLEAR}${C1_CSI}`;
		multiSession.component.handleInput("n");
		multiSession.component.handleInput(paste(rawNote));
		assertNoControlEscapes(multiSession.component.render(100), "dialog.multi.notesOpenPaste");
		multiSession.component.handleInput(ENTER);
		assertNoControlEscapes(multiSession.component.render(100), "dialog.multi.notesSavedAffordance");

		multiSession.component.handleInput(ENTER);
		const tab1Lines = multiSession.component.render(100);
		assertNoControlEscapes(tab1Lines, "dialog.multi.tab1");
		const tab1Plain = tab1Lines.map(stripAllowedStyling).join("\n");
		assert.match(tab1Plain, /1\. \[ \] agent/);
		assert.match(tab1Plain, /cli/);

		multiSession.component.handleInput(" ");
		multiSession.component.handleInput(DOWN);
		multiSession.component.handleInput(DOWN);
		multiSession.component.handleInput(ENTER);

		const rawCustom = `custom${OSC52}${CLEAR}${C1_CSI}`;
		const rawChat = `chat${OSC52}${CLEAR}${C1_CSI}`;
		multiSession.component.handleInput(DOWN);
		multiSession.component.handleInput(DOWN);
		multiSession.component.handleInput(paste(rawCustom));
		assertNoControlEscapes(multiSession.component.render(100), "dialog.multi.customInlineActive");

		multiSession.component.handleInput(DOWN);
		multiSession.component.handleInput(paste(rawChat));
		assertNoControlEscapes(multiSession.component.render(100), "dialog.multi.chatInlineActiveAndCustomAtRest");

		multiSession.component.handleInput(UP);
		multiSession.component.handleInput(ENTER);
		const reviewLines = multiSession.component.render(100);
		assertNoControlEscapes(reviewLines, "dialog.multi.review");

		multiSession.component.handleInput(TAB);
		multiSession.component.handleInput(TAB);
		multiSession.component.handleInput(TAB);
		assertNoControlEscapes(multiSession.component.render(100), "dialog.multi.confirmedCustomAtRest");

		multiSession.component.handleInput(TAB);
		multiSession.component.handleInput(ENTER);
		assert.ok(completedResult, "expected questionnaire completion");
		assert.equal(completedResult.cancelled, false);
		assert.equal(completedResult.answers[0]?.answer, `Sidebar${CLEAR}`);
		assert.equal(completedResult.answers[0]?.notes, rawNote);
		assert.deepEqual(completedResult.answers[1]?.selected, [`agent${CLEAR}`]);
		assert.equal(completedResult.answers[2]?.answer, rawCustom);

		const submitStrategy = new SubmitTabStrategy({
			theme,
			questions: multiParams.questions,
			submitPicker: undefined,
		});
		const reviewState: QuestionnaireState = {
			currentTab: 3,
			optionIndex: 0,
			inputMode: false,
			inlineInputOwner: null,
			notesVisible: false,
			chatFocused: false,
			answers: new Map([
				[
					0,
					{
						questionIndex: 0,
						question: "q0",
						kind: "option",
						answer: `Sidebar${CLEAR}`,
						notes: rawNote,
					},
				],
			]),
			multiSelectChecked: new Set(),
			notesByTab: new Map(),
			focusedOptionHasPreview: false,
			submitChoiceIndex: 0,
			notesDraft: "",
			customDraftByTab: new Map(),
			customCaretByTab: new Map(),
			chatDraftByTab: new Map(),
			chatCaretByTab: new Map(),
		};
		const reviewBody = submitStrategy.bodyComponent(reviewState).render(100);
		const reviewFooter = submitStrategy.footerRows(reviewState).flatMap((c) => c.render(100));
		assertNoControlEscapes(reviewBody, "dialog.submitStrategy.body");
		assertNoControlEscapes(reviewFooter, "dialog.submitStrategy.footer");

		const previewRenderer = new PreviewBlockRenderer({
			question: multiParams.questions[0]!,
			theme,
			markdownTheme: getMarkdownTheme(),
		});
		const previewLines = previewRenderer.renderBlock(
			60,
			0,
			"side-by-side",
			true,
			false,
			`saved${OSC52}${CLEAR}${C1_CSI}`,
		);
		assertNoControlEscapes(previewLines, "dialog.previewBlockRenderer");

		const wrappingSelect = new WrappingSelect(
			[
				{ kind: "option", label: `Opt${CLEAR}`, description: `Desc${C1_CSI}` },
				{ kind: "other", label: "Type something." },
			],
			10,
			{
				field: (_tone, s) => s,
				description: (s) => s,
				scrollInfo: (s) => s,
			},
		);
		wrappingSelect.setConfirmedIndex(1, `custom${OSC52}${CLEAR}${C1_CSI}`);
		assertNoControlEscapes(wrappingSelect.render(80), "dialog.wrappingSelect.atRest");
		wrappingSelect.setSelectedIndex(1);
		wrappingSelect.setInputBuffer(`draft${OSC52}${CLEAR}${C1_CSI}`);
		wrappingSelect.setInputCursor(5);
		assertNoControlEscapes(wrappingSelect.render(80), "dialog.wrappingSelect.inlineActive");
	});
});
