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
		prototype: { setupAutocompleteProvider(this: AutocompleteHost, options?: { closeMenu?: boolean }): void };
	}
).prototype.setupAutocompleteProvider;

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

/** Main's completion of `/glo`, as the commands known at the time offer it. */
function catalog(...names: string[]): AutocompleteProvider {
	return {
		getSuggestions: async () => ({ prefix: "/glo", items: names.map((name) => ({ value: name, label: name })) }),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] ?? "";
			const text = line.slice(0, cursorCol - prefix.length) + item.value;
			return { lines: [text], cursorLine, cursorCol: text.length };
		},
	};
}

function rows(editor: CustomEditor): string[] {
	return editor.render(80).map((line) => stripTerminalSequences(line).trim());
}

describe("rebuilding main's completion provider while the user types", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	function openMenu(): { host: AutocompleteHost; offer: (...names: string[]) => void } {
		const editor = new CustomEditor(
			new TuiMainScreen(new RecordingTerminal()),
			getEditorTheme(),
			new KeybindingsManager(),
		);
		let names = ["/global", "/glossary"];
		const host: AutocompleteHost = {
			createBaseAutocompleteProvider: () => catalog(...names),
			defaultEditor: editor,
			editor,
			autocompleteProviderWrappers: [],
		};
		return {
			host,
			offer: (...next: string[]) => {
				names = next;
			},
		};
	}

	it("keeps the open menu and shows the new commands (fd found, engine commands, late extensions)", async () => {
		const { host, offer } = openMenu();
		setupAutocompleteProvider.call(host);
		for (const ch of "/glo") host.editor.handleInput(ch);
		await settle();
		assert.ok(rows(host.editor).includes("∀ /global"));

		offer("/globe", "/global", "/glossary");
		setupAutocompleteProvider.call(host);
		await settle();
		assert.ok(rows(host.editor).includes("∀ /globe"));
		assert.equal(host.editor.getText(), "/glo");
	});

	it("keeps an open menu of an extension's own editor too", async () => {
		const { host, offer } = openMenu();
		const own = new CustomEditor(
			new TuiMainScreen(new RecordingTerminal()),
			getEditorTheme(),
			new KeybindingsManager(),
		);
		host.editor = own;
		setupAutocompleteProvider.call(host);
		for (const ch of "/glo") own.handleInput(ch);
		await settle();
		offer("/globe", "/global");
		setupAutocompleteProvider.call(host);
		await settle();
		assert.ok(rows(own).includes("∀ /globe"));
	});

	it("closes the menu when the folder's resources are withheld", async () => {
		const { host } = openMenu();
		setupAutocompleteProvider.call(host);
		for (const ch of "/glo") host.editor.handleInput(ch);
		await settle();
		assert.ok(rows(host.editor).includes("∀ /global"));
		setupAutocompleteProvider.call(host, { closeMenu: true });
		await settle();
		assert.equal(host.editor.isShowingAutocomplete(), false);
	});
});
