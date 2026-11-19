import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { type Component, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import { codemodeRenderers, WIDE_CHARACTER_PLACEHOLDER } from "../src/extensions/codemode/renderer.js";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.js";
import { keyHint, keyText } from "../src/modes/interactive/components/keybinding-hints.js";
import { ToolBlock } from "../src/modes/interactive/components/tool-block.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { CodeHighlighter, initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { TerminalTextSanitizer } from "../src/utils/terminal-text.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());
function context(expanded: boolean): ToolRenderContext {
	return {
		args: { code: "" },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		keyText,
		keyHint,
	};
}
const tui = { requestRender: () => {} } as unknown as TUI;
const SCRIPT_COMPLETED = { type: "text" as const, text: "Script completed\nWall time 1.0 seconds\nOutput:\n" };

interface BlockOptions {
	readonly width?: number;
	readonly expanded?: boolean;
	/** The model is still writing the script: no execution, no result. */
	readonly streaming?: boolean;
	readonly output?: string;
	readonly calls?: CodemodeToolDetails["calls"];
}

/** A codemode call as the chat draws it: raw rows with their colours, and the same rows as plain text. */
function codemodeBlock(args: Record<string, unknown>, options: BlockOptions = {}): { raw: string[]; plain: string[] } {
	const component = new ToolExecutionComponent("codemode", "call", args, {}, codemodeRenderers, tui, "/");
	if (!options.streaming) {
		component.setArgsComplete();
		component.markExecutionStarted();
		const content = [SCRIPT_COMPLETED, ...(options.output ? [{ type: "text" as const, text: options.output }] : [])];
		component.updateResult({ content, details: { calls: options.calls ?? [] }, isError: false, durationMs: 1_000 });
	}
	component.setExpanded(options.expanded ?? false);
	const raw = component.render(options.width ?? 120);
	component.dispose();
	return { raw, plain: raw.map((line) => stripVTControlCharacters(line).trimEnd()) };
}

