import assert from "node:assert/strict";
import { type Component, Container, setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

beforeAll(() => initTheme("dark"));

test("Ctrl+R opens prompt search through the main editor's registered key handler (#5347)", async () => {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const ui = new TuiMainScreen(new RecordingTerminal());
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	editor.addToHistory("inspect the menu keys");
	editor.setText("unfinished draft");
	let shown: Component | undefined;
	let closed = 0;
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		keybindings,
		ui,
		editorContainer: new Container(),
		tuiInputSubscriptions: new Set(),
		runtimeHost: { session: { sessionManager: { getEntries: () => [] } } },
		showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
			shown = create(() => closed++).component;
		},
	}) as InteractiveMode;
	await mode.setupKeyHandlers();
	editor.handleInput("\x12");
	assert.ok(shown, "the physical Ctrl+R key must open the selector");
	assert.ok(
		shown
			.render(80)
			.map(stripTerminalSequences)
			.some((line) => line.includes("inspect the menu keys")),
	);
	shown.handleInput?.("\r");
	assert.equal(editor.getText(), "inspect the menu keys");
	assert.equal(closed, 1);
});
