import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TuiMouseEvent } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	PLAIN_SELECTOR_STYLE,
	Selector,
	type SelectorItem,
	type SelectorOptions,
	selectorHintEntries,
} from "../../packages/coding-agent/src/modes/interactive/components/selector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const SPACE = " ";
const BACKSPACE = "\x7f";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function items(count: number, extra: (index: number) => Partial<SelectorItem<number>> = () => ({})) {
	return Array.from({ length: count }, (_, index) => ({
		id: `id-${index}`,
		value: index,
		label: `item ${index}`,
		...extra(index),
	}));
}

function picker(options: Partial<SelectorOptions<number>> & { items: SelectorItem<number>[] }) {
	const events: string[] = [];
	const selector = new Selector<number>({
		style: PLAIN_SELECTOR_STYLE,
		onSelect: (item) => events.push(`select:${item.id}`),
		onConfirm: (chosen) => events.push(`confirm:${chosen.map((item) => item.id).join(",")}`),
		onCancel: () => events.push("cancel"),
		...options,
	});
	const text = (width = 80) => selector.render(width).map((line) => plain(line).trimEnd());
	return { selector, events, text };
}

/** Visible text: no colour and no cursor marker. */
function plain(line: string): string {
	return stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, ""));
}

/** The hint line is always the last rendered line. */
function hint(lines: string[]): string {
	return (lines.at(-1) ?? "").trim();
}

