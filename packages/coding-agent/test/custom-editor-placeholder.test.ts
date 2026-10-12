import { tmpdir } from "node:os";
import { CURSOR_MARKER, renderFakeCursor, type TUI, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

/** Paint a focused, empty editor with a placeholder and return the screen bytes. */
function paintFocusedPlaceholder(placeholder: string, showHardwareCursor: boolean): string {
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 12;
	const tui = createFullscreenTui({ showHardwareCursor, logDirectory: tmpdir(), terminal });
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), {
		promptPrefix: "› ",
		placeholder,
	});
	tui.setLayoutRoot(new VStack([{ component: editor, basis: 3, grow: 1, shrink: 1, minSize: 1 }]));
	tui.setFocus(editor);
	tui.start();
	try {
		tui.renderNow();
		return terminal.writes.join("");
	} finally {
		tui.stop();
	}
}

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
		const cursor = renderFakeCursor(" ");
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

		expect(line).toContain(`${CURSOR_MARKER}${renderFakeCursor(" ")}`);
	});

	it("draws the placeholder cursor in reverse video when the hardware cursor is hidden", () => {
		const placeholder = "Paste a task prompt…";
		const screen = paintFocusedPlaceholder(placeholder, false);

		expect(screen).toContain(placeholder);
		expect(screen).toContain("\x1b[7m ");
	});

	it("leaves the placeholder cursor to the terminal when showHardwareCursor is enabled", () => {
		const placeholder = "Paste a task prompt…";
		const screen = paintFocusedPlaceholder(placeholder, true);

		expect(screen).toContain(placeholder);
		expect(screen).not.toContain("\x1b[7m");
	});
});
