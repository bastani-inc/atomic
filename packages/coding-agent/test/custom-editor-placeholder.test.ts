import { CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function createTui(): TUI {
	return {
		terminal: { rows: 24 },
		requestRender: () => {},
	} as Partial<TUI> as TUI;
}

function createEditor(placeholder: string): CustomEditor {
	return new CustomEditor(createTui(), getEditorTheme(), new KeybindingsManager(), {
		promptPrefix: "› ",
		placeholder,
	});
}

function findPlaceholderLine(lines: string[], placeholder: string): string {
	const line = lines.find((candidate) => candidate.includes(placeholder));
	if (!line) {
		throw new Error("Expected placeholder line to render");
	}
	return line;
}

describe("CustomEditor placeholder", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("renders the empty-editor placeholder in muted text with a visible cursor", () => {
		const placeholder = "Paste a ticket, issue, path to a spec, or task prompt…";
		const editor = createEditor(placeholder);
		const line = findPlaceholderLine(editor.render(90), placeholder);
		const cursor = "\x1b[7m \x1b[0m";
		const styledPlaceholder = theme.fg("muted", placeholder);

		expect(line).toContain(cursor);
		expect(line).toContain(styledPlaceholder);
		expect(line.indexOf(cursor)).toBeLessThan(line.indexOf(styledPlaceholder));
		expect(visibleWidth(line)).toBe(90);
	});

	it("keeps the hardware cursor marker when focused", () => {
		const placeholder = "Paste a task prompt…";
		const editor = createEditor(placeholder);
		editor.focused = true;
		const line = findPlaceholderLine(editor.render(80), placeholder);

		expect(line).toContain(`${CURSOR_MARKER}\x1b[7m \x1b[0m`);
	});
});
