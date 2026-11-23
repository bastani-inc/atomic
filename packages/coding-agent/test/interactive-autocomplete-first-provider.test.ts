import assert from "node:assert/strict";
import { type AutocompleteProvider, setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

interface AutocompleteHost {
	createBaseAutocompleteProvider(): AutocompleteProvider;
	defaultEditor: CustomEditor;
	editor: CustomEditor;
	autocompleteProviderWrappers: [];
	autocompleteProvider?: AutocompleteProvider;
}

const setupAutocompleteProvider = (
	InteractiveMode as unknown as {
		prototype: { setupAutocompleteProvider(this: AutocompleteHost): void };
	}
).prototype.setupAutocompleteProvider;

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

const commands: AutocompleteProvider = {
	getSuggestions: async (lines, cursorLine, cursorCol) => {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const items = ["/model", "/mode"].filter((name) => name.startsWith(text));
		return items.length === 0 ? null : { prefix: text, items: items.map((value) => ({ value, label: value })) };
	},
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

describe("a command typed while Atomic is starting", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("shows its completion menu once main's completion provider is set up", async () => {
		const editor = new CustomEditor(
			new TuiMainScreen(new RecordingTerminal()),
			getEditorTheme(),
			new KeybindingsManager(),
		);
		for (const ch of "/mo") editor.handleInput(ch);
		await settle();
		assert.equal(editor.isShowingAutocomplete(), false);
		const host: AutocompleteHost = {
			createBaseAutocompleteProvider: () => commands,
			defaultEditor: editor,
			editor,
			autocompleteProviderWrappers: [],
		};
		setupAutocompleteProvider.call(host);
		await settle();
		assert.ok(
			editor.render(80).some((line) => stripTerminalSequences(line).trim() === "∀ /model"),
			editor.render(80).join("\n"),
		);
	});
});
