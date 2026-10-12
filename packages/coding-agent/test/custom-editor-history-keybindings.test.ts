import {
	getKeybindings,
	isKittyProtocolActive,
	setKeybindings,
	setKittyProtocolActive,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
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
	setProgramStatus(): void {}
}

function createEditor(keybindings: KeybindingsManager): CustomEditor {
	return new CustomEditor(new TuiMainScreen(new FakeTerminal()), getEditorTheme(), keybindings);
}

beforeAll(() => {
	initTheme("dark");
});

describe("CustomEditor prompt history bindings", () => {
	test("explicit Ctrl+P and Ctrl+N history bindings beat application actions", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		const previousKeybindings = getKeybindings();
		setKeybindings(keybindings);
		try {
			const editor = createEditor(keybindings);
			let modelCycles = 0;
			let namedFilterToggles = 0;
			editor.onAction("app.model.cycleForward", () => {
				modelCycles += 1;
			});
			editor.onAction("app.session.toggleNamedFilter", () => {
				namedFilterToggles += 1;
			});
			editor.addToHistory("older prompt");
			editor.addToHistory("newer prompt");
			editor.setText("draft");

			editor.handleInput("\x10");
			expect(editor.getText()).toBe("newer prompt");
			editor.handleInput("\x0e");
			expect(editor.getText()).toBe("draft");
			expect(modelCycles).toBe(0);
			expect(namedFilterToggles).toBe(0);
		} finally {
			setKeybindings(previousKeybindings);
		}
	});
});

describe("CustomEditor shifted-symbol bindings", () => {
	test("a binding named by the produced symbol fires on Kitty's Shift+= report", () => {
		const keybindings = new KeybindingsManager({ "app.model.cycleForward": "+" });
		const previousKeybindings = getKeybindings();
		const wasKittyActive = isKittyProtocolActive();
		setKeybindings(keybindings);
		setKittyProtocolActive(true);
		try {
			const editor = createEditor(keybindings);
			let modelCycles = 0;
			editor.onAction("app.model.cycleForward", () => {
				modelCycles += 1;
			});

			// Kitty reports "+" as the physical "=" key with Shift, carrying "+" as the shifted key.
			editor.handleInput("\x1b[61:43;2u");
			expect(modelCycles).toBe(1);
			expect(editor.getText()).toBe("");
		} finally {
			setKittyProtocolActive(wasKittyActive);
			setKeybindings(previousKeybindings);
		}
	});
});
