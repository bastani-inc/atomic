import assert from "node:assert/strict";
import {
	type AutocompleteProvider,
	Editor,
	type EditorAutocompleteHintEntry,
	type KeybindingsConfig,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
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
		const remapped = new KeybindingsManager({ "tui.input.tab": "ctrl+i", "tui.select.cancel": "ctrl+q" });
		assert.equal(
			plain(renderAutocompleteHint(ALL, 120, remapped)),
			"↑↓ select · ctrl+i complete · enter run · ctrl+q close",
		);
	});

	it("skips app-owned keys and names the first key that reaches the open menu (#5347)", async () => {
		const keybindings = new KeybindingsManager({
			"tui.select.cancel": ["ctrl+shift+p", "ctrl+g", "ctrl+q"],
			"tui.select.up": ["ctrl+p", "up"],
			"app.model.cycleBackward": "shift+ctrl+p",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
		let externalEdits = 0;
		let modelCycles = 0;
		editor.onAction("app.editor.external", () => externalEdits++);
		editor.onAction("app.model.cycleForward", () => modelCycles++);
		editor.onAction("app.model.cycleBackward", () => modelCycles++);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				items: [
					{ value: "/tree", label: "tree" },
					{ value: "/trust", label: "trust" },
				],
				prefix: "/",
			}),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		editor.handleInput("/");
		await flushAutocomplete();
		assert.equal(plain(editor.render(120).at(-1) ?? ""), "↑↓ select · tab complete · enter run · ctrl+q close");
		editor.handleInput("\x10");
		assert.equal(modelCycles, 1);
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\x1b[112;6u");
		assert.equal(modelCycles, 2);
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\x07");
		assert.equal(externalEdits, 1);
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\x11");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("omits close when every configured cancel key belongs to an app action (#5347)", async () => {
		const keybindings = new KeybindingsManager({ "tui.select.cancel": "ctrl+g" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
		editor.onAction("app.editor.external", () => {});
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({ items: [{ value: "/tree", label: "tree" }], prefix: "/" }),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		editor.handleInput("/");
		await flushAutocomplete();
		assert.equal(plain(editor.render(120).at(-1) ?? ""), "tab complete · enter run");
	});

	it("keeps menu keys routed through history overrides, but skips copy and undo (#5347)", async () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.undo": "ctrl+-",
			"tui.select.up": ["ctrl+p", "up"],
			"tui.select.cancel": ["ctrl+c", "ctrl+-", "ctrl+q"],
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => modelCycles++);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				items: [
					{ value: "/tree", label: "tree" },
					{ value: "/trust", label: "trust" },
				],
				prefix: "/",
			}),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		editor.handleInput("/");
		await flushAutocomplete();
		assert.equal(plain(editor.render(120).at(-1) ?? ""), "ctrl+p/↓ select · tab complete · enter run · ctrl+q close");
		editor.handleInput("\x10");
		assert.equal(modelCycles, 0);
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\x11");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	for (const [name, overrides, hint] of [
		[
			"confirm falls back after tab",
			{ "tui.select.confirm": ["tab", "enter"] },
			"↑↓ select · tab complete · enter run · esc close",
		],
		["confirm is shadowed by tab", { "tui.select.confirm": ["tab"] }, "↑↓ select · tab complete · esc close"],
		[
			"tab falls back after page up",
			{ "tui.input.tab": ["pageup", "tab"] },
			"↑↓ select · tab complete · enter run · esc close",
		],
		[
			"up falls back after cancel",
			{ "tui.select.up": ["escape", "up"] },
			"↑↓ select · tab complete · enter run · esc close",
		],
		[
			"up falls back after the escape alias",
			{ "tui.select.up": ["esc", "up"] },
			"↑↓ select · tab complete · enter run · esc close",
		],
		[
			"confirm falls back after the return alias",
			{ "tui.input.tab": ["return", "tab"], "tui.select.confirm": ["enter", "ctrl+q"] },
			"↑↓ select · enter complete · esc close",
		],
		[
			"enter adds a line and ctrl+enter submits",
			{ "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" },
			"↑↓ select · tab complete · esc close",
		],
	] satisfies Array<[string, KeybindingsConfig, string]>) {
		it(`names only keys that reach their menu action when ${name} (#5347)`, async () => {
			const keybindings = new KeybindingsManager(overrides);
			setKeybindings(keybindings);
			const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
			const sent: string[] = [];
			editor.onSubmit = (text) => sent.push(text);
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({
					items: [
						{ value: "/tree", label: "tree" },
						{ value: "/trust", label: "trust" },
					],
					prefix: "/",
				}),
				applyCompletion: (_lines, cursorLine, _cursorCol, item) => ({
					lines: [item.value],
					cursorLine,
					cursorCol: item.value.length,
				}),
			});
			editor.handleInput("/");
			await flushAutocomplete();
			assert.equal(plain(editor.render(120).at(-1) ?? ""), hint);
			editor.handleInput("\t");
			assert.equal(editor.getText(), "/tree");
			assert.equal(editor.isShowingAutocomplete(), false);
			assert.deepEqual(sent, [], "Tab completes rather than running a selected command");

			const sequences: Record<string, string> = { enter: "\r", "ctrl+q": "\x11" };
			const confirmKeys = [overrides["tui.select.confirm"] ?? "enter"].flat();
			for (const key of confirmKeys) {
				const sequence = sequences[key];
				if (sequence === undefined) continue;
				editor.setText("");
				sent.length = 0;
				editor.handleInput("/");
				await flushAutocomplete();
				if (!editor.isShowingAutocomplete()) continue;
				const advertised = hint.split(" · ").includes(`${key} run`);
				editor.handleInput(sequence);
				assert.deepEqual(
					sent,
					advertised ? ["/tree"] : [],
					`${key} ${advertised ? "runs the command it advertises" : "is not advertised and does not run"}`,
				);
			}
		});
	}

	it("does not name the exit key as cancel in an empty file-completion menu (#5347)", async () => {
		const keybindings = new KeybindingsManager({ "tui.select.cancel": ["ctrl+d", "escape"] });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
		let exits = 0;
		editor.onAction("app.exit", () => exits++);
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
		await flushAutocomplete();
		assert.equal(editor.getText(), "");
		assert.equal(plain(editor.render(120).at(-1) ?? ""), "↑↓ select · tab complete · enter insert · esc close");
		editor.handleInput("\x04");
		assert.equal(exits, 1);
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\x1b");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("does not name native macOS image paste as a menu action (#5347)", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platform);
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		try {
			const keybindings = new KeybindingsManager({
				"app.clipboard.pasteImage": "ctrl+v",
				"tui.select.confirm": ["super+v", "enter"],
			});
			setKeybindings(keybindings);
			const editor = new CustomEditor(new TuiMainScreen(new RecordingTerminal()), getEditorTheme(), keybindings);
			let pastes = 0;
			editor.onPasteImage = () => pastes++;
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({ items: [{ value: "/tree", label: "tree" }], prefix: "/" }),
				applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			});
			editor.handleInput("/");
			await flushAutocomplete();
			assert.equal(plain(editor.render(120).at(-1) ?? ""), "tab complete · enter run · esc close");
			editor.handleInput("\x1b[118;9u");
			assert.equal(pastes, 1);
			assert.equal(editor.isShowingAutocomplete(), true);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
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
			assert.ok(menu.some((line) => line.startsWith("∀ tree")));
			assert.equal(menu.at(-1), "↑↓ select · tab complete · enter run · esc close");
			assert.ok(lines.every((line) => stripTerminalSequences(line).length <= width));
		});
	}
});