const LONG_SCRIPT = Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`).join("\n");

function render(result: AgentToolResult<CodemodeToolDetails | undefined>, expanded = true, width = 200): string {
	const component = codemodeRenderers.renderResult?.(
		result,
		{ expanded, isPartial: false },
		theme,
		context(expanded),
	) as Component;
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

test("codemode renderer hides the script header and shows the output", () => {
	assert.equal(
		render({
			content: [
				{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text", text: "hello" },
			],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		}),
		'⎿  ● Read(a)\n       ⎿  {"path":"a"}\n  ⎿  hello',
	);
});

test("codemode renderer shows model call costs and their total", () => {
	const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
	assert.equal(
		render({
			content: [],
			details: {
				calls: [
					{ ...call, id: "1", cost: 0.000012936 },
					{ ...call, id: "2", cost: 0.02 },
					{ ...call, id: "3" },
				],
			},
		}),
		[
			"⎿  ● models.classify(scorer/judge) · $0.000013",
			"       ⎿  scorer/judge",
			"",
			"     ● models.classify(scorer/judge) · $0.02",
			"       ⎿  scorer/judge",
			"",
			"     ● models.classify(scorer/judge)",
			"       ⎿  scorer/judge",
			"  ⎿  Model calls: $0.02",
		].join("\n"),
	);
});

test("codemode renderer shows rejected options without a script header", () => {
	assert.equal(
		render({
			content: [{ type: "text", text: "The @options line must be followed by JavaScript source" }],
			details: undefined,
		}),
		"⎿  The @options line must be followed by JavaScript source",
	);
});

test("codemode collapsed output is limited by wrapped lines and keeps the full output path", () => {
	const result = {
		content: [
			{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text" as const, text: "x".repeat(1000) },
		],
		details: { calls: [], fullOutputPath: "/tmp/out.txt" },
	};
	const lines = render(result, false, 50).split("\n");
	assert.equal(lines.length, 7);
	assert.deepEqual(lines.slice(0, 5), [`⎿  ${"x".repeat(45)}`, ...Array(4).fill(`     ${"x".repeat(45)}`)]);
	assert.match(lines[5], /^ {5}… \+18 lines/);
	assert.equal(lines[6], "  ⎿  Full output: /tmp/out.txt");
	assert.equal(render(result, true, 50).split("\n").length, 24);
	assert.equal(render(result, true, 50).split("\n").slice(0, -1).join("").match(/x/g)?.length, 1000);
});

test("codemode collapsed script call stays on one bounded header row (#5350)", () => {
	const component = codemodeRenderers.renderCall?.({ code: "x".repeat(1000) }, theme, context(false)) as Component;
	const lines = component.render(50).map(stripVTControlCharacters);
	assert.deepEqual(lines, [`codemode(${"x".repeat(39)}…)`]);
});

test("codemode keeps blank lines, tabs and trailing spaces in the argument so error lines match (#5525)", () => {
	const code = '\n// @options: {"timeout_ms":1000}\n\treturn "a\tb";  \n\n';
	for (const expanded of [false, true]) {
		const { raw } = codemodeBlock({ code }, { expanded });
		assert.deepEqual(raw.slice(2, -1).map(stripVTControlCharacters), [
			"     ",
			'     // @options: {"timeout_ms":1000}',
			'        return "a   b";  ',
			"     ",
			"     ",
		]);
	}
});

test("folded source does not expose a control string crossing a line break or clipped column (#5525)", () => {
	for (const prefix of ["/*", `/*${"x".repeat(500)}`]) {
		const code = `${prefix}\x1b]example\r\nNOT_DISPLAY_TEXT\x07*/\nreturn 2;`;
		for (const expanded of [false, true]) {
			const text = codemodeBlock({ code }, { expanded, width: 58 }).plain.join("\n");
			assert.doesNotMatch(text, /NOT_DISPLAY_TEXT|unterminated control/);
			assert.match(text, /return 2;/);
		}
	}
});

test("folded source measures a visible combining cluster in linear work (#5525)", () => {
	const marks = "\u0301".repeat(4_096);
	const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
	try {
		const frame = codemodeBlock({ code: `// preview\n// x${marks} end` }, { width: 28 });
		assert.ok(frame.plain.some((row) => row.includes(`x${marks} end`)));
		const measured = segment.mock.calls.reduce(
			(sum, [text]) => sum + (text?.includes("\u0301") ? text.length : 0),
			0,
		);
		assert.ok(measured < 32 * marks.length, `${measured} units segmented`);
	} finally {
		segment.mockRestore();
	}
});

test("codemode displays CRLF and bare CR as source line breaks, not cursor motion (#5525)", () => {
	const { plain } = codemodeBlock({ code: "\r\nconst first = 1;\rreturn first;" }, { expanded: true });
	assert.deepEqual(plain.slice(1), [" ● codemode(", "", "     const first = 1;", "     return first;", "   ) · 1s"]);
});

test("codemode call shows a one-line script inline as highlighted code", () => {
	const { raw, plain } = codemodeBlock({ code: "return 1 + 1;" }, { output: "2" });
	assert.deepEqual(plain, ["", " ● codemode(return 1 + 1;) · 1s", "   ⎿  2"]);
	assert.ok(raw[1]?.includes(theme.fg("syntaxKeyword", "return")), raw[1]);
});

test("codemode call shows a multi-line script indented under codemode( and closes it with ) and the time", () => {
	const { raw, plain } = codemodeBlock({ code: "const a = 1;\nconst b = 2;\nreturn a + b;\n" }, { output: "3" });
	assert.deepEqual(plain, [
		"",
		" ● codemode(",
		"     const a = 1;",
		"     const b = 2;",
		"     return a + b;",
		"",
		"   ) · 1s",
		"   ⎿  3",
	]);
	assert.ok(raw[2]?.includes(theme.fg("syntaxKeyword", "const")), raw[2]);
});

test("codemode call collapses a long script to its first lines with the expand hint, and Ctrl+O shows all of it", () => {
	const collapsed = codemodeBlock({ code: LONG_SCRIPT }, { output: "done" }).plain;
	assert.deepEqual(collapsed.slice(0, 3), ["", " ● codemode(", "     const v0 = 0;"]);
	assert.equal(collapsed[11], "     const v9 = 9;");
	assert.match(collapsed[12] ?? "", /^ {5}… \+10 lines/);
	assert.deepEqual(collapsed.slice(13), ["   ) · 1s", "   ⎿  done"]);

	const expanded = codemodeBlock({ code: LONG_SCRIPT }, { output: "done", expanded: true }).plain;
	assert.deepEqual(expanded.slice(0, 2), ["", " ● codemode("]);
	assert.deepEqual(
		expanded.slice(2, 22),
		LONG_SCRIPT.split("\n").map((line) => `     ${line}`),
	);
	assert.deepEqual(expanded.slice(22), ["   ) · 1s", "   ⎿  done"]);
});

