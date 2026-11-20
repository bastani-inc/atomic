import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, editorDraftText, emptyEditorDraft } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	const tui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	return new Editor(tui, defaultEditorTheme);
}

const UNDO = "\x1b[45;5u";
const YANK = "\x19";
const KILL_TO_END = "\x0b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const LONG_PASTE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

function type(editor: Editor, text: string): void {
	for (const character of text) editor.handleInput(character);
}

describe("Editor drafts", () => {
	it("gives back a prompt whole after another prompt was typed in its place", () => {
		const prepare = (editor: Editor) => {
			type(editor, "kill me");
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(KILL_TO_END);
			type(editor, "see ");
			editor.handleInput(`\x1b[200~${LONG_PASTE}\x1b[201~`);
			type(editor, " now");
			editor.handleInput(LEFT);
		};
		const untouched = createEditor();
		prepare(untouched);
		const editor = createEditor();
		prepare(editor);
		assert.match(editor.getText(), /^see \[paste #1 \+20 lines\] now$/);

		const draft = editor.snapshotDraft();
		editor.setText("");
		type(editor, "for the other agent");
		editor.handleInput("\x01");
		editor.handleInput(KILL_TO_END);
		editor.restoreDraft(draft);

		assert.strictEqual(editor.getText(), untouched.getText());
		assert.strictEqual(editor.getExpandedText(), `see ${LONG_PASTE} now`);
		assert.deepStrictEqual(editor.getCursor(), untouched.getCursor());
		// Its own kill ring and undo history, not the other prompt's: the same keys do the same thing.
		editor.handleInput(YANK);
		untouched.handleInput(YANK);
		assert.ok(editor.getText().endsWith("kill mew"), editor.getText());
		for (const key of [UNDO, UNDO, UNDO]) {
			editor.handleInput(key);
			untouched.handleInput(key);
			assert.strictEqual(editor.getText(), untouched.getText());
			assert.strictEqual(editor.getExpandedText(), untouched.getExpandedText());
		}
	});

	it("keeps the draft Up parked while browsing history", () => {
		const editor = createEditor();
		editor.addToHistory("older prompt");
		type(editor, "half typed");
		editor.handleInput("\x01"); // Ctrl+A: Up browses from the start of the prompt
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "older prompt");

		const draft = editor.snapshotDraft();
		editor.setText("something else");
		editor.restoreDraft(draft);

		assert.strictEqual(editor.getText(), "older prompt");
		editor.handleInput(DOWN);
		assert.strictEqual(editor.getText(), "half typed");
	});

	it("is detached from later editing and can be restored more than once", () => {
		const editor = createEditor();
		type(editor, "first");
		const draft = editor.snapshotDraft();
		type(editor, " and more");
		editor.restoreDraft(draft);
		assert.strictEqual(editor.getText(), "first");
		type(editor, " again");
		editor.restoreDraft(draft);
		assert.strictEqual(editor.getText(), "first");
	});

	it("reports the restored text to onChange", () => {
		const editor = createEditor();
		type(editor, "!ls");
		const draft = editor.snapshotDraft();
		editor.setText("");
		const seen: string[] = [];
		editor.onChange = (text) => seen.push(text);
		editor.restoreDraft(draft);
		assert.deepStrictEqual(seen, ["!ls"]);
	});

	it("starts a prompt nothing was typed into from an empty draft, with nothing to undo or yank", () => {
		const editor = createEditor();
		type(editor, "main's words");
		editor.handleInput("\x01");
		editor.handleInput(KILL_TO_END);
		type(editor, "kept");
		editor.restoreDraft(emptyEditorDraft());
		assert.strictEqual(editor.getText(), "");
		editor.handleInput(YANK);
		editor.handleInput(UNDO);
		assert.strictEqual(editor.getText(), "");
	});

	it("reads the reader's own text from a draft: the one Up parked while browsing, with pastes expanded", () => {
		const editor = createEditor();
		editor.addToHistory("sent earlier");
		type(editor, "my ");
		editor.handleInput(`\x1b[200~${LONG_PASTE}\x1b[201~`);
		assert.strictEqual(editorDraftText(editor.snapshotDraft()), `my ${LONG_PASTE}`);
		editor.handleInput("\x01");
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "sent earlier");
		assert.strictEqual(editorDraftText(editor.snapshotDraft()), `my ${LONG_PASTE}`);
	});
});
