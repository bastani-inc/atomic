import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
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
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX_][\s\S]*?\x1b\\/g, "");
}

function createEditor(): CustomEditor {
	return new CustomEditor(new TUI(new FakeTerminal()), getEditorTheme(), new KeybindingsManager());
}

describe("CustomEditor prompt prefix", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a ❯ prompt caret inside the prompt box", () => {
		const editor = createEditor();
		const lines = editor.render(24);

		expect(stripAnsi(lines[1] ?? "")).toMatch(/^❯ /);
		expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
	});

	it("renders entered text after the prompt caret", () => {
		const editor = createEditor();
		editor.setText("hello");

		const lines = editor.render(24);

		expect(stripAnsi(lines[1] ?? "")).toContain("❯ hello");
		expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
	});

	it("keeps inherited scroll indicators within a narrow Atomic editor", () => {
		const editor = createEditor();
		editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
		editor.render(10);
		for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

		const lines = editor.render(10);
		expect(stripAnsi(lines[0] ?? "")).toContain("↑");
		expect(stripAnsi(lines.at(-1) ?? "")).toContain("↓");
		expect(lines.every((line) => visibleWidth(line) === 10)).toBe(true);
	});
});