test("a folded codemode call highlights only the ten lines it displays (#5525)", () => {
	const highlight = vi.spyOn(CodeHighlighter.prototype, "highlight");
	try {
		const code = Array.from({ length: 5_000 }, (_, i) => `const line${i} = ${i};`).join("\n");
		const { plain } = codemodeBlock({ code });
		assert.match(plain.join("\n"), /… \+4990 lines/);
		const inputs = highlight.mock.calls.map(([source]) => source);
		assert.ok(inputs.some((source) => source.includes("const line9 = 9;")));
		assert.ok(
			inputs.every((source) => !source.includes("const line10 = 10;")),
			"highlighted hidden code",
		);
	} finally {
		highlight.mockRestore();
	}
});

test("a custom call title still reveals the source in the default expanded result (#5525)", () => {
	const component = new ToolExecutionComponent(
		"codemode",
		"call",
		{ code: "return 1 + 1;" },
		{},
		{
			...codemodeRenderers,
			renderCall: () => ({ invalidate() {}, render: () => ["My script call"] }),
		},
		tui,
		"/",
	);
	try {
		component.updateResult({ content: [{ type: "text", text: "2" }], isError: false });
		component.setExpanded(true);
		assert.deepEqual(
			component.render(98).map((row) => stripVTControlCharacters(row).trimEnd()),
			["", " ● My script call", "   ⎿  return 1 + 1;", "   ⎿  2"],
		);
	} finally {
		component.dispose();
	}
});

test("a folded codemode title prepares only its displayed rows and columns (#5525)", () => {
	const hidden = "invisible\t".repeat(10_000);
	const wide = `return [${Array.from({ length: 5_000 }, (_, i) => i).join(",")}];`;
	const sanitize = vi.spyOn(TerminalTextSanitizer.prototype, "write");
	const highlight = vi.spyOn(CodeHighlighter.prototype, "highlight");
	try {
		const single = codemodeBlock({ code: wide }, { width: 98 });
		const multi = codemodeBlock({ code: `${wide}\n${"const value = 1;\n".repeat(9)}//${hidden}` }, { width: 98 });
		assert.match(single.plain[1], /return \[0,1,2,.*…\) · 1s$/);
		assert.match(multi.plain.join("\n"), /… \+1 line/);
		assert.ok(
			sanitize.mock.calls.every(([text]) => text.length < 1_000),
			"normalized offscreen source",
		);
		assert.ok(
			highlight.mock.calls.every(([text]) => text.length < 1_000),
			"highlighted offscreen source",
		);
	} finally {
		sanitize.mockRestore();
		highlight.mockRestore();
	}
});

test("elapsed time keeps its place on a narrow folded codemode title (#5525)", () => {
	const narrowBlock = codemodeBlock({ code: "a\nb" }, { width: 15 }).plain.join("\n");
	assert.doesNotMatch(narrowBlock, / · 1s/);
	for (const code of ["return 2;", null, 42]) {
		assert.match(codemodeBlock({ code }, { width: 17 }).plain[1], /● codemode… · 1s$/);
		assert.doesNotMatch(codemodeBlock({ code }, { width: 15 }).plain[1], / · 1s/);
	}
});

test("an elapsed tick leaves an expanded inline script under the same mouse cells (#5525)", () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const code = 'await tools.bash({command:"sleep 3"})';
	const component = new ToolExecutionComponent("codemode", "call", { code }, {}, codemodeRenderers, tui, "/");
	try {
		component.markExecutionStarted();
		component.setExpanded(true);
		component.updateResult(
			{
				content: [],
				details: {
					calls: [{ id: "inner", name: "bash", args: '{"command":"sleep 3"}', status: "running", durationMs: 0 }],
				},
				isError: false,
			},
			true,
		);
		const before = component.render(50).map(stripVTControlCharacters);
		const first = before[1];
		assert.ok(first.includes(code));
		vi.advanceTimersByTime(1_001);
		const rows = component.render(50).map(stripVTControlCharacters);
		assert.equal(rows[1].slice(12, 17), "await");
		assert.equal(
			rows.findIndex((row) => row.includes("Bash(sleep 3)")),
			before.findIndex((row) => row.includes("Bash(sleep 3)")),
		);
		assert.match(rows.join("\n"), / · 1s/);
	} finally {
		component.dispose();
	}
});

