import assert from "node:assert/strict";
import type { Terminal } from "@earendil-works/pi-tui";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import { rpcTransportError } from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";

initTheme("dark");

/**
 * pi-tui's `submitValue()` expands paste markers, trims, and clears the editor
 * before it calls `onSubmit`, so the callback argument can never be what the
 * user actually had. Restoration used to work only because the tests handed
 * `onSubmit` an untrimmed string directly, bypassing the real boundary.
 *
 * These drive a real `CustomEditor` through a real Enter keypress.
 */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
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

interface EditorHarness {
	editor: CustomEditor;
	submitted: string[];
	drafts: Array<string | undefined>;
}

function makeEditor(): EditorHarness {
	const editor = new CustomEditor(new TuiMainScreen(new FakeTerminal()), getEditorTheme(), new KeybindingsManager());
	const submitted: string[] = [];
	const drafts: Array<string | undefined> = [];
	editor.onSubmit = (text: string) => {
		// Exactly what setupEditorSubmitHandler does, at the same point.
		drafts.push(editor.takeSubmittedDraft());
		submitted.push(text);
	};
	return { editor, submitted, drafts };
}

test("a real Enter submission exposes the pre-trim buffer, not the trimmed callback text", () => {
	const h = makeEditor();
	h.editor.setText("  first line  \nsecond line  ");
	h.editor.handleInput("\r");
	assert.deepEqual(h.submitted, ["first line  \nsecond line"], "pi-tui still trims what it passes on");
	assert.deepEqual(h.drafts, ["  first line  \nsecond line  "], "the captured draft must be the untrimmed buffer");
});

test("a slash command keeps its surrounding spaces in the captured draft", () => {
	const h = makeEditor();
	h.editor.setText("  /freeze-test  ");
	h.editor.handleInput("\r");
	assert.deepEqual(h.submitted, ["/freeze-test"]);
	assert.deepEqual(h.drafts, ["  /freeze-test  "]);
});

test("a large paste is captured expanded, not as a marker", () => {
	const h = makeEditor();
	const payload = "x".repeat(1_200);
	h.editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
	const visible = h.editor.getText();
	assert.notEqual(visible, payload, "pi-tui should hold a large paste behind a marker");
	assert.ok(visible.includes("paste"), `expected a paste marker, saw ${JSON.stringify(visible.slice(0, 40))}`);
	h.editor.handleInput("\r");
	assert.deepEqual(h.drafts, [payload], "the captured draft must contain the payload, not the marker");
});

test("an ordinary keystroke leaves no stale captured draft", () => {
	const h = makeEditor();
	h.editor.setText("draft");
	h.editor.handleInput("a");
	assert.equal(h.editor.takeSubmittedDraft(), undefined, "capture must not outlive its own dispatch");
	h.editor.handleInput("\r");
	assert.deepEqual(h.drafts, ["drafta"]);
});

test("the submit handler falls back to the callback text for editors without capture", async () => {
	const state = { editorText: "", errors: [] as string[], submitted: [] as string[] };
	const editor = {
		getText: () => state.editorText,
		getExpandedText: () => state.editorText,
		setText: (text: string) => {
			state.editorText = text;
		},
		addToHistory: () => {},
		onSubmit: undefined as ((text: string) => Promise<void> | void) | undefined,
	};
	const host = {
		firstSubmitRecorded: true,
		defaultEditor: editor,
		editor,
		editorContainer: { children: [editor] },
		ui: { setFocus: () => {}, requestRender: () => {} },
		pendingUserInputs: [],
		startupCookedInputRecovered: false,
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			queuedMessagesPaused: false,
			prompt: async () => {
				throw rpcTransportError("Agent process stopped");
			},
		},
		isExtensionCommand: () => false,
		flushPendingBashComponents: () => {},
		renderDeferredUserInput: () => {},
		showError: (message: string) => {
			state.errors.push(message);
		},
		advanceStartupInputReplay: () => {},
	};
	const mode = host as unknown as InteractiveModeBase;
	InteractiveModeBase.prototype.setupEditorSubmitHandler.call(mode);
	// No takeSubmittedDraft on this editor: the callback argument is all there is.
	await editor.onSubmit?.("/atomic fallback");
	assert.equal(state.editorText, "/atomic fallback");
	assert.deepEqual(state.errors, []);
});
