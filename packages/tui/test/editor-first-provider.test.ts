import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function rows(editor: Editor): string[] {
	return editor.render(80).map((line) => stripVTControlCharacters(line).trim());
}

function type(editor: Editor, text: string): void {
	for (const ch of text) editor.handleInput(ch);
}

/** A provider that offers `/model` and `/mode` for command names, and `src/main.ts` for a forced file lookup. */
function catalog(asked: string[] = []): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
			asked.push(text);
			if (text.startsWith("/")) {
				const items = ["/model", "/mode"].filter((name) => name.startsWith(text));
				return items.length === 0 ? null : { prefix: text, items: items.map((value) => ({ value, label: value })) };
			}
			return options.force ? { prefix: text, items: [{ value: "src/main.ts", label: "src/main.ts" }] } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const next = [...lines];
			next[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
			return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
		},
	};
}

describe("Editor completion typed before it has a provider", () => {
	it("looks up a command typed before the first provider when the provider arrives", async () => {
		for (const options of [undefined, { preserveSelection: true }] as const) {
			const editor = createEditor();
			type(editor, "/mo");
			editor.setAutocompleteProvider(catalog(), options);
			await settle();
			assert.ok(rows(editor).includes("❯ /model"), JSON.stringify(options));
		}
	});

	it("completes a Tab pressed before the first provider when the provider arrives", async () => {
		const editor = createEditor();
		editor.setText("src/ma");
		editor.handleInput("\t");
		editor.setAutocompleteProvider(catalog());
		await settle();
		assert.equal(editor.getText(), "src/main.ts");
	});

	it("looks up nothing once the user moved on, pressed Esc or erased the trigger", async () => {
		for (const moveOn of ["left", "escape", "erase", "past the token"] as const) {
			const asked: string[] = [];
			const editor = createEditor();
			type(editor, moveOn === "past the token" ? "see @src" : "/mo");
			if (moveOn === "left") editor.handleInput("\x1b[D");
			if (moveOn === "escape") editor.handleInput("\x1b");
			if (moveOn === "erase") for (let i = 0; i < 3; i++) editor.handleInput("\x7f");
			if (moveOn === "past the token") type(editor, " now");
			editor.setAutocompleteProvider(catalog(asked));
			await settle();
			assert.equal(editor.isShowingAutocomplete(), false, moveOn);
			assert.deepEqual(asked, [], moveOn);
		}
	});

	it("carries the lookup in the prompt it hands to another editor, whichever gets there first", async () => {
		for (const order of ["provider first", "prompt first"] as const) {
			const early = createEditor();
			type(early, "/mo");
			const session = createEditor();
			if (order === "provider first") session.setAutocompleteProvider(catalog());
			session.restoreDraft(early.snapshotDraft());
			if (order === "prompt first") session.setAutocompleteProvider(catalog());
			await settle();
			assert.ok(rows(session).includes("❯ /model"), order);
		}
	});

	it("looks up only once for the prompt it was typed in", async () => {
		const asked: string[] = [];
		const editor = createEditor();
		type(editor, "/mo");
		editor.setAutocompleteProvider(catalog(asked));
		await settle();
		editor.setAutocompleteProvider(catalog(asked));
		await settle();
		assert.deepEqual(asked, ["/mo"]);
	});

	it("restores a prompt taken while the editor had a provider without a lookup", async () => {
		const asked: string[] = [];
		const main = createEditor();
		main.setAutocompleteProvider(catalog(asked));
		type(main, "/mo");
		await settle();
		const draft = main.snapshotDraft();
		main.setText("");
		asked.length = 0;
		main.restoreDraft(draft);
		await settle();
		assert.equal(main.isShowingAutocomplete(), false);
		assert.deepEqual(asked, []);
	});
});
