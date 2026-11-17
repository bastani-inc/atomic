import assert from "node:assert/strict";
import {
	type AutocompleteProvider,
	Editor,
	type EditorAutocompleteHintEntry,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getEditorTheme, initTheme, renderAutocompleteHint } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const ALL: readonly EditorAutocompleteHintEntry[] = [
	{ actions: ["tui.select.up", "tui.select.down"], label: "select" },
	{ actions: ["tui.input.tab"], label: "complete", essential: true },
	{ actions: ["tui.select.confirm"], label: "run", essential: true },
	{ actions: ["tui.select.cancel"], label: "close", essential: true },
];

const plain = (line: string) => stripTerminalSequences(line).trim();

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("the @ and / menus' hint line in Atomic's theme (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("names the keys as the user's keybindings name them", () => {
		assert.equal(plain(renderAutocompleteHint(ALL, 120)), "↑↓ select · tab complete · enter run · esc close");
		const remapped = new KeybindingsManager({ "tui.input.tab": "ctrl+i", "tui.select.cancel": "ctrl+g" });
		assert.equal(
			plain(renderAutocompleteHint(ALL, 120, remapped)),
			"↑↓ select · ctrl+i complete · enter run · ctrl+g close",
		);
	});

	it("leaves out an entry whose keys are all unbound, so it never names a dead key", () => {
		const unbound = new KeybindingsManager({ "tui.input.tab": [] });
		assert.equal(plain(renderAutocompleteHint(ALL, 120, unbound)), "↑↓ select · enter run · esc close");
	});

	it("gives up select before complete, run and close on a narrow line", () => {
		assert.equal(plain(renderAutocompleteHint(ALL, 40)), "tab complete · enter run · esc close");
	});

	for (const width of [80, 160]) {
		it(`draws the hint line under the open / menu at ${width} columns`, async () => {
			const terminal = new RecordingTerminal();
			terminal.columns = width;
			const editor = new Editor(new TuiMainScreen(terminal), getEditorTheme());
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
			editor.setAutocompleteProvider(provider);
			editor.handleInput("/");
			await flushAutocomplete();
			const lines = editor.render(width);
			const menu = lines.map(plain);
			assert.ok(menu.some((line) => line.startsWith("❯ tree")));
			assert.equal(menu.at(-1), "↑↓ select · tab complete · enter run · esc close");
			assert.ok(lines.every((line) => stripTerminalSequences(line).length <= width));
		});
	}
});
