import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import {
	createStore,
	deriveGraphTheme,
	FakePromptEditor,
	makeFakeKeybindings,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

const RUN_ID = "339e05a4-2289-408e-9076-d1a348f582ae";
const WORKFLOW_NAME = "budgeted-prompt";
const TERMINAL_COLUMNS = [30, 40, 60, 80, 100, 120] as const;
const REACHABILITY_COLUMNS = [40, 72, 100] as const;
const ORIGIN_MAIN_PROMPT_SURFACE_VIEWPORT_FLOOR = 3;
const QUESTION_MARKERS = Array.from(
	{ length: 12 },
	(_, index) => `QUESTION-MARKER-${String(index + 1).padStart(2, "0")}`,
);
const LONG_QUESTION = QUESTION_MARKERS.map((marker) => `${marker} review detail`).join("\n");
const PROMPTS: ReadonlyArray<{ label: string; prompt: PendingPrompt; hintText: string }> = [
	{
		label: "input",
		prompt: makePendingPrompt({ kind: "input", message: "Enter a release label" }),
		hintText: "Submit",
	},
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
		label: "editor",
		prompt: makePendingPrompt({ kind: "editor", message: "Explain the release decision", initial: "draft" }),
		hintText: "Submit",
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

function makePromptView(
	prompt: PendingPrompt,
	terminalColumns: number,
	viewportRows: number,
	usePrimitiveEditor: boolean,
): StageChatView {
	const store = createStore();
	setupRun(store, RUN_ID, "stage-a");
	assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", prompt), true);
	const { handle } = makeHandle();
	return new StageChatView({
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
		...(usePrimitiveEditor
			? { piKeybindings: makeFakeKeybindings(), piEditorFactory: () => new FakePromptEditor() }
			: {}),
		getViewportRows: () => viewportRows,
	});
}

function promptIdentityBanner(plain: readonly string[]): string[] {
	const bannerStart = plain.findIndex((line) => /^╭ AWAITING INPUT ─*╮$/.test(line));
	if (bannerStart < 0) return [];
	const bannerEnd = plain.findIndex((line, index) => index > bannerStart && /^╰─+╯$/.test(line));
	return bannerEnd < 0 ? [] : plain.slice(bannerStart, bannerEnd + 1);
}

test("makes every long prompt question row reachable without blank windows", () => {
	for (const kind of ["input", "confirm", "select", "editor", "custom"] as const) {
		for (const terminalColumns of REACHABILITY_COLUMNS) {
			for (let viewportRows = 8; viewportRows <= 40; viewportRows += 1) {
				const prompt = makePendingPrompt({
					kind,
					message: LONG_QUESTION,
					choices: kind === "select" ? ["stable", "beta", "nightly"] : undefined,
					initial: kind === "editor" ? "draft" : undefined,
				});
				const view = makePromptView(prompt, terminalColumns, viewportRows, kind === "input" || kind === "editor");
				const seen = new Set<string>();
				let previousRender: string | undefined;
				const context = `${kind} columns=${terminalColumns} viewportRows=${viewportRows}`;

				for (let scroll = 0; scroll <= QUESTION_MARKERS.length + 4; scroll += 1) {
					const plain = view.render(Math.max(40, terminalColumns)).map(stripAnsi);
					const rendered = plain.join("\n");
					assertRoundedBoxesClosed(plain, `${context} scroll=${scroll}`);
					const visibleMarkers = QUESTION_MARKERS.filter((marker) => rendered.includes(marker));
					assert.ok(visibleMarkers.length > 0, `${context} scroll=${scroll} renders a blank question window`);
					for (const marker of visibleMarkers) seen.add(marker);
					if (rendered === previousRender) break;
					previousRender = rendered;
					assert.equal(view.handleInput("\x1b[<65;1;1M"), true);
				}

				view.dispose();
				assert.deepEqual([...seen].sort(), QUESTION_MARKERS, `${context} leaves question rows unreachable`);
			}
		}
	}
});

test("reaches the last long confirm question row at several heights including the one-row banner floor", () => {
	for (const viewportRows of [12, 16, 20, 22, 23]) {
		const prompt = makePendingPrompt({ kind: "confirm", message: LONG_QUESTION });
		const view = makePromptView(prompt, 80, viewportRows, false);
		const initial = view.render(80).map(stripAnsi);
		const banner = promptIdentityBanner(initial);
		const context = `confirm columns=80 viewportRows=${viewportRows}`;

		if (viewportRows === 23) {
			assert.ok(banner.join("\n").includes(RUN_ID), `${context} must retain the complete run id`);
			assert.doesNotMatch(banner.join("\n"), new RegExp(WORKFLOW_NAME));
			assert.equal(banner.length, 3, `${context} must use the one-row identity rung`);
		}
		if (viewportRows === 22) assert.doesNotMatch(initial.join("\n"), new RegExp(RUN_ID));

		assert.equal(view.handleInput("end"), true);
		const bottom = view.render(80).map(stripAnsi);
		view.dispose();
		assertRoundedBoxesClosed(bottom, context);
		assert.ok(bottom.join("\n").includes(QUESTION_MARKERS.at(-1)!), `${context} cannot reach the last question row`);
	}
});

test("matches origin/main's prompt surface floor across kinds, widths, and viewport heights", () => {
	for (const { label, prompt } of PROMPTS) {
		for (const terminalColumns of TERMINAL_COLUMNS) {
			for (let viewportRows = 1; viewportRows <= 40; viewportRows += 1) {
				const view = makePromptView(prompt, terminalColumns, viewportRows, false);
				const rendered = view.render(Math.max(40, terminalColumns)).map(stripAnsi).join("\n");
				view.dispose();
				if (viewportRows >= ORIGIN_MAIN_PROMPT_SURFACE_VIEWPORT_FLOOR) {
					assert.match(
						rendered,
						/AWAITING INPUT/,
						`${label} columns=${terminalColumns} viewportRows=${viewportRows} drops the prompt surface`,
					);
				}
			}
		}
	}
});

test("attached-stage prompts keep complete boxes and answer hints across viewport sizes", () => {
	for (const { label, prompt, hintText } of PROMPTS.filter(({ label }) => !["input", "editor"].includes(label))) {
		for (const terminalColumns of TERMINAL_COLUMNS) {
			for (let viewportRows = 1; viewportRows <= 40; viewportRows += 1) {
				const view = makePromptView(prompt, terminalColumns, viewportRows, false);
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
