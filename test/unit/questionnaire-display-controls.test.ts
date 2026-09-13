import assert from "node:assert/strict";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { OVERLAY_ACTIVE_ROW_MARKER } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.js";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { validateQuestionnaire } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/validate-questionnaire.js";
import { WrappingSelect } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.js";
import { getThemeByName, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

const injectedSgr = "\x1b[38;2;1;2;3m";
const payload = `Polaris 雪\x1b]0;PR2700\x07\x1b[2J\x9b2J\x00\x7f\x85${injectedSgr}Tail\nReadable`;

// #2700: attached questionnaire display must not execute supplied terminal controls.
for (const multiSelect of [false, true]) {
	for (const field of ["question", "label", "description"] as const) {
		test(`questionnaire safely displays ${field}, multiSelect=${multiSelect}, retaining raw answers`, async () => {
			initTheme("dark");
			const params: QuestionParams = {
				questions: [
					{
						question: field === "question" ? payload : "Choose first?",
						header: "First",
						multiSelect,
						options: [
							{
								label: field === "label" ? payload : "Alpha",
								description: field === "description" ? payload : "First choice",
							},
							{ label: "Beta", description: "Second choice" },
						],
					},
					{
						question: "Choose second?",
						header: "Second",
						options: [
							{ label: "Gamma", description: "Third choice" },
							{ label: "Delta", description: "Fourth choice" },
						],
					},
				],
			};
			assert.equal(validateQuestionnaire(params).ok, true);
			const before = structuredClone(params);
			const results: QuestionnaireResult[] = [];
			const session = new QuestionnaireSession({
				tui: { terminal: { columns: 160 }, requestRender() {} },
				theme: getThemeByName("dark")!,
				params,
				itemsByTab: params.questions.map(buildItemsForQuestion),
				done: (result) => results.push(result),
			});
			const frames: { where: string; width: number; raw: string }[] = [];
			const capture = (where: string) => {
				for (const width of [40, 100, 160])
					frames.push({ where, width, raw: session.component.render(width).join("\n") });
			};
			capture("active");
			if (multiSelect) {
				session.dispatch(" ");
				session.dispatch("\x1b[B");
				session.dispatch("\x1b[B");
			}
			session.dispatch("\r");
			capture("second");
			session.dispatch("\r");
			capture("review");
			session.dispatch("\r");
			assert.equal(results.length, 1);
			assert.equal(results[0]!.cancelled, false);
			assert.equal(results[0]!.answers[0]!.question, params.questions[0]!.question);
			assert.deepEqual(
				multiSelect ? results[0]!.answers[0]!.selected : results[0]!.answers[0]!.answer,
				multiSelect ? [params.questions[0]!.options[0]!.label] : params.questions[0]!.options[0]!.label,
			);
			assert.equal(results[0]!.answers[1]!.answer, "Gamma");
			assert.deepEqual(params, before);
			assert.ok(frames.find((frame) => frame.where === "active" && frame.width === 160)!.raw.includes("Polaris 雪"));
			for (const frame of frames) {
				assert.ok(!frame.raw.includes(injectedSgr), `${frame.where}@${frame.width}: injected SGR`);
				// Remove only trusted framework markers and styling, never general OSC/CSI.
				const text = frame.raw
					.replaceAll(CURSOR_MARKER, "")
					.replaceAll(OVERLAY_ACTIVE_ROW_MARKER, "")
					.replace(/\x1b\[[0-9;]*m/g, "");
				assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, `${frame.where}@${frame.width}`);
			}
		});
	}
}

test("inline questionnaire editing escapes controls on both sides of the raw caret", () => {
	const select = new WrappingSelect([{ kind: "other", label: "Type something." }], 1, {
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
	});
	select.setInputBuffer("雪\x00\x1bZ\nTail");
	select.setInputCursor(2);
	for (const width of [40, 100, 160]) {
		const rendered = select.render(width).join("\n").replaceAll(OVERLAY_ACTIVE_ROW_MARKER, "");
		assert.ok(rendered.includes("雪\\x00\x1b[7m\\x1b\x1b[0mZ"));
		assert.ok(rendered.includes("Tail"));
		assert.doesNotMatch(rendered.replace(/\x1b\[[0-9;]*m/g, ""), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	}
});
