import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("Editor prompt history keybindings", () => {
	it("browses history directly without first moving the cursor", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");
		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});

describe("Editor.setHistory", () => {
	it("replaces what Up and Down walk, and leaves the text and cursor as they are", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("main prompt");
		editor.setText("draft");

		editor.setHistory(["newest of the other agent", "launch task of the other agent"]);
		assert.deepStrictEqual(editor.getHistory(), ["newest of the other agent", "launch task of the other agent"]);
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

		editor.handleInput("\x1b[A"); // to the start of the draft
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "newest of the other agent");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "launch task of the other agent");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "launch task of the other agent");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		assert.strictEqual(editor.getText(), "draft");
	});

	it("ends browsing where it is: the shown entry stays as the text and Down no longer brings back the old draft", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older");
		editor.addToHistory("newer");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "newer");

		editor.setHistory(["other"]);
		assert.strictEqual(editor.getText(), "newer");
		editor.handleInput("\x1b[B");
		assert.strictEqual(editor.getText(), "newer");
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "other");
	});

	it("keeps entries as addToHistory would: trimmed, without blanks or repeats in a row, at most 100", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setHistory(["  b  ", "b", "", "a", "b"]);
		assert.deepStrictEqual(editor.getHistory(), ["b", "a", "b"]);
		editor.setHistory(Array.from({ length: 150 }, (_, index) => `p${149 - index}`));
		assert.strictEqual(editor.getHistory().length, 100);
		assert.strictEqual(editor.getHistory()[0], "p149");
		assert.strictEqual(editor.getHistory().at(-1), "p50");
		editor.setHistory(editor.getHistory());
		assert.strictEqual(editor.getHistory().length, 100);
	});
});
