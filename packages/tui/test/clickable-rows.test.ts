import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
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

	it("a generic terminal release activates the row of a left press, but not a modified press", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);
		try {
			for (const [label, button] of [
				["bravo", 0],
				["delta", 16],
			] as const) {
				const row = view.rowOf(label);
				view.terminal.sendInput(`\x1b[<${button};4;${row + 1}M`);
				view.terminal.sendInput(`\x1b[<3;4;${row + 1}m`);
			}
			assert.deepStrictEqual(chosen, ["bravo"]);
		} finally {
			view.tui.stop();
		}
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

	/** A list across the screen with a two-line dialog shown over its top-left corner, as `nonCapturing` says. */
	async function listUnderDialog(nonCapturing: boolean) {
		const terminal = new VirtualTerminal(40, 12);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		tui.addChild(list);
		tui.setFocus(list);
		tui.start();
		const dialog = new SelectList(
			[
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			],
			2,
			selectTheme,
		);
		dialog.onSelect = (item) => chosen.push(`dialog:${item.value}`);
		tui.showOverlay(dialog, { anchor: "top-left", width: 12, nonCapturing });
		await terminal.waitForRender();
		const rowOf = (text: string): number => {
			const row = terminal.getViewport().findIndex((line) => line.includes(text));
			assert.notStrictEqual(row, -1, `no row shows ${text}:\n${terminal.getViewport().join("\n")}`);
			return row;
		};
		const click = async (row: number, column: number) => {
			terminal.sendInput(press(column, row));
			terminal.sendInput(release(column, row));
			await terminal.waitForRender();
		};
		return { terminal, tui, chosen, copied, rowOf, click };
	}

	it("while a dialog over a list has focus, a click on a row outside the dialog runs nothing", async () => {
		const view = await listUnderDialog(false);

		await view.click(view.rowOf("delta"), 4);
		assert.deepStrictEqual(view.chosen, []);
		await view.click(view.rowOf("No"), 4);
		assert.deepStrictEqual(view.chosen, ["dialog:no"]);
		view.tui.stop();
	});

	it("while a dialog over a list has focus, a drag outside the dialog still selects text", async () => {
		const view = await listUnderDialog(false);

		const row = view.rowOf("delta");
		view.terminal.sendInput(press(2, row));
		view.terminal.sendInput(drag(6, row));
		view.terminal.sendInput(release(6, row));
		await view.terminal.waitForRender();

		assert.deepStrictEqual(view.chosen, []);
		assert.deepStrictEqual(view.copied, ["delta"]);
		view.tui.stop();
	});

	it("while a dialog over a full-screen overlay's list has focus, a click on a row outside the dialog runs nothing", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("background", 0, 0));
		tui.start();
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		tui.showOverlay(list, { anchor: "top-left", width: 40 });
		tui.showOverlay(new Text("Stop everything?", 0, 0), { anchor: "bottom-right", width: 18 });
		await terminal.waitForRender();
		const row = terminal.getViewport().findIndex((line) => line.includes("delta"));
		assert.notStrictEqual(row, -1, terminal.getViewport().join("\n"));

		terminal.sendInput(press(4, row));
		terminal.sendInput(release(4, row));
		await terminal.waitForRender();

		assert.deepStrictEqual(chosen, []);
		tui.stop();
	});

	it("an inline picker focused on a nested list blocks the transcript but not its own rows", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const dialog = new Container();
		const tui = new TuiAltScreen(terminal, undefined, undefined, { getInlineDialog: () => dialog });
		const behind = letters();
		const choices = letters();
		const chosen: string[] = [];
		behind.onSelect = (item) => chosen.push(`behind:${item.value}`);
		choices.onSelect = (item) => chosen.push(`dialog:${item.value}`);
		tui.addChild(behind);
		dialog.addChild(choices);
		tui.addChild(dialog);
		tui.setFocus(choices);
		tui.start();
		try {
			await terminal.waitForRender();
			const rows = terminal.getViewport().flatMap((line, row) => (line.includes("delta") ? [row] : []));
			assert.strictEqual(rows.length, 2);
			for (const row of rows) {
				terminal.sendInput(press(2, row));
				terminal.sendInput(release(2, row));
			}
			assert.deepStrictEqual(chosen, ["dialog:delta"]);
		} finally {
			tui.stop();
		}
	});

	it("a cropped component still receives wheel coordinates relative to its visible box (#5532)", async () => {
		const terminal = new VirtualTerminal(30, 2);
		const tui = new TuiAltScreen(terminal);
		const turns: number[][] = [];
		const component: Component = {
			render: () => ["Alpha", "Bravo", "Charlie", `${CURSOR_MARKER}Search`],
			invalidate() {},
			handleMouse(event) {
				if (event.type !== "wheel") return undefined;
				turns.push([event.y, event.height]);
				return { handled: true };
			},
		};
		tui.setLayoutRoot(new VStack([{ component, basis: 2 }]));
		tui.setFocus(component);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[0]!, /Charlie/);
			terminal.sendInput(wheelDown(3, 0));
			assert.deepStrictEqual(turns, [[0, 2]]);
		} finally {
			tui.stop();
		}
	});

	it("a clipped inline picker clicks the painted row, not the row above the clip", async () => {
		const terminal = new VirtualTerminal(30, 2);
		const picker = new Container();
		const tui = new TuiAltScreen(terminal, undefined, undefined, { getInlineDialog: () => picker });
		const choices = letters();
		const chosen: string[] = [];
		choices.onSelect = (item) => chosen.push(item.value);
		picker.addChild(choices);
		picker.addChild(new Text(`${CURSOR_MARKER}Search`, 0, 0));
		tui.setLayoutRoot(new VStack([{ component: picker, basis: 2 }]));
		tui.setFocus(choices);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[0]!, /echo/);
			terminal.sendInput(press(3, 0));
			terminal.sendInput(release(3, 0));
			assert.deepStrictEqual(chosen, ["echo"]);
		} finally {
			tui.stop();
		}
	});

	it("a focused dialog blocks links behind it but lets a link in the dialog open", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
		const link = (name: string) =>
			new Text(`\x1b]8;;https://example.invalid/${name}\x1b\\${name}\x1b]8;;\x1b\\`, 0, 0);
		tui.addChild(link("background"));
		tui.start();
		try {
			tui.showOverlay(link("dialog"), { anchor: "bottom-left", width: 10 });
			await terminal.waitForRender();
			for (const row of [0, 11]) {
				terminal.sendInput(press(2, row));
				terminal.sendInput(release(2, row));
			}
			assert.deepStrictEqual(opened, ["https://example.invalid/dialog"]);
		} finally {
			tui.stop();
		}
	});

	it("a modal opened by the release handler removes the pending link activation", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
		tui.addChild({
			render: () => ["\x1b]8;;https://example.invalid/background\x1b\\link\x1b]8;;\x1b\\"],
			invalidate() {},
			handleMouse(event) {
				if (event.type === "release") tui.showOverlay(new Text("Confirm?", 0, 0));
				return undefined;
			},
		});
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput(press(1, 0));
			terminal.sendInput(release(1, 0));
			assert.deepStrictEqual(opened, []);
		} finally {
			tui.stop();
		}
	});

	it("a dialog takes clicks away from a lower overlay before the dialog's first paint", async () => {
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const view = await mount(list);
		try {
			const row = view.rowOf("delta");
			view.tui.showOverlay(new Text("Confirm?", 0, 0), { anchor: "bottom-right", width: 10 });
			await view.click(row);
			assert.deepStrictEqual(chosen, []);
		} finally {
			view.tui.stop();
		}
	});

	it("a press outside a focused dialog that closes before the release runs nothing behind it", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const list = letters();
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		tui.addChild(list);
		tui.setFocus(list);
		tui.start();
		const dialog = tui.showOverlay(new Text("Stop everything?", 0, 0), { anchor: "bottom-right", width: 18 });
		await terminal.waitForRender();
		const row = terminal.getViewport().findIndex((line) => line.includes("delta"));
		assert.notStrictEqual(row, -1, terminal.getViewport().join("\n"));

		terminal.sendInput(press(4, row));
		dialog.hide();
		await terminal.waitForRender();
		terminal.sendInput(release(4, row));
		await terminal.waitForRender();

		assert.deepStrictEqual(chosen, []);
		tui.stop();
	});

	it("a list under an overlay shown without taking focus still runs a click on its rows", async () => {
		const view = await listUnderDialog(true);

		await view.click(view.rowOf("delta"), 4);
		assert.deepStrictEqual(view.chosen, ["delta"]);
		view.tui.stop();
	});

	it("one click transfers focus between navigation panes, but a confirmation still blocks that transfer", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const base = letters();
		const panel = letters();
		const chosen: string[] = [];
		base.onSelect = (item) => chosen.push(`base:${item.value}`);
		panel.onSelect = (item) => chosen.push(`panel:${item.value}`);
		tui.addChild(base);
		tui.setFocus(base);
		tui.start();
		try {
			tui.showOverlay(panel, { anchor: "bottom-right", width: 15, modal: false });
			await terminal.waitForRender();
			assert.strictEqual(tui.getFocusedComponent(), panel);
			const click = (x: number, y: number) => {
				terminal.sendInput(press(x, y));
				terminal.sendInput(release(x, y));
			};
			click(3, 1);
			assert.deepEqual(chosen, ["base:bravo"]);
			assert.strictEqual(tui.getFocusedComponent(), base);
			click(32, 9);
			assert.deepEqual(chosen, ["base:bravo", "panel:charlie"]);
			assert.strictEqual(tui.getFocusedComponent(), panel);
			const confirm = new Text("Proceed?", 0, 0);
			tui.showOverlay(confirm, { anchor: "bottom-left", width: 10 });
			click(3, 2);
			assert.deepEqual(chosen, ["base:bravo", "panel:charlie"]);
			assert.strictEqual(tui.getFocusedComponent(), confirm);
		} finally {
			tui.stop();
		}
	});

	it("a second dialog opened and closed during the pane's focus transfer still cancels the first click", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const composer = new Text("compose", 0, 0);
		const pane = letters();
		let installed = false;
		Object.defineProperty(pane, "focused", {
			get: () => tui.getFocusedComponent() === pane,
			set: (value: boolean) => {
				if (value && !installed) {
					installed = true;
					tui.showOverlay(new Text("Confirm?", 0, 0)).hide();
				}
			},
		});
		const picked: string[] = [];
		pane.onSelect = (item) => picked.push(item.value);
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.start();
		try {
			tui.showOverlay(pane, { anchor: "top-left", width: 20, nonCapturing: true });
			await terminal.waitForRender();
			terminal.sendInput(press(3, 1));
			terminal.sendInput(release(3, 1));
			assert.ok(installed);
			assert.deepStrictEqual(picked, []);
		} finally {
			tui.stop();
		}
	});

	for (const claim of ["press", "release"] as const)
		it(`a picker taking focus on its own ${claim} acts on the first click`, async () => {
			const terminal = new VirtualTerminal(40, 12);
			const tui = new TuiAltScreen(terminal);
			const composer = new Text("compose", 0, 0);
			const received: string[] = [];
			const pane: Component = {
				render: () => ["pick"],
				invalidate() {},
				handleInput() {},
				handleMouse(event) {
					if (event.type === "press") return { handled: true, capture: true, focus: claim === "press" };
					if (event.type === "release" && claim === "release") return { handled: true, focus: true };
					if (event.type === "click" && event.button === "left" && tui.getFocusedComponent() === pane)
						received.push("picked");
					return undefined;
				},
			};
			tui.addChild(composer);
			tui.setFocus(composer);
			tui.start();
			try {
				const handle = tui.showOverlay(pane, { anchor: "bottom-right", width: 10 });
				handle.unfocus({ target: composer });
				await terminal.waitForRender();
				terminal.sendInput(press(34, 11));
				terminal.sendInput(claim === "press" ? release(34, 11) : "\x1b[<3;35;12m");
				assert.deepStrictEqual(received, ["picked"]);
			} finally {
				tui.stop();
			}
		});

	for (const capture of [false, true]) {
		it(`behind a new modal, a ${capture ? "captured" : "non-captured"} press cannot click or take focus`, async (t) => {
			const terminal = new VirtualTerminal(40, 12);
			const tui = new TuiAltScreen(terminal);
			const received: string[] = [];
			tui.addChild({
				render: () => ["button"],
				invalidate() {},
				handleMouse(event) {
					received.push(event.type);
					return { handled: true, capture: capture && event.type === "press", focus: event.type === "release" };
				},
			});
			tui.start();
			t.after(() => tui.stop());
			await terminal.waitForRender();
			terminal.sendInput(press(2, 0));
			const modal = new Text("Confirm?", 0, 0);
			tui.showOverlay(modal);
			terminal.sendInput("\x1b[<32;3;1M");
			terminal.sendInput(release(2, 0));
			assert.deepStrictEqual(received, capture ? ["press", "release"] : ["press"]);
			assert.strictEqual(tui.getFocusedComponent(), modal);
		});
	}

	it("a dialog shown between the press and the release takes the click away from what was pressed outside it", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const clicks: string[] = [];
		const button: Component = {
			render: () => ["[ run ]"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "click") clicks.push("run");
				return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
			},
		};
		tui.addChild(button);
		tui.setFocus(button);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(press(2, 0));
		tui.showOverlay(new Text("Stop everything?", 0, 0), { anchor: "bottom-right", width: 20 });
		await terminal.waitForRender();
		terminal.sendInput(release(2, 0));
		await terminal.waitForRender();

		assert.deepStrictEqual(clicks, []);
		terminal.sendInput(press(2, 0));
		terminal.sendInput(release(2, 0));
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, []);
		tui.stop();
	});
});