test("unchanged codemode layouts survive redraws and toggles, not argument or width changes (#5525)", () => {
	const component = new ToolExecutionComponent(
		"codemode",
		"call",
		{ code: LONG_SCRIPT },
		{},
		codemodeRenderers,
		tui,
		"/",
	);
	const highlight = vi.spyOn(CodeHighlighter.prototype, "highlight");
	try {
		component.updateResult({ content: [], isError: false });
		const folded = component.render(98);
		component.setExpanded(true);
		const open = component.render(98);
		highlight.mockClear();
		assert.deepEqual(component.render(98), open);
		component.setExpanded(false);
		assert.deepEqual(component.render(98), folded);
		component.setExpanded(true);
		assert.deepEqual(component.render(98), open);
		assert.equal(highlight.mock.calls.length, 0, "repainted an unchanged script");
		assert.notDeepEqual(component.render(12), open);
		component.updateArgs({ code: "return 2;" });
		assert.match(stripVTControlCharacters(component.render(98).join("\n")), /codemode\(return 2;\)/);
	} finally {
		highlight.mockRestore();
		component.dispose();
	}
});

test("a stock codemode title leaves a custom result's renderer state alone (#5525)", () => {
	const component = new ToolExecutionComponent(
		"codemode",
		"call",
		{ code: "return 2;" },
		{},
		{
			...codemodeRenderers,
			renderResult: (_r, _o, _t, ctx) => {
				const state = ctx.state as { scriptHighlighter?: (value: string) => string };
				assert.deepEqual(Reflect.ownKeys(state), []);
				state.scriptHighlighter ??= (value) => `Custom: ${value}`;
				const text = state.scriptHighlighter("2");
				return { invalidate() {}, render: () => [text] };
			},
		},
		tui,
		"/",
	);
	try {
		component.updateResult({ content: [], isError: false });
		assert.match(stripVTControlCharacters(component.render(98).join("\n")), /⎿ {2}Custom: 2/);
	} finally {
		component.dispose();
	}
});

test("plain codemode titles do not request discarded syntax colors (#5525)", () => {
	vi.stubEnv("NO_COLOR", "1");
	const highlight = vi.spyOn(CodeHighlighter.prototype, "highlight");
	try {
		assert.equal(codemodeBlock({ code: "return 2;" }).plain[1], " ● codemode(return 2;) · 1s");
		assert.equal(highlight.mock.calls.length, 0);
	} finally {
		highlight.mockRestore();
		vi.unstubAllEnvs();
	}
});

test("an older renderer context needs no new members to show the script and result (#5525)", () => {
	const args = { code: 'return "kept"' };
	const ctx = new Proxy(
		{ ...context(true), args },
		{
			get(target, field, receiver) {
				if (!Object.hasOwn(target, field)) throw new Error("unsupported renderer context member");
				return Reflect.get(target, field, receiver);
			},
			has() {
				throw new Error("opaque context");
			},
		},
	);
	const call = codemodeRenderers.renderCall!(args, theme, ctx);
	const result = codemodeRenderers.renderResult!(
		{ content: [{ type: "text", text: "SCRIPT RESULT" }], details: { calls: [] } },
		{ expanded: true, isPartial: false },
		theme,
		ctx,
	);
	assert.deepEqual(call.render(98).map(stripVTControlCharacters), ['codemode(return "kept")']);
	assert.deepEqual(
		result.render(98).map((row) => stripVTControlCharacters(row).trimEnd()),
		['  ⎿  return "kept"', "  ⎿  SCRIPT RESULT"],
	);
});

