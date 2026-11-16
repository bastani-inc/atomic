import assert from "node:assert/strict";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor, stripEditorAnsi } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 160;
	rows = 24;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

beforeAll(() => {
	initTheme("dark");
});

function editorWith(label: string | undefined): CustomEditor {
	return new CustomEditor(new TuiMainScreen(new FakeTerminal()), getEditorTheme(), new KeybindingsManager(), {
		topRuleLabel: () => label,
	});
}

describe("main composer top rule (#5224)", () => {
	for (const width of [80, 160]) {
		test(`the session title sits right-aligned in the top rule at ${width} columns`, () => {
			const lines = editorWith("shipping fix-first").render(width);
			const top = stripTerminalSequences(lines[0] ?? "");
			assert.equal(visibleWidth(lines[0] ?? ""), width);
			assert.ok(top.endsWith(" shipping fix-first ─"), top);
			const bottom = lines.findLast((line) => /^─+$/.test(stripTerminalSequences(line)));
			assert.ok(bottom !== undefined);
		});
	}

	test("an untitled session keeps a plain top rule", () => {
		const top = stripTerminalSequences(editorWith(undefined).render(80)[0] ?? "");
		assert.equal(top, "─".repeat(80));
	});

	test("a terminal narrower than 40 columns drops the title", () => {
		const top = stripTerminalSequences(editorWith("shipping fix-first").render(30)[0] ?? "");
		assert.equal(top, "─".repeat(30));
	});

	test("sanitizes newlines, OSC 52, title escapes and clear-screen sequences in the session title (#5243)", () => {
		for (const [raw, expected] of [
			["my\nsession", "my session"],
			["my\r\n\t  session", "my session"],
			["a\x1b]52;c;SGVsbG8=\x07b", "a ]52;c;SGVsbG8= b"],
			["x\x1b]0;PWNED\x07y", "x ]0;PWNED y"],
			["\x1b[2J\x1b[Hboom", "[2J [Hboom"],
		] as const) {
			const top = editorWith(raw).render(80)[0] ?? "";
			assert.doesNotMatch(top, /[\r\n\t\x07]|\x1b\]|\x1b\[2J|\x1b\[H/);
			assert.equal(visibleWidth(top), 80);
			assert.ok(stripTerminalSequences(top).endsWith(` ${expected} ─`), stripTerminalSequences(top));
		}
		assert.equal(stripTerminalSequences(editorWith(" \n\t\x1b ").render(80)[0] ?? ""), "─".repeat(80));
	});

	test("strips terminated CSI, OSC, DCS, SOS and APC sequences identically (#5243)", () => {
		const originalPattern = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX_][\s\S]*?\x1b\\/g;
		const samples = [
			"\x1b[38;2;120;130;140m── ↑ 4 more ───\x1b[0m",
			"a\x1b]8;;https://example.com/a,b\x07link\x1b]8;;\x07b",
			"a\x1b]8;;https://example.com/a,b\x1b\\link\x1b]8;;\x1b\\b",
			"a\x1b]8;;https://example.com/a,b\x1b\\mid\x1b]0;title\x07b",
			"a\x1b]0;first\x1b\\mid\x1b]0;second\x1b\\tail\x1b]unterminated",
			"a\x1b]0;title\x18still-title\x07b",
			"a\x1bP1$r0m\x07still-dcs\x1b\\b\x1bPsecond\x1b\\c",
			"a\x1bXpayload\x1b\\b",
			"a\x1b_Gi=1\x1b\\b",
			"plain text without escapes",
		];
		for (const sample of samples) {
			assert.equal(stripEditorAnsi(sample), sample.replace(originalPattern, ""));
		}
	});

	test("scans 100k characters of repeated unterminated OSC and DCS introducers in linear time (#5243)", () => {
		const input = "\x1b]\x1bP".repeat(25_000);
		assert.equal(input.length, 100_000);
		const start = performance.now();
		const actual = stripEditorAnsi(input);
		const elapsedMs = performance.now() - start;
		assert.equal(actual, input);
		assert.ok(elapsedMs < 100, `expected < 100ms for 100k unterminated introducers, took ${elapsedMs.toFixed(1)}ms`);
	});
});
