import assert from "node:assert/strict";
import { type Component, Container, setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
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
		runtimeHost: {
			session: {
				sessionManager: {
					getEntries: () => [
						{
							type: "message",
							timestamp: new Date().toISOString(),
							message: { role: "user", content: [{ type: "text", text: "inspect the menu keys" }] },
						},
					],
				},
			},
		},
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

test("an empty file menu keeps Down before the main chat's agent-panel shortcut (#5347)", async () => {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const ui = new TuiMainScreen(new RecordingTerminal());
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const listeners: Parameters<TuiMainScreen["addInputListener"]>[0][] = [];
	let opened = 0;
	const runtimeHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	Object.defineProperties(runtimeHost, {
		session: { value: { sessionManager: { getEntries: () => [] } } },
		openAgentPanel: {
			value: async () => {
				opened++;
			},
		},
	});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: editor,
		editor,
		editorContainer,
		keybindings,
		ui,
		runtimeHost,
		isBashMode: false,
		blockingInlineCustomUiDepth: 0,
		addTuiInputListener(listener: Parameters<TuiMainScreen["addInputListener"]>[0]) {
			listeners.push(listener);
			return () => {};
		},
	}) as InteractiveMode;
	await mode.setupKeyHandlers();
	editor.setAutocompleteProvider({
		getSuggestions: async () => ({
			items: [
				{ value: "README.md", label: "README.md" },
				{ value: "src/", label: "src/" },
			],
			prefix: "",
		}),
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	});
	editor.handleInput("\t");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
	const pressDown = () => {
		for (const listener of listeners) {
			const result = listener("\x1b[B");
			if (result && typeof result === "object" && "consume" in result && result.consume) return;
		}
		editor.handleInput("\x1b[B");
	};
	pressDown();
	assert.equal(opened, 0);
	assert.ok(
		editor
			.render(100)
			.map(stripTerminalSequences)
			.some((line) => line.includes("∀ src/")),
	);
	editor.handleInput("\x1b");
	pressDown();
	assert.equal(opened, 1);
});