test("a call that never paints does not enumerate its script rows (#5525)", () => {
	const code = ";\n".repeat(5000);
	const exec = vi.spyOn(RegExp.prototype, "exec");
	let row: ToolExecutionComponent | undefined;
	try {
		row = new ToolExecutionComponent("codemode", "c", { code }, {}, codemodeRenderers, tui, "/");
		assert.deepEqual(row.render(0), []);
		assert.ok(!exec.mock.calls.some(([input]) => input === code), "scanned source before a visible paint");
	} finally {
		exec.mockRestore();
		row?.dispose();
	}
});

test("a stock result wrapped in a replacement ToolBlock keeps the expanded script (#5525)", () => {
	const row = new ToolExecutionComponent(
		"codemode",
		"c",
		{ code: "return 1 + 1;" },
		{},
		{
			...codemodeRenderers,
			renderResult: (...params) =>
				new ToolBlock({
					status: "success",
					title: "Script result",
					details: codemodeRenderers.renderResult!(...params),
				}),
		},
		tui,
		"/",
	);
	try {
		row.updateResult({ content: [{ type: "text", text: "2" }], isError: false });
		row.setExpanded(true);
		assert.deepEqual(
			row.render(58).map((line) => stripVTControlCharacters(line).trimEnd()),
			["", " ● Script result", "   ⎿  return 1 + 1;", "   ⎿  2"],
		);
	} finally {
		row.dispose();
	}
});

test("codemode expanded result does not repeat the script the call shows", () => {
	const { plain } = codemodeBlock(
		{ code: "const unique = await tools.read({ path: 'a' });\nreturn unique;" },
		{ output: "text of a", expanded: true },
	);
	assert.equal(plain.filter((line) => line.includes("const unique")).length, 1, plain.join("\n"));
});

