import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import type { TUI } from "@bastani/atomic-tui";
import { type Component, getKeybindings, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAskUserQuestionToolDefinition } from "../src/core/tools/ask-user-question/ask-user-question.ts";
import type { QuestionnaireResult, QuestionParams } from "../src/core/tools/ask-user-question/tool/types.ts";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.js";
import { AssistantMessageComponent, interruptedNotice } from "../src/modes/interactive/components/assistant-message.js";
import { keyHint, keyText } from "../src/modes/interactive/components/keybinding-hints.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripVTControlCharacters } from "./helpers/visible-text.js";

const previousKeys = getKeybindings();
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
});
afterEach(() => setKeybindings(previousKeys));

function context<TArgs extends Record<string, unknown>>(
	args: TArgs,
	expanded = false,
): ToolRenderContext<Record<string, never>, TArgs> {
	return {
		args,
		expanded,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/project",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyText,
		keyHint,
	};
}
function plain(component: Component, width: number): string[] {
	const rows = component.render(width);
	assert.ok(rows.every((row) => visibleWidth(row) <= width));
	assert.ok(rows.every((row) => !/\x1b\[(?:[\d;]*;)?48[;:]/u.test(row)));
	return rows.map(stripVTControlCharacters).map((row) => row.trimEnd());
}

test("the runtime notebook edit wrapper preserves canonical tool blocks (#5350)", () => {
	for (const path of ["src/sum.ts", "analysis.ipynb"]) {
		const definition = createToolDefinition("edit", "/project");
		const row = new ToolExecutionComponent(
			"edit",
			"wrapped-edit",
			{ path, edits: [{ oldText: "old", newText: "new" }] },
			{},
			definition,
			{ requestRender() {} } as TUI,
			"/project",
		);
		try {
			row.setArgsComplete();
			row.updateResult({ content: [], details: { diff: "-1 old\n+1 new" }, isError: false });
			for (const width of [80, 160]) {
				const rows = plain(row, width).filter(Boolean);
				assert.deepEqual(rows, [` ● Edit(${path})`, "   ⎿  +1 −1", "      -1  old", "      +1  new"]);
			}
		} finally {
			row.dispose();
		}
	}
});

test("codemode bounds its collapsed script without flattening it and shows all of it expanded (#5350)", () => {
	const code = [
		"const template = ```` value`;",
		...Array.from({ length: 18 }, (_, i) => `console.log("line ${i}");`),
	].join("\n");
	for (const width of [24, 80, 160]) {
		const ctx = context({ code });
		const call = codemodeRenderers.renderCall!({ code }, theme, ctx);
		const rows = plain(call, width);
		// The header row and 11 script rows under it, then the hint naming the 7 lines left.
		assert.equal(rows.length, 13);
		assert.match(rows[0], /^ ● codemode\(/u);
		assert.match(rows[12], /… \+7 lines \(ctrl\+e to expand\)|…$/u);
		assert.doesNotMatch(rows.join("\n"), /line 17/u);
		const expanded = codemodeRenderers.renderResult!(
			{ content: [], details: { calls: [] } },
			{ expanded: true, isPartial: false },
			theme,
			{ ...ctx, expanded: true },
		);
		const body = plain(expanded, width).join("\n");
		assert.match(body, /line\s+17/u);
		assert.match(body, /````/u);
		assert.doesNotMatch(body, /Took|Elapsed/u);
	}
});

test("question answers replace the call with canonical safe records and cancellation (#5350)", () => {
	const params: QuestionParams = {
		questions: [
			{ header: "Nav\x1b[2Jigation", question: "Where?", options: [] },
			{ header: "Pack\u202eaging", question: "How?", options: [] },
		],
	};
	const answers: QuestionnaireResult = {
		cancelled: false,
		answers: [
			{
				questionIndex: 0,
				question: "Where?",
				kind: "option",
				answer: "Build it as shown\x1b]8;;https://bad\x07\x1b]8;;\x07",
			},
			{ questionIndex: 1, question: "How?", kind: "custom", answer: "npm\npackage\u2066" },
		],
	};
	for (const width of [24, 80, 160]) {
		const definition = createAskUserQuestionToolDefinition();
		const row = new ToolExecutionComponent(
			"ask_user_question",
			"questions",
			params,
			{},
			definition,
			{ requestRender: () => {} } as TUI,
			"/project",
		);
		row.updateResult(
			{ content: [{ type: "text", text: "model envelope unchanged" }], details: answers, isError: false },
			false,
		);
		const rows = plain(row, width).filter(Boolean);
		assert.equal(rows.length >= 2, true);
		assert.match(rows[0], /^ ● Navigation →/u);
		const full = plain(row, 160).join("\n");
		assert.match(full, /\n {3}⎿ {2}Pack<U\+202E>aging → "npm package<U\+2066>"/u);
		assert.doesNotMatch(full, /Questions ·|model envelope|https:\/\/bad|\u202e|\u2066/u);
		row.updateResult({ content: [], details: { answers: [], cancelled: true }, isError: false }, false);
		assert.deepEqual(plain(row, width).filter(Boolean), [" ◼ Questions cancelled"]);
		row.dispose();
	}
});

test("interrupted responses render one aligned stopped notice with retained activity (#5350)", () => {
	for (const width of [24, 80, 160]) {
		for (const outputPad of [0, 1, 3]) {
			for (const content of [[], [fauxToolCall("bash", { command: "sleep 40" })]]) {
				const message = fauxAssistantMessage(content, {
					stopReason: "aborted",
					errorMessage: "Request was aborted",
				});
				const row = new AssistantMessageComponent(message, false, undefined, "Thinking...", outputPad);
				const rows = plain(row, width).filter(Boolean);
				assert.equal(rows.length, 1);
				assert.match(rows[0], new RegExp(`^${" ".repeat(outputPad)}◼ Interrupted(?: · (?:bash|response))?$`, "u"));
				if (content.length) assert.match(rows[0], / · bash$/u);
				else if (width >= 28) assert.match(rows[0], / · response$/u);
				row.updateContent(message);
				assert.equal(plain(row, width).filter((line) => line.includes("◼")).length, 1);
			}
		}
	}
	const row = new AssistantMessageComponent(
		fauxAssistantMessage([], {
			stopReason: "aborted",
			errorMessage: "Question \x1b[2Jdismissed\u202e\n    at private/file.ts:42",
		}),
	);
	const text = plain(row, 160).join("\n");
	assert.match(text, /◼ Interrupted · Question dismissed<U\+202E>/u);
	assert.doesNotMatch(text, /private\/file|\u202e|Interrupted by user/u);
	assert.equal(interruptedNotice("Request was aborted"), "Interrupted by user");
});

test("codemode nested blocks preserve available parameters, failures and model costs (#5350)", () => {
	const args = JSON.stringify({ path: "src/file.ts", extra: "retained-parameter-".repeat(15), template: "````" });
	const calls = Array.from({ length: 10 }, (_, i) => ({
		id: `nested-${i}`,
		name: "read",
		args,
		status: "ok" as const,
	}));
	const details = {
		calls: [
			...calls,
			{ id: "failed", name: "read", args, status: "error" as const, error: "failure\x1b[2J\u202e\nmore detail" },
			{ id: "model", name: "models.classify", args: "judge", status: "ok" as const, cost: 0.02 },
			{ id: "cancelled", name: "read", args: '{"path":"cancelled"}', status: "cancelled" as const },
			{ id: "running", name: "read", args: '{"path":"running"}', status: "running" as const, cost: 0 },
		],
	};
	const content = [
		{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text" as const, text: "retained output" },
	];
	for (const width of [24, 80, 160]) {
		const render = (expanded: boolean) =>
			codemodeRenderers.renderResult!(
				{ content, details },
				{ expanded, isPartial: false },
				theme,
				context({ code: "console.log(````);" }, expanded),
			);
		const collapsed = plain(render(false), width).join("\n");
		assert.ok(collapsed.includes("✗ Read("));
		assert.ok(collapsed.includes("◼ Read("));
		assert.ok(collapsed.includes("∀ Read("));
		const expanded = plain(render(true), width).join("\n");
		assert.equal(expanded.match(/● Read\(/gu)?.length, 10);
		assert.match(expanded, /````/u);
		const unwrapped = expanded
			.split("\n")
			.map((line) => line.replace(/^\s*(?:⎿\s*)?/u, ""))
			.join("");
		assert.equal(unwrapped.match(/retained-parameter-/gu)?.length, 165);
		assert.equal(unwrapped.match(/"template":"````"/gu)?.length, 11);
		assert.match(expanded, /failure[\s\S]*more detail/u);
		assert.doesNotMatch(expanded, /missing result|no result|Took|Elapsed|\u202e/u);
		assert.equal(JSON.stringify({ content, details }).includes("\\u001b[2J"), true);
	}
	const full = plain(
		codemodeRenderers.renderResult!(
			{ content, details },
			{ expanded: true, isPartial: false },
			theme,
			context({ code: "return 1;" }, true),
		),
		160,
	).join("\n");
	assert.match(full, /\$0\.02/u);
	assert.match(full, /\$0\.0/u);
	assert.match(full, /Model calls: \$0\.02/u);
	const collapsed = plain(
		codemodeRenderers.renderResult!(
			{ content, details },
			{ expanded: false, isPartial: false },
			theme,
			context({ code: "return 1;" }),
		),
		160,
	).join("\n");
	assert.match(collapsed, /… \+6 earlier calls \(ctrl\+e to expand\)/u);
	assert.doesNotMatch(collapsed, /ctrl\+o|✓ read/u);
});

test("codemode bounds collapsed failures and omits disabled expansion hints (#5350)", () => {
	setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
	const error = Array.from({ length: 30 }, (_, i) => `error line ${i}`).join("\n");
	const details = {
		calls: [{ id: "failed", name: "read", args: '{"path":"file"}', status: "error" as const, error }],
	};
	for (const width of [24, 80, 160]) {
		const render = (expanded: boolean) =>
			plain(
				codemodeRenderers.renderResult!(
					{ content: [], details },
					{ expanded, isPartial: false },
					theme,
					context({ code: "" }, expanded),
				),
				width,
			);
		const collapsed = render(false);
		assert.ok(collapsed.length <= 8, `collapsed errors must stay bounded: ${collapsed.length}`);
		assert.doesNotMatch(collapsed.join("\n"), /to expand|ctrl\+/u);
		assert.match(render(true).join("\n"), /error line 29/u);
	}
	const calls = Array.from({ length: 10 }, (_, i) => ({
		id: `${i}`,
		name: "read",
		args: '{"path":"file"}',
		status: "ok" as const,
	}));
	const output = codemodeRenderers.renderResult!(
		{ content: [{ type: "text", text: error }], details: { calls } },
		{ expanded: false, isPartial: false },
		theme,
		context({ code: "" }),
	);
	assert.doesNotMatch(plain(output, 160).join("\n"), /to expand|ctrl\+/u);
});