function mouseEvent(
	type: TuiMouseEvent["type"],
	y: number,
	height: number,
	extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

describe("shared selector (#5224)", () => {
	test("renders a title, rows with a marker on the selection, and one hint line", () => {
		const { text } = picker({ title: "Select theme", items: items(3) });
		const lines = text();
		assert.equal(lines[0], "  Select theme");
		assert.ok(lines.includes(" ❯ item 0"));
		assert.ok(lines.includes("   item 1"));
		assert.equal(hint(lines), "↑↓ select · enter choose · esc cancel · ? keys");
	});

	test("↑↓ wrap, skip disabled rows, and enter chooses the selected row", () => {
		const { selector, events } = picker({ items: items(4, (index) => ({ disabled: index === 1 })) });
		selector.handleInput(DOWN);
		assert.equal(selector.getSelected()?.id, "id-2");
		selector.handleInput(UP);
		assert.equal(selector.getSelected()?.id, "id-0");
		selector.handleInput(UP);
		assert.equal(selector.getSelected()?.id, "id-3");
		selector.handleInput(ENTER);
		assert.deepEqual(events, ["select:id-3"]);
	});

	test("→ opens like enter when there is no search text", () => {
		const { selector, events } = picker({ items: items(2) });
		selector.handleInput(RIGHT);
		assert.deepEqual(events, ["select:id-0"]);
	});

	test("starts on the row marked current, draws ● on it and ○ on the rest, and tags it", () => {
		const { text, selector } = picker({
			items: items(3, (index) => ({ mark: index === 2 ? "on" : "off", tag: index === 2 ? "current" : undefined })),
		});
		assert.equal(selector.getSelected()?.id, "id-2");
		const lines = text(40);
		assert.ok(lines.includes("   ○ item 0"));
		const current = lines.find((line) => line.includes("item 2")) ?? "";
		assert.match(current, /^ ❯ ● item 2 +current$/);
		assert.equal(current.length, 39, "the tag is right-aligned");
	});

	test("one-line descriptions align in a column; two-line layout puts them under the label", () => {
		const rows = [
			{ id: "a", value: 0, label: "short", description: "first" },
			{ id: "b", value: 1, label: "a longer name", description: "second" },
		];
		const one = picker({ items: rows }).text(80);
		assert.equal(
			one.find((line) => line.includes("short")),
			" ❯ short          first",
		);
		assert.equal(
			one.find((line) => line.includes("longer")),
			"   a longer name  second",
		);
		const two = picker({ items: rows, layout: "two-line" }).text(80);
		const index = two.indexOf(" ❯ short");
		assert.equal(two[index + 1], "   first");
	});

	test("type-to-search filters, esc clears the search before it cancels, and the hint follows", () => {
		const { selector, events, text } = picker({
			title: "Resume",
			search: true,
			items: [
				{ id: "a", value: 0, label: "fix login" },
				{ id: "b", value: 1, label: "ship release" },
				{ id: "c", value: 2, label: "review" },
			],
		});
		let lines = text();
		assert.ok(
			lines.some((line) => line.includes("⌕ Search…")),
			"the search box shows its placeholder",
		);
		assert.equal(hint(lines), "↑↓ select · enter choose · type to search · esc cancel");
		for (const key of "ship") selector.handleInput(key);
		lines = text();
		assert.ok(lines.some((line) => line.includes("⌕ ship")));
		assert.deepEqual(
			selector.state.getVisible().map((item) => item.id),
			["b"],
		);
		assert.equal(hint(lines), "enter choose · type to search · esc clear");
		selector.handleInput(BACKSPACE);
		assert.equal(selector.state.getQuery(), "shi");
		selector.handleInput(ESC);
		assert.equal(selector.state.getQuery(), "");
		assert.deepEqual(events, []);
		selector.handleInput(ESC);
		assert.deepEqual(events, ["cancel"]);
	});

	test("ctrl+c cancels even with search text", () => {
		const { selector, events } = picker({ search: true, items: items(2) });
		selector.handleInput("i");
		selector.handleInput(CTRL_C);
		assert.deepEqual(events, ["cancel"]);
	});

	test("a search with no match shows the empty state and no choose key", () => {
		const { selector, text } = picker({ search: true, items: items(2) });
		for (const key of "zzz") selector.handleInput(key);
		const lines = text();
		assert.ok(lines.includes('  No matches for "zzz"'));
		assert.equal(hint(lines), "type to search · esc clear");
	});

	test("an empty list shows its empty text and only the cancel key", () => {
		const { text } = picker({ items: [], emptyText: "No sessions yet" });
		const lines = text();
		assert.ok(lines.includes("  No sessions yet"));
		assert.equal(hint(lines), "esc cancel · ? keys");
	});

	test("scroll indicators count the rows above and below the window", () => {
		const { selector, text } = picker({ items: items(12), maxVisible: 4 });
		let lines = text();
		assert.ok(lines.includes("  ↓ 8 more"));
		assert.ok(!lines.some((line) => line.includes("more") && line.includes("↑")));
		for (let index = 0; index < 6; index++) selector.handleInput(DOWN);
		lines = text();
		assert.ok(lines.includes("  ↑ 3 more"));
		assert.ok(lines.includes("  ↓ 5 more"));
	});

	test("multi-select: space toggles checkboxes, enter confirms the checked rows in list order", () => {
		const { selector, events, text } = picker({ mode: "multi", items: items(3) });
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(SPACE);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(SPACE);
		const lines = text();
		assert.ok(lines.includes(" ❯ [✓] item 0"));
		assert.ok(lines.includes("   [ ] item 1"));
		assert.equal(hint(lines), "↑↓ select · space toggle · enter confirm · esc cancel · ? keys");
		selector.handleInput(ENTER);
		assert.deepEqual(events, ["confirm:id-0,id-2"]);
	});

	test("space previews when the picker has a preview, and the hint says so", () => {
		const previews: string[] = [];
		const { selector, text } = picker({ items: items(2), onPreview: (item) => previews.push(item.id) });
		assert.equal(hint(text()), "↑↓ select · space preview · enter choose · esc cancel · ? keys");
		selector.handleInput(SPACE);
		assert.deepEqual(previews, ["id-0"]);
	});

	test("numbered rows: digits choose directly when there is no search box", () => {
		const { selector, events, text } = picker({ numbered: true, items: items(3) });
		assert.ok(text().includes(" ❯ 1. item 0"));
		assert.equal(hint(text()), "↑↓ select · enter choose · 1-3 pick · esc cancel · ? keys");
		selector.handleInput("3");
		assert.deepEqual(events, ["select:id-2"]);
	});

	test("extra keys run on the selection and are hinted only where they work", () => {
		const runs: string[] = [];
		const { selector, text } = picker({
			items: items(2),
			extraKeys: [
				{
					hint: { keys: "←→", label: "effort" },
					matches: (data) => data === "\x1b[D",
					enabled: (item) => item?.id === "id-1",
					run: (item) => runs.push(item?.id ?? "none"),
				},
			],
		});
		assert.ok(!hint(text()).includes("effort"));
		selector.handleInput("\x1b[D");
		assert.deepEqual(runs, [], "a key that does nothing here does not run");
		selector.handleInput(DOWN);
		assert.ok(hint(text()).includes("←→ effort"));
		selector.handleInput("\x1b[D");
		assert.deepEqual(runs, ["id-1"]);
	});

	test("groups render section labels, but not while searching", () => {
		const { selector, text } = picker({
			search: true,
			items: [
				{ id: "a", value: 0, label: "alpha", group: "Runs" },
				{ id: "b", value: 1, label: "beta", group: "Definitions" },
			],
		});
		const lines = text();
		assert.ok(lines.includes("  Runs"));
		assert.ok(lines.includes("  Definitions"));
		selector.handleInput("b");
		assert.ok(!text().includes("  Definitions"));
	});

	test("? shows the key overlay of a picker without a search box, and esc closes only the overlay", () => {
		const { selector, events, text } = picker({ title: "Theme", items: items(2) });
		selector.handleInput("?");
		const lines = text();
		assert.ok(lines.some((line) => line.includes("Theme")));
		assert.ok(lines.some((line) => /enter\s+choose/.test(line)));
		selector.handleInput(ESC);
		assert.deepEqual(events, []);
		assert.equal(hint(text()), "↑↓ select · enter choose · esc cancel · ? keys");
	});

	test("a narrow hint keeps cancel and choose and drops the least needed keys first", () => {
		const { text } = picker({ search: true, items: items(3) });
		assert.equal(hint(text(32)), "enter choose · esc cancel");
		assert.equal(hint(text(46)), "↑↓ select · enter choose · esc cancel");
	});

	test("rows and hint fit at 80 and 160 columns, and long labels are cut, never wrapped", () => {
		const long = "x".repeat(300);
		const { text } = picker({
			title: long,
			search: true,
			items: [{ id: "a", value: 0, label: long, description: long, tag: "current" }],
		});
		for (const width of [40, 80, 160]) {
			for (const line of text(width)) assert.ok(line.length <= width, `${width}: ${line.length}`);
		}
	});

	test("every hinted key does something and every key that does something is hinted", () => {
		// Each hint entry names a key; pressing it changes state or reports an event, and a key outside the hint
		// (here: space without a preview, a digit without numbering) does nothing.
		const { selector, events } = picker({ items: items(3) });
		const entries = selectorHintEntries(selector.state, { keybindings: getKeybindings() });
		assert.deepEqual(
			entries.map((entry) => entry.label),
			["select", "choose", "cancel", "keys"],
		);
		selector.handleInput(SPACE);
		selector.handleInput("2");
		assert.deepEqual(events, []);
		assert.equal(selector.getSelected()?.id, "id-0");
	});

	test("j and k move in a picker without a search box, and are typed into one with a search box", () => {
		const plainPicker = picker({ items: items(3) });
		plainPicker.selector.handleInput("j");
		assert.equal(plainPicker.selector.getSelected()?.id, "id-1");
		plainPicker.selector.handleInput("k");
		assert.equal(plainPicker.selector.getSelected()?.id, "id-0");

		const searching = picker({ items: items(3), search: true });
		searching.selector.handleInput("j");
		assert.equal(searching.selector.state.getQuery(), "j");
	});

	test("reuses unchanged rows until invalidated and refreshes their styles (#5224)", () => {
		let paints = 0;
		let suffix = "";
		const { selector, text } = picker({
			items: items(3),
			style: {
				...PLAIN_SELECTOR_STYLE,
				text: (label) => {
					paints++;
					return label + suffix;
				},
			},
		});
		const first = text();
		assert.equal(paints, 2);
		assert.deepEqual(text(), first);
		assert.equal(paints, 2);
		suffix = "!";
		selector.invalidate();
		assert.ok(text().includes("   item 1!"));
		assert.equal(paints, 4);
	});

	test("cached renders follow public state updates and picker metadata (#5224)", () => {
		const { selector, text } = picker({ items: items(4), mode: "multi", maxVisible: 2 });
		assert.ok(text().includes(" ❯ [ ] item 0"));
		selector.state.move(1);
		assert.ok(text().includes(" ❯ [ ] item 1"));
		selector.state.page(1);
		assert.ok(text().includes(" ❯ [ ] item 3"));
		selector.state.edge("first");
		assert.ok(text().includes(" ❯ [ ] item 0"));
		selector.state.select(2);
		assert.ok(text().includes(" ❯ [ ] item 2"));
		selector.state.toggle("id-2");
		assert.ok(text().includes(" ❯ [✓] item 2"));
		selector.state.setQuery("item 1");
		assert.ok(text().includes(" ❯ [ ] item 1"));
		selector.state.setItems([{ id: "new", value: 9, label: "replacement" }]);
		assert.ok(text().some((line) => line.includes("No matches")));
		selector.state.setQuery("replacement");
		assert.ok(text().includes(" ❯ [ ] replacement"));
		selector.setTitle("Updated title");
		selector.setSubtitle("Updated subtitle");
		selector.setNotice({ text: "Updated notice", tone: "success" });
		const lines = text();
		assert.ok(lines.includes("  Updated title"));
		assert.ok(lines.includes("  Updated subtitle"));
		assert.ok(lines.includes("  Updated notice"));
	});

	test("cached renders follow direct search cursor, focus and keybinding changes (#5224)", () => {
		const { selector, text } = picker({ items: items(2), search: true });
		const input = selector.getSearchInput();
		assert.ok(input);
		const empty = selector.render(80).join("\n");
		input.setValue("item");
		const typed = selector.render(80).join("\n");
		assert.notEqual(typed, empty);
		const cursor = input.getCursor();
		input.handleInput("\x1b[C");
		assert.notEqual(input.getCursor(), cursor);
		const moved = selector.render(80).join("\n");
		assert.notEqual(moved, typed);
		input.focused = true;
		assert.notEqual(selector.render(80).join("\n"), moved);
		getKeybindings().setUserBindings({ "tui.select.confirm": "ctrl+j" });
		assert.ok(hint(text()).includes("ctrl+j choose"));
	});

	test("repaints a row's custom labelStyle without invalidate (#5224)", () => {
		let suffix = ":one";
		const { text } = picker({
			items: items(2, (index) => (index === 0 ? { labelStyle: (label) => `${label}${suffix}` } : {})),
		});
		assert.ok(text().includes(" ❯ item 0:one"));
		suffix = ":two";
		assert.ok(text().includes(" ❯ item 0:two"));
	});

	test("notifies onSelectionChange when search replaces the selected row at the same index (#5224)", () => {
		const selectedIds: Array<string | undefined> = [];
		const { selector } = picker({
			search: true,
			items: [
				{ id: "alpha", value: 0, label: "alpha" },
				{ id: "beta", value: 1, label: "beta" },
			],
			onSelectionChange: (item) => selectedIds.push(item?.id),
		});
		assert.equal(selector.getSelected()?.id, "alpha");
		selector.handleInput("b");
		assert.equal(selector.getSelected()?.id, "beta");
		assert.deepEqual(selectedIds, ["beta"]);
	});

	test("clicking a disabled row does not confirm the previously selected enabled row (#5224)", () => {
		const changes: Array<string | undefined> = [];
		const { selector, events, text } = picker({
			items: items(2, (index) => ({ disabled: index === 1 })),
			onSelectionChange: (item) => changes.push(item?.id),
		});
		const lines = text();
		const disabledY = lines.findIndex((line) => line.includes("item 1"));
		assert.ok(disabledY >= 0);
		selector.handleMouse(mouseEvent("press", disabledY, lines.length));
		selector.handleMouse(mouseEvent("click", disabledY, lines.length, { clickCount: 1 }));
		selector.handleMouse(mouseEvent("click", disabledY, lines.length, { clickCount: 1 }));
		assert.equal(selector.getSelected()?.id, "id-0");
		assert.deepEqual(events, []);
		assert.deepEqual(changes, []);
	});

	test("clicking an old row coordinate while ? help is visible does not select the hidden row (#5224)", () => {
		const { selector, events, text } = picker({ title: "Theme", items: items(3) });
		const listLines = text();
		const hiddenRowY = listLines.findIndex((line) => line.includes("item 1"));
		assert.ok(hiddenRowY >= 0);
		selector.handleInput("?");
		const helpLines = text();
		assert.ok(helpLines.some((line) => line.includes("close this help")));
		selector.handleMouse(mouseEvent("press", hiddenRowY, helpLines.length));
		selector.handleMouse(mouseEvent("click", hiddenRowY, helpLines.length, { clickCount: 1 }));
		assert.equal(selector.getSelected()?.id, "id-0");
		assert.deepEqual(events, []);
	});

	test("checkbox marks draw [✓] and [ ] in a single-select picker", () => {
		const { text } = picker({
			items: items(2, (index) => ({ mark: index === 0 ? "checked" : "unchecked" })),
		});
		const lines = text();
		assert.ok(lines.includes(" ❯ [✓] item 0"), lines.join("\n"));
		assert.ok(lines.includes("   [ ] item 1"), lines.join("\n"));
	});

	test("a row's own label style paints its label, told whether the row is selected", () => {
		const { text, selector } = picker({
			items: items(2, () => ({
				labelStyle: (label: string, selected: boolean) => (selected ? `<${label}>` : label),
			})),
		});
		assert.ok(text().includes(" ❯ <item 0>"));
		selector.handleInput(DOWN);
		assert.ok(text().includes("   item 0"));
		assert.ok(text().includes(" ❯ <item 1>"));
	});

	test("a subtitle with several lines shows each line, wrapped to the width", () => {
		const { text } = picker({
			title: "Confirm",
			subtitle: `first line\n${"word ".repeat(20).trim()}`,
			items: items(2),
		});
		const lines = text(40);
		assert.equal(lines[1], "  first line");
		const wrapped = lines.slice(2, lines.indexOf(""));
		assert.ok(wrapped.length >= 2, lines.join("\n"));
		for (const line of lines) assert.ok(line.length <= 40);
		assert.equal(wrapped.join(" ").replace(/\s+/g, " ").trim(), "word ".repeat(20).trim());
	});

	test("clearing the search starts a fresh search box, so a yank cannot restore the cleared text (#3668)", () => {
		const { selector } = picker({ items: items(2), search: true });
		for (const key of ["beta", "\x15"]) selector.handleInput(key);
		selector.handleInput("gam");
		selector.handleInput(ESC);
		assert.equal(selector.state.getQuery(), "");
		selector.handleInput("\x19");
		assert.equal(selector.state.getQuery(), "");
	});

	test("a narrow hint keeps choose under its own label and gives up a picker's own keys, last first", () => {
		const noop = () => {};
		const { text } = picker({
			items: items(3),
			search: true,
			confirmLabel: "toggle",
			extraKeys: [
				{ hint: { keys: "ctrl+a", label: "all" }, run: noop },
				{ hint: { keys: "ctrl+x", label: "clear all" }, run: noop },
				{ hint: { keys: "ctrl+p", label: "provider" }, run: noop },
			],
		});
		assert.equal(hint(text(50)), "enter toggle · ctrl+a all · esc cancel");
	});

	test("the digit hint names the digits that choose a row", () => {
		assert.match(hint(picker({ items: items(2), numbered: true }).text()), /1-2 pick/);
		assert.match(hint(picker({ items: items(12), numbered: true }).text()), /1-9 pick/);
		assert.match(hint(picker({ items: items(1), numbered: true }).text()), /1 pick/);
	});
});
