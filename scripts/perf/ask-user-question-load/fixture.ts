import type { QuestionParams } from "../../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const SPACE = " ";
const BACKSPACE = "\x7f";

function codePreview(lines: number): string {
	const body = Array.from(
		{ length: lines },
		(_, i) => `const value${i} = compute(${i}, "a fairly long argument string for row ${i}");`,
	);
	return ["```ts", ...body, "```"].join("\n");
}

function bulletPreview(lines: number): string {
	return Array.from(
		{ length: lines },
		(_, i) =>
			`- **Point ${i}**: a sentence long enough to wrap in a narrow preview column and exercise the markdown wrapper.`,
	).join("\n");
}

/** The issue's reproduction: four questions, two with previews, one multi-select, one plain. */
export function benchmarkQuestionnaire(): QuestionParams {
	return {
		questions: [
			{
				question: "Which architecture should the service use?",
				header: "Arch",
				options: [
					{ label: "Monolith", description: "One deployable unit with shared state", preview: codePreview(14) },
					{ label: "Services", description: "Split by domain with queues", preview: bulletPreview(10) },
					{ label: "Serverless", description: "Functions per route", preview: codePreview(8) },
					{ label: "Hybrid", description: "A mix of the above", preview: bulletPreview(6) },
				],
			},
			{
				question: "Which navigation layout?",
				header: "Layout",
				options: [
					{ label: "Tabs", description: "Tabbed navigation", preview: bulletPreview(12) },
					{ label: "Sidebar", description: "Persistent sidebar", preview: codePreview(12) },
					{ label: "Wizard", description: "Step by step", preview: bulletPreview(4) },
				],
			},
			{
				question: "Which features should ship first?",
				header: "Features",
				multiSelect: true,
				options: Array.from({ length: 4 }, (_, i) => ({
					label: `Feature ${i}`,
					description: `Feature ${i} has a description long enough to wrap onto a second line in a narrow terminal.`,
				})),
			},
			{
				question: "Anything else?",
				header: "Else",
				options: Array.from({ length: 4 }, (_, i) => ({ label: `Option ${i}`, description: `Plain option ${i}` })),
			},
		],
	};
}

/**
 * One loop through every interaction the issue names: arrow navigation on both preview tabs, a multi-select
 * toggle, typing a custom answer, and tab switches. It returns the dialog to its starting state, so it can repeat
 * for as long as a run needs keystrokes, and every key in it changes the dialog's frame.
 */
export const KEY_CYCLE: readonly string[] = [
	DOWN,
	DOWN,
	UP,
	UP,
	TAB,
	DOWN,
	UP,
	TAB,
	DOWN,
	SPACE,
	SPACE,
	UP,
	TAB,
	DOWN,
	DOWN,
	DOWN,
	DOWN,
	"a",
	"b",
	"c",
	BACKSPACE,
	BACKSPACE,
	BACKSPACE,
	UP,
	UP,
	UP,
	UP,
	SHIFT_TAB,
	SHIFT_TAB,
	SHIFT_TAB,
];
