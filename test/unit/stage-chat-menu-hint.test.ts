import assert from "node:assert/strict";
import {
	type AutocompleteProvider,
	Editor,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { editorThemeFromGraphTheme } from "../../packages/workflows/src/tui/stage-chat-view-render-helpers.ts";

class Terminal {
	columns = 100;
	rows = 24;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

const provider: AutocompleteProvider = {
	getSuggestions: async () => ({
		items: [
			{ value: "tree", label: "tree", description: "Navigate session tree" },
			{ value: "trust", label: "trust", description: "Save project trust" },
		],
		prefix: "/",
	}),
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

async function menuHint(theme: ConstructorParameters<typeof Editor>[1]): Promise<string | undefined> {
	const editor = new Editor(new TuiMainScreen(new Terminal() as never), theme);
	editor.setAutocompleteProvider(provider);
	editor.handleInput("/");
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	return editor
		.render(100)
		.map((line) => stripTerminalSequences(line).trim())
		.at(-1);
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

test("a workflow stage chat's / menu ends with the main chat's hint line (#5224)", async () => {
	const main = await menuHint(getEditorTheme());
	const stage = await menuHint(editorThemeFromGraphTheme(deriveGraphTheme()));
	assert.equal(main, "↑↓ select · tab complete · enter run · esc close");
	assert.equal(stage, main);
});
