import assert from "node:assert/strict";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
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
});