test("codemode call shows the script while the model is still writing it", () => {
	const empty = codemodeBlock({}, { streaming: true }).plain;
	assert.match(empty[1] ?? "", /^ \S codemode\(\)$/);

	const partial = codemodeBlock({ code: "const a = 1;\nconst b = 'unfinished" }, { streaming: true }).plain;
	assert.equal(partial.length, 5, partial.join("\n"));
	assert.match(partial[1] ?? "", /^ \S codemode\($/);
	assert.deepEqual(partial.slice(2), ["     const a = 1;", "     const b = 'unfinished", "   )"]);
});

test("showing a script in the header leaves nested call rows unchanged (#5525)", () => {
	const calls: CodemodeToolDetails["calls"] = [
		{ id: "1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 },
		{ id: "2", name: "read", args: '{"path":"b"}', status: "ok", durationMs: 5 },
		{ id: "3", name: "read", args: '{"path":"c"}', status: "ok", durationMs: 5 },
	];
	const code = "for (const path of ['a', 'b', 'c']) await tools.read({ path });";
	assert.deepEqual(codemodeBlock({ code }, { calls, output: "ok" }).plain, [
		"",
		` ● codemode(${code}) · 1s`,
		"   ⎿  ● Read(a)",
		"",
		"      ● Read(b)",
		"",
		"      ● Read(c)",
		"   ⎿  ok",
	]);
	const expanded = codemodeBlock({ code }, { calls, output: "ok", expanded: true }).plain;
	assert.equal(expanded.slice(1).filter((line) => line === "").length, 2, expanded.join("\n"));
});

test("codemode script rows fit narrow terminals: collapsed lines are cut, expanded lines wrap", () => {
	const code = `const first = 1;\nconst message = "${"m".repeat(60)}";\nreturn message;`;
	for (const width of [12, 24, 40]) {
		for (const expanded of [false, true]) {
			const { raw } = codemodeBlock({ code }, { width, expanded });
			for (const line of raw) assert.ok(visibleWidth(line) <= width, `${width}/${expanded}: ${line}`);
		}
	}
	const collapsed = codemodeBlock({ code }, { width: 40 }).plain;
	// 40 columns: a 1-column pad, the 2-column glyph, and the code's own 2-column indent leave 35 for the code.
	assert.deepEqual(collapsed.slice(1, 4), [
		" ● codemode(",
		"     const first = 1;",
		`     const message = "${"m".repeat(17)}…`,
	]);
	const expanded = codemodeBlock({ code }, { width: 40, expanded: true }).plain;
	// Every m is still there: 60 in the string, one in each `message`, one in `codemode`.
	assert.equal(expanded.join("").match(/m/g)?.length, 60 + 2 + 1);
	assert.ok(expanded.includes("   ) · 1s"), expanded.join("\n"));
});

test("wrapping an expanded codemode argument preserves every space inside a string (#5525)", () => {
	const code = 'const text = "a              b     c";   ';
	const { raw } = codemodeBlock({ code }, { width: 18, expanded: true });
	const chunks = raw.slice(2, -1).map((row, i) => stripVTControlCharacters(row).slice(i === 0 ? 5 : 7));
	assert.equal(chunks.join(""), code);
});

test("codemode expanded script indents a wrapped line's continuation rows under the line", () => {
	const code =
		"for (const path of paths) {\n  const total = files.map((file) => file.lines).reduce((sum, count) => sum + count, 0);\n}";
	const { plain } = codemodeBlock({ code }, { width: 50, expanded: true });
	// 50 columns leave 45 for the code; the line's 2-column indent plus 2 hang its continuation rows 4 columns in.
	assert.deepEqual(plain.slice(1, 8), [
		" ● codemode(",
		"     for (const path of paths) {",
		"       const total = files.map((file) =>",
		"         file.lines).reduce((sum, count) => sum +",
		"         count, 0);",
		"     }",
		"   ) · 1s",
	]);
});

test("codemode expanded script keeps every wide character at every width, and shows a one-column row's as a placeholder (#5525)", () => {
	const lines = 11;
	const code = `${"// 漢字😀e\u0301甲乙丙\n".repeat(lines)}return 1;`;
	const wide = ["漢", "字", "😀", "甲", "乙", "丙"];
	for (let width = 1; width <= 60; width++) {
		const { raw, plain } = codemodeBlock({ code }, { width, expanded: true });
		for (const line of raw) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		const text = plain.join("\n");
		assert.equal(text.split("e\u0301").length - 1, lines, `${width}: ${text}`);
		// One column cannot hold a wide character: each one shows as a placeholder there, and nowhere else.
		const placeholders = text.split(WIDE_CHARACTER_PLACEHOLDER).length - 1;
		for (const mark of wide)
			assert.equal(text.split(mark).length - 1, width === 1 ? 0 : lines, `${width} ${mark}: ${text}`);
		assert.equal(placeholders, width === 1 ? lines * wide.length : 0, `${width}: ${text}`);
	}
});

test("hanging indentation gives way to a grapheme wider than two cells (#5525)", () => {
	const { plain } = codemodeBlock({ code: "//\n      /*|क्ष्ण|*/" }, { width: 9, expanded: true });
	assert.ok(
		plain.some((row) => row.includes("क्ष्ण")),
		plain.join("\n"),
	);
});

test("codemode one-line script too wide for the row wraps under codemode( when expanded", () => {
	const code = `return "${"w".repeat(80)}";`;
	const collapsed = codemodeBlock({ code }, { width: 50 }).plain;
	assert.equal(collapsed.length, 2);
	assert.match(collapsed[1] ?? "", /^ ● codemode\(return "w+…\) · 1s$/);
	const expanded = codemodeBlock({ code }, { width: 50, expanded: true }).plain;
	assert.equal(expanded[1], " ● codemode(");
	assert.equal(expanded.join("").match(/w/g)?.length, 80);
	assert.equal(expanded.at(-1), "   ) · 1s");
});

test("codemode shares the header elapsed time during execution and after completion (#5350)", () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const tui = { requestRender: () => {} } as unknown as TUI;
	const component = new ToolExecutionComponent("codemode", "call", { code: "" }, {}, codemodeRenderers, tui, "/");
	const text = () => stripVTControlCharacters(component.render(120).join("\n"));
	component.markExecutionStarted();
	component.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
	vi.advanceTimersByTime(3_000);
	assert.match(text(), /∀ codemode\(\) · 3s/);
	assert.doesNotMatch(text(), /Took|Elapsed/);

	component.updateResult({ content: [], details: { calls: [] }, isError: false, durationMs: 5_100 }, false);
	assert.match(text(), /● codemode\(\) · 5s/);
	assert.doesNotMatch(text(), /Took|Elapsed/);
	component.dispose();
});
