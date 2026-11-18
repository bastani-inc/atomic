import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const press = (column: number, row: number) => `\x1b[<0;${column + 1};${row + 1}M`;
const release = (column: number, row: number) => `\x1b[<0;${column + 1};${row + 1}m`;
const drag = (column: number, row: number) => `\x1b[<32;${column + 1};${row + 1}M`;
const wheelDown = (column: number, row: number) => `\x1b[<65;${column + 1};${row + 1}M`;

/** The fullscreen renderer showing `overlay` over a line of text, driven by SGR mouse reports. */
async function mount(
	overlay: SelectList | SettingsList,
	options: { readonly columns?: number; readonly rows?: number } = {},
) {
	const terminal = new VirtualTerminal(options.columns ?? 40, options.rows ?? 12);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.addChild(new Text("background", 0, 0));
	tui.start();
	tui.showOverlay(overlay, { anchor: "top-left", width: options.columns ?? 40 });
	await terminal.waitForRender();
	const rowOf = (text: string): number => {
		const row = terminal.getViewport().findIndex((line) => line.includes(text));
		assert.notStrictEqual(row, -1, `no row shows ${text}:\n${terminal.getViewport().join("\n")}`);
		return row;
	};
	const click = async (row: number, column = 4) => {
		terminal.sendInput(press(column, row));
		terminal.sendInput(release(column, row));
		await terminal.waitForRender();
	};
	return { terminal, tui, copied, rowOf, click };
}

function letters(): SelectList {
	return new SelectList(
		["alpha", "bravo", "charlie", "delta", "echo"].map((value) => ({ value, label: value })),
		5,
		selectTheme,
	);
}

describe("clickable list rows", () => {
	it("a single click on a select-list row selects it and runs it as enter does", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);

		await view.click(view.rowOf("charlie"));

		assert.deepStrictEqual(chosen, ["charlie"]);
		assert.strictEqual(list.getSelectedItem()?.value, "charlie");
		view.tui.stop();
	});

	it("a double-click on a select-list row runs it once", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);

		const row = view.rowOf("delta");
		await view.click(row);
		await view.click(row);
		await view.click(row);

		assert.deepStrictEqual(chosen, ["delta"]);
		view.tui.stop();
	});

	it("a drag across select-list rows selects their text and runs nothing", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);

		const from = view.rowOf("bravo");
		const to = view.rowOf("charlie");
		view.terminal.sendInput(press(2, from));
		view.terminal.sendInput(drag(6, to));
		view.terminal.sendInput(release(6, to));
		await view.terminal.waitForRender();

		assert.deepStrictEqual(chosen, []);
		assert.deepStrictEqual(view.copied, ["bravo\n  charl"]);
		view.tui.stop();
	});

	it("a press that moves off its row before the release runs nothing", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);

		view.terminal.sendInput(press(4, view.rowOf("bravo")));
		view.terminal.sendInput(release(4, view.rowOf("delta")));
		await view.terminal.waitForRender();

		assert.deepStrictEqual(chosen, []);
		view.tui.stop();
	});

	it("the mouse wheel over a select list moves its selection", async () => {
		const list = new SelectList(
			Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` })),
			5,
			selectTheme,
		);
		const view = await mount(list);

		view.terminal.sendInput(wheelDown(4, view.rowOf("Item 2")));
		view.terminal.sendInput(wheelDown(4, view.rowOf("Item 2")));
		await view.terminal.waitForRender();

		assert.strictEqual(list.getSelectedItem()?.value, "item-2");
		view.tui.stop();
	});

	it("a double-click on a settings row changes its value once", async () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two", "three"] },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
			],
			5,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);
		const view = await mount(list);

		const row = view.rowOf("Mode");
		await view.click(row);
		await view.click(row);

		assert.deepStrictEqual(changes, [{ id: "mode", value: "two" }]);
		view.tui.stop();
	});

	it("a click on a slash-command row in the editor's menu runs that command, as enter on it does", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const editorTheme: EditorTheme = { borderColor: (text) => text, selectList: selectTheme };
		const editor = new Editor(tui, editorTheme);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, _line, cursorCol) => {
				const prefix = (lines[0] ?? "").slice(0, cursorCol);
				if (!prefix.startsWith("/")) return null;
				return {
					prefix,
					items: [
						{ value: "model", label: "model", description: "pick a model" },
						{ value: "resume", label: "resume", description: "resume a session" },
					],
				};
			},
			applyCompletion: (lines, cursorLine, _cursorCol, item, prefix) => {
				const line = lines[cursorLine] ?? "";
				const next = `/${item.value} ${line.slice(prefix.length)}`;
				return { lines: [next], cursorLine, cursorCol: `/${item.value} `.length };
			},
		});
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		editor.handleInput("/");
		for (
			let attempt = 0;
			attempt < 20 && !terminal.getViewport().some((line) => line.includes("resume"));
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			await terminal.waitForRender();
		}
		const row = terminal.getViewport().findIndex((line) => line.includes("resume"));
		assert.notStrictEqual(row, -1, terminal.getViewport().join("\n"));

		terminal.sendInput(press(4, row));
		terminal.sendInput(release(4, row));
		await terminal.waitForRender();

		assert.deepStrictEqual(submitted, ["/resume"]);
		tui.stop();
	});
});
