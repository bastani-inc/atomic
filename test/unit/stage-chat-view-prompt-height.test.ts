import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import {
	createStore,
	deriveGraphTheme,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

const RUN_ID = "339e05a4-2289-408e-9076-d1a348f582ae";
const WORKFLOW_NAME = "budgeted-prompt";
const TERMINAL_COLUMNS = [30, 40, 60, 80, 100, 120] as const;
const PROMPTS: ReadonlyArray<{ label: string; prompt: PendingPrompt; hintText: string }> = [
	{
		label: "confirm",
		prompt: makePendingPrompt({ kind: "confirm", message: "Continue the workflow?" }),
		hintText: "y Yes",
	},
	{
		label: "select",
		prompt: makePendingPrompt({
			kind: "select",
			message: "Choose a release channel",
			choices: ["stable", "beta", "nightly", "canary", "manual"],
		}),
		hintText: "Choos",
	},
	{
		label: "custom",
		prompt: makePendingPrompt({ kind: "custom", message: "Provide a custom response" }),
		hintText: "enter",
	},
];

function assertRoundedBoxesClosed(lines: readonly string[], context: string): void {
	const openBoxes: Array<{ left: number; width: number }> = [];
	for (const line of lines) {
		for (let column = 0; column < line.length; column += 1) {
			if (line[column] === "╭") {
				const right = line.indexOf("╮", column + 1);
				assert.ok(right > column, `${context} has an incomplete top border`);
				openBoxes.push({ left: column, width: right - column });
			}
			if (line[column] === "╰") {
				const openBox = openBoxes.pop();
				const right = line.indexOf("╯", column + 1);
				assert.ok(openBox, `${context} closes a box before opening one`);
				assert.equal(column, openBox.left, `${context} shifts a box's bottom border`);
				assert.equal(right - column, openBox.width, `${context} changes a box's bottom width`);
			}
		}
	}
	assert.equal(openBoxes.length, 0, `${context} leaves a prompt box unclosed\n${lines.join("\n")}`);
}

test("attached-stage prompts keep complete boxes and answer hints across viewport sizes", () => {
	for (const { label, prompt, hintText } of PROMPTS) {
		for (const terminalColumns of TERMINAL_COLUMNS) {
			for (let viewportRows = 1; viewportRows <= 40; viewportRows += 1) {
				const store = createStore();
				setupRun(store, RUN_ID, "stage-a");
				assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", prompt), true);
				const { handle } = makeHandle();
				const view = new StageChatView({
					store,
					graphTheme: deriveGraphTheme({}),
					runId: RUN_ID,
					stageId: "stage-a",
					workflowName: WORKFLOW_NAME,
					handle,
					onDetach: () => {},
					onClose: () => {},
					piTui: {
						requestRender: () => {},
						terminal: { rows: viewportRows, columns: terminalColumns },
					} as never,
					piTheme: {},
					getViewportRows: () => viewportRows,
				});
				const renderWidth = Math.max(40, terminalColumns);
				const rendered = view.render(renderWidth);
				view.dispose();
				const plain = rendered.map(stripAnsi);
				const context = `${label} columns=${terminalColumns} viewportRows=${viewportRows}`;

				assertRoundedBoxesClosed(plain, context);
				if (plain.some((line) => line.includes("AWAITING INPUT"))) {
					assert.ok(
						plain.some((line) => line.includes(hintText)),
						`${context} drops the answer-hints row`,
					);
				}
				for (const line of rendered) {
					assert.ok(
						visibleWidth(line) <= renderWidth,
						`${context} exceeds width ${renderWidth}: ${stripAnsi(line)}`,
					);
				}
			}
		}
	}
});
