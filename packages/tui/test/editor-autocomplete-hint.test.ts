import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, type EditorAutocompleteHintEntry, type EditorTheme } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] || "";
	const newLines = [...lines];
	newLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
	return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function hintTheme(): { theme: EditorTheme; shown: (readonly EditorAutocompleteHintEntry[])[] } {
	const shown: (readonly EditorAutocompleteHintEntry[])[] = [];
	return {
		shown,
		theme: {
			...defaultEditorTheme,
			autocompleteHint: (entries, width) => {
				shown.push(entries);
				return `HINT ${entries.map((entry) => entry.label).join(" · ")}`.slice(0, width);
			},
		},
	};
}

function provider(prefix: string, values: string[]): AutocompleteProvider {
	return {
		getSuggestions: async () => ({ items: values.map((value) => ({ value, label: value })), prefix }),
		applyCompletion,
	};
}

describe("the @ and / menus' hint line (#5224)", () => {
	it("lists select, complete, run and close under an open slash menu", async () => {
		const { theme, shown } = hintTheme();
		const editor = new Editor(createTestTUI(), theme);
		editor.setAutocompleteProvider(provider("/", ["/tree", "/trust"]));
		editor.handleInput("/");
		await flushAutocomplete();
		const lines = editor.render(80);
		assert.match(lines.at(-1) ?? "", /HINT select · complete · run · close/);
		assert.deepStrictEqual(
			shown.at(-1)?.map((entry) => [entry.actions.join(","), entry.label]),
			[
				["tui.select.up,tui.select.down", "select"],
				["tui.input.tab", "complete"],
				["tui.select.confirm", "run"],
				["tui.select.cancel", "close"],
			],
		);
	});

	it("offers insert for an @ menu and leaves out select when there is one row", async () => {
		const { theme, shown } = hintTheme();
		const editor = new Editor(createTestTUI(), theme);
		editor.setAutocompleteProvider({ ...provider("@ma", ["@math.py"]), triggerCharacters: ["@"] });
		editor.handleInput("@");
		editor.handleInput("m");
		editor.handleInput("a");
		await new Promise((resolve) => setTimeout(resolve, 400));
		await flushAutocomplete();
		editor.render(80);
		assert.deepStrictEqual(
			shown.at(-1)?.map((entry) => entry.label),
			["complete", "insert", "close"],
		);
	});

	it("draws no hint line when the theme has none, and none once the menu closes", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(provider("/", ["/tree", "/trust"]));
		editor.handleInput("/");
		await flushAutocomplete();
		assert.ok(!editor.render(80).some((line) => line.includes("HINT")));
		const { theme } = hintTheme();
		const hinted = new Editor(createTestTUI(), theme);
		hinted.setAutocompleteProvider(provider("/", ["/tree", "/trust"]));
		hinted.handleInput("/");
		await flushAutocomplete();
		assert.ok(hinted.render(80).some((line) => line.includes("HINT")));
		hinted.handleInput("\x1b");
		assert.ok(!hinted.render(80).some((line) => line.includes("HINT")));
	});

	it("keeps the hint line out of row clicks", async () => {
		const { theme } = hintTheme();
		const editor = new Editor(createTestTUI(), theme);
		let changed = 0;
		editor.onChange = () => changed++;
		editor.setAutocompleteProvider(provider("/", ["/tree", "/trust"]));
		editor.handleInput("/");
		await flushAutocomplete();
		const lines = editor.render(80);
		const hintRow = lines.findIndex((line) => line.includes("HINT"));
		const before = changed;
		const pressed = editor.handleMouse({
			type: "press",
			button: "left",
			x: 4,
			y: hintRow,
			screenX: 4,
			screenY: hintRow,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(pressed, undefined);
		assert.strictEqual(changed, before);
		assert.strictEqual(editor.getText(), "/");
	});
});

describe("prompt history access (#5224)", () => {
	it("returns past prompts newest first, without letting a caller change them", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.addToHistory("first");
		editor.addToHistory("second");
		const history = editor.getHistory();
		assert.deepStrictEqual(history, ["second", "first"]);
		(history as string[]).push("third");
		assert.deepStrictEqual(editor.getHistory(), ["second", "first"]);
	});
});
