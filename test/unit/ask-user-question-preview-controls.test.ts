import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { OVERLAY_ACTIVE_ROW_MARKER } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.js";
import { buildQuestionnaireResponse } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/response-envelope.js";
import type {
	QuestionData,
	QuestionnaireResult,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { OptionListView } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/option-list-view.js";
import { crossTabLeftWidthWithDonation } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.js";
import {
	PreviewBlockRenderer,
	PreviewPane,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-pane.js";
import { getMarkdownTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { assertNoRawControls, HOSTILE_CONTROLS } from "../helpers/terminal-controls.js";

function makePane(question: QuestionData) {
	initTheme("dark");
	let terminalWidth = 140;
	const items = buildItemsForQuestion(question);
	const optionListView = new OptionListView({
		items,
		theme: {
			selectedText: (s: string) => theme.fg("accent", theme.bold(s)),
			description: (s: string) => theme.fg("muted", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
		},
	});
	const pane = new PreviewPane({
		question,
		getTerminalWidth: () => terminalWidth,
		optionListView,
		previewBlock: new PreviewBlockRenderer({ question, theme, markdownTheme: getMarkdownTheme() }),
	});
	pane.setGlobalLeftWidth((width) => crossTabLeftWidthWithDonation([{}], [items], [question], width));
	return {
		pane,
		render(selectedIndex: number, terminal: number, width: number) {
			terminalWidth = terminal;
			optionListView.setProps({ selectedIndex, focused: true, inputBuffer: "", inputCaret: 0 });
			pane.setProps({ notesVisible: false, selectedIndex, focused: true });
			return pane.render(width);
		},
	};
}

// #2700: inspect real Markdown/PreviewPane frames, not a generic ANSI-stripped oracle.
for (const [name, injected] of HOSTILE_CONTROLS) {
	test(`preview escapes ${name} in prose and fences across selection, resize and invalidation`, async () => {
		const question: QuestionData = {
			question: "Choose?",
			header: "Preview",
			options: [
				{ label: "Alpha", description: "First", preview: `**Polaris 雪**\n\n${injected}Tail\n\nReadable prose` },
				{
					label: "Beta",
					description: "Second",
					preview: `\`\`\`text\nPolaris 雪\n  ${injected}Tail\n  Readable code\n\`\`\``,
				},
			],
		};
		const before = structuredClone(question);
		const { pane, render } = makePane(question);
		const frames: { selectedIndex: number; terminal: number; width: number; invalidated: boolean; raw: string }[] =
			[];
		for (const invalidated of [false, true]) {
			if (invalidated) pane.invalidate();
			for (const [terminal, width] of [
				[140, 120],
				[80, 70],
				[140, 120],
			] as const) {
				for (const selectedIndex of [0, 1, 0]) {
					frames.push({
						selectedIndex,
						terminal,
						width,
						invalidated,
						raw: render(selectedIndex, terminal, width).join("\n"),
					});
				}
			}
		}
		const results: QuestionnaireResult[] = [];
		for (const selectedIndex of [0, 1]) {
			const params = { questions: [question] };
			const session = new QuestionnaireSession({
				tui: { terminal: { columns: 140 }, requestRender() {} },
				theme,
				params,
				itemsByTab: [buildItemsForQuestion(question)],
				done: (result) => results.push(result),
			});
			session.component.render(120);
			if (selectedIndex === 1) session.dispatch("\x1b[B");
			session.dispatch("\r");
			const result = results[selectedIndex];
			assert.ok(result);
			assert.equal(result.cancelled, false);
			assert.equal(result.answers[0]?.preview, question.options[selectedIndex]?.preview);
			assert.ok(
				buildQuestionnaireResponse(result, params).content[0]?.text.includes(
					question.options[selectedIndex]!.preview!,
				),
			);
		}
		assert.deepEqual(question, before);
		for (const frame of frames) {
			assert.ok(!frame.raw.includes(injected), `${name} raw control leakage: ${JSON.stringify(frame)}`);
			assert.ok(
				!frame.raw.includes("\x1b[38;2;1;2;3m"),
				"injected SGR must be absent before removing trusted styling",
			);
			// Only remove the exact framework marker and SGR after rejecting injected SGR above.
			const text = assertNoRawControls(frame.raw, {
				markers: [OVERLAY_ACTIVE_ROW_MARKER],
				allowSgr: true,
			});
			assert.ok(text.includes("Polaris 雪"));
			assert.ok(text.includes("Tail"));
			assert.ok(text.includes(frame.selectedIndex === 0 ? "Readable prose" : "Readable code"));
			assert.ok(!text.includes("**Polaris"));
			assert.ok(!text.includes("```"));
			assert.ok(frame.raw.split("\n").every((row) => visibleWidth(row) <= frame.width));
		}
	});
}
