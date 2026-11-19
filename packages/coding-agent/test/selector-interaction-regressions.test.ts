import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { navActionText } from "../src/modes/interactive/components/nav-keys.js";
import {
	fitHintEntries,
	PLAIN_SELECTOR_STYLE,
	Selector,
	type SelectorItem,
} from "../src/modes/interactive/components/selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

let previousKeys: ReturnType<typeof getKeybindings>;

beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(previousKeys);
	initTheme("dark");
});

function plain(line: string): string {
	return stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, ""));
}

function hint(lines: string[]): string {
	return plain(lines.at(-1) ?? "").trim();
}

function mouseEvent(
	type: TuiMouseEvent["type"],
	y: number,
	width = 80,
	height = 20,
	extra: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

function makeItems(ids: readonly string[]): SelectorItem<string>[] {
	return ids.map((id) => ({ id, value: id, label: id }));
}

describe("selector interaction and rendering regressions (#5237)", () => {
	test("refreshing an unchanged catalog keeps the selected row in the same part of the window (#5693)", () => {
		const open = () =>
			new Selector({
				items: makeItems(Array.from({ length: 30 }, (_, i) => `row-${i}`)),
				style: PLAIN_SELECTOR_STYLE,
			});
		const previous = open();
		for (let i = 0; i < 16; i++) previous.handleInput(DOWN);
		for (let i = 0; i < 4; i++) previous.handleInput(UP);
		const before = previous.render(80);
		assert.ok(before.some((row) => row.includes("↑ 7 more")));
		const next = open();
		next.restoreNavigation(previous, true);
		assert.deepEqual(next.render(80), before);
	});

	test("closes single and multi pickers after the first selection, confirmation, or cancel while keeping toggle pickers open (#5237)", () => {
		const selected: string[] = [];
		const cancelled: number[] = [];
		const single = new Selector<string>({
			items: makeItems(["a", "b", "c"]),
			numbered: true,
			style: PLAIN_SELECTOR_STYLE,
			onSelect: (item) => selected.push(item.id),
			onCancel: () => cancelled.push(1),
		});

		single.handleInput(DOWN);
		single.handleInput(ENTER);
		single.handleInput(UP);
		single.handleInput(ENTER);
		single.handleInput("3");
		single.handleInput(ESC);
		assert.deepEqual(selected, ["b"]);
		assert.deepEqual(cancelled, []);

		const confirmed: string[][] = [];
		const multi = new Selector<string>({
			items: makeItems(["a", "b"]),
			mode: "multi",
			style: PLAIN_SELECTOR_STYLE,
			onConfirm: (items) => confirmed.push(items.map((item) => item.id)),
			onCancel: () => cancelled.push(2),
		});
		multi.handleInput(" ");
		multi.handleInput(ENTER);
		multi.handleInput(DOWN);
		multi.handleInput(" ");
		multi.handleInput(ENTER);
		assert.deepEqual(confirmed, [["a"]]);

		const toggled: string[] = [];
		const togglePicker = new Selector<string>({
			items: makeItems(["a", "b"]),
			confirmLabel: "toggle",
			closeOnSelect: false,
			style: PLAIN_SELECTOR_STYLE,
			onSelect: (item) => toggled.push(item.id),
			onCancel: () => cancelled.push(3),
		});
		togglePicker.handleInput(ENTER);
		togglePicker.handleInput(DOWN);
		togglePicker.handleInput(ENTER);
		togglePicker.handleInput(ESC);
		togglePicker.handleInput(ENTER);
		assert.deepEqual(toggled, ["a", "b"]);
		assert.deepEqual(cancelled, [3]);
	});

	test.each([true, false])("numbered picks respect closeOnSelect=%s (#5224)", (closeOnSelect) => {
		const selected: string[] = [];
		const picker = new Selector<string>({
			items: makeItems(["Yes", "No"]),
			numbered: true,
			closeOnSelect,
			style: PLAIN_SELECTOR_STYLE,
			onSelect: (item) => selected.push(item.id),
		});
		for (const key of ["1", "1", "2"]) picker.handleInput(key);
		assert.deepEqual(selected, closeOnSelect ? ["Yes"] : ["Yes", "Yes", "No"]);
	});

	test("keeps role-based confirm and cancel hints on narrow widths when extra keys use clear or custom labels (#5237)", () => {
		const noop = () => {};
		const scopedLike = new Selector<string>({
			items: makeItems(["m1", "m2"]),
			search: true,
			confirmLabel: "toggle",
			style: PLAIN_SELECTOR_STYLE,
			extraKeys: [
				{ hint: { action: "app.models.enableAll", label: "all" }, run: noop },
				{ hint: { action: "app.models.clearAll", label: "clear" }, run: noop },
				{ hint: { action: "app.models.toggleProvider", label: "provider" }, run: noop },
				{ hint: { keys: "alt+↑/alt+↓", label: "reorder" }, run: noop },
			],
		});

		for (const width of [27, 34, 41]) {
			const line = hint(scopedLike.render(width));
			assert.ok(line.includes("enter toggle"), line);
			assert.ok(line.includes("esc cancel"), line);
		}
		for (const width of [42, 50, 54]) {
			assert.equal(hint(scopedLike.render(width)), "enter toggle · ctrl+a all · esc cancel");
		}

		scopedLike.handleInput("m");
		for (const width of [30, 35, 40]) {
			const line = hint(scopedLike.render(width));
			assert.ok(line.includes("enter toggle"), line);
			assert.ok(line.includes("esc clear"), line);
		}

		for (const confirmLabel of ["select", "pick", "preview", "keys"]) {
			const custom = new Selector<string>({
				items: makeItems(["a", "b"]),
				numbered: true,
				confirmLabel,
				cancelLabel: "back",
				onPreview: noop,
				style: PLAIN_SELECTOR_STYLE,
				extraKeys: [{ hint: { keys: "ctrl+x", label: "clear" }, run: noop }],
			});
			assert.equal(hint(custom.render(28)), `enter ${confirmLabel} · esc back`);
			custom.handleInput("?");
			assert.ok(
				custom
					.render(80)
					.map(plain)
					.some((line) => new RegExp(`enter\\s+${confirmLabel}`).test(line)),
				`missing confirm action in help for ${confirmLabel}`,
			);
		}

		for (const extraLabel of ["to search", "keys", "pick", "preview", "select"]) {
			const withCollision = new Selector<string>({
				items: makeItems(["a", "b"]),
				search: true,
				confirmLabel: "toggle",
				style: PLAIN_SELECTOR_STYLE,
				extraKeys: [
					{ hint: { keys: "ctrl+a", label: extraLabel }, run: noop },
					{ hint: { keys: "ctrl+p", label: "provider" }, run: noop },
				],
			});
			const roomForOneExtra = `enter toggle · ctrl+a ${extraLabel} · esc cancel`.length + 2;
			assert.equal(hint(withCollision.render(roomForOneExtra)), `enter toggle · ctrl+a ${extraLabel} · esc cancel`);

			const trailingCollision = new Selector<string>({
				items: makeItems(["a", "b"]),
				search: true,
				confirmLabel: "toggle",
				style: PLAIN_SELECTOR_STYLE,
				extraKeys: [
					{ hint: { keys: "ctrl+a", label: "all" }, run: noop },
					{ hint: { keys: "ctrl+p", label: extraLabel }, run: noop },
				],
			});
			const roomForFirstExtra = "enter toggle · ctrl+a all · esc cancel".length + 2;
			assert.equal(hint(trailingCollision.render(roomForFirstExtra)), "enter toggle · ctrl+a all · esc cancel");
		}

		const defaultPreview = new Selector<string>({
			items: makeItems(["a", "b", "c"]),
			onPreview: noop,
			style: PLAIN_SELECTOR_STYLE,
		});
		const customPreview = new Selector<string>({
			items: makeItems(["a", "b", "c"]),
			onPreview: noop,
			previewLabel: "details",
			style: PLAIN_SELECTOR_STYLE,
		});
		const collidingPreview = new Selector<string>({
			items: makeItems(["a", "b", "c"]),
			onPreview: noop,
			previewLabel: "select",
			style: PLAIN_SELECTOR_STYLE,
		});
		for (let width = 39; width <= 54; width += 1) {
			assert.equal(hint(defaultPreview.render(width)), "↑↓ select · enter choose · esc cancel");
			assert.equal(hint(customPreview.render(width)), hint(defaultPreview.render(width)));
		}
		for (const width of [39, 43, 48, 53]) {
			assert.equal(hint(collidingPreview.render(width)), "↑↓ select · enter choose · esc cancel");
		}
		for (const width of [27, 33, 38]) {
			assert.equal(hint(defaultPreview.render(width)), "enter choose · esc cancel");
			assert.equal(hint(customPreview.render(width)), hint(defaultPreview.render(width)));
			assert.equal(hint(collidingPreview.render(width)), hint(defaultPreview.render(width)));
		}
	});

	test("ignores a mouse release when the pressed row shifted or disappeared during the hold (#5237)", () => {
		const selected: string[] = [];
		const selector = new Selector<string>({
			items: makeItems(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]),
			maxVisible: 5,
			style: PLAIN_SELECTOR_STYLE,
			onSelect: (item) => selected.push(item.id),
		});

		let lines = selector.render(80);
		const rowY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		assert.ok(rowY >= 0);

		selector.handleMouse(mouseEvent("press", rowY, 80, lines.length));
		selector.setItems(
			makeItems(["openai/gpt-4.1-mini", "openai/gpt-4.1", "openai/gpt-4o", "anthropic/claude-sonnet-4-5"]),
		);
		lines = selector.render(80);
		selector.handleMouse(mouseEvent("click", rowY, 80, lines.length));
		assert.deepEqual(selected, []);

		const shiftedY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		selector.handleMouse(mouseEvent("press", shiftedY, 80, lines.length));
		selector.setItems(
			makeItems([
				"m1",
				"m2",
				"m3",
				"m4",
				"m5",
				"m6",
				"m7",
				"m8",
				"m9",
				"m10",
				"anthropic/claude-opus-5",
				"m12",
				"openai/gpt-4o",
			]),
		);
		lines = selector.render(80);
		selector.handleMouse(mouseEvent("click", shiftedY, 80, lines.length));
		assert.deepEqual(selected, []);

		const currentY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		selector.handleMouse(mouseEvent("press", currentY, 80, lines.length));
		selector.setItems(makeItems(["openai/gpt-4o-2024-05-13", "anthropic/claude-sonnet-4-5"]));
		lines = selector.render(80);
		selector.handleMouse(mouseEvent("click", 0, 80, lines.length));
		assert.deepEqual(selected, []);
	});

	test("resolves mouse press and click against the row id painted on the last frame when items change before re-render (#5237)", () => {
		const chosen: string[] = [];
		const selector = new Selector<string>({
			items: makeItems(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]),
			maxVisible: 5,
			style: PLAIN_SELECTOR_STYLE,
			closeOnSelect: false,
			onSelect: (item) => chosen.push(item.id),
		});

		let lines = selector.render(80);
		let paintedY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		assert.ok(paintedY >= 0);

		selector.setItems(
			makeItems(["openai/gpt-4.1-mini", "openai/gpt-4.1", "openai/gpt-4o", "anthropic/claude-sonnet-4-5"]),
		);
		selector.handleMouse(mouseEvent("press", paintedY, 80, lines.length));
		selector.handleMouse(mouseEvent("click", paintedY, 80, lines.length));
		assert.deepEqual(chosen, ["openai/gpt-4o"]);

		lines = selector.render(80);
		paintedY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		assert.ok(paintedY >= 0);
		selector.setItems(
			makeItems([
				"anthropic/claude-haiku-4-5-20251001",
				"m2",
				"m3",
				"m4",
				"m5",
				"m6",
				"m7",
				"m8",
				"m9",
				"m10",
				"m11",
				"m12",
				"openai/gpt-4o",
			]),
		);
		selector.handleMouse(mouseEvent("press", paintedY, 80, lines.length));
		selector.handleMouse(mouseEvent("click", paintedY, 80, lines.length));
		assert.deepEqual(chosen, ["openai/gpt-4o", "openai/gpt-4o"]);

		lines = selector.render(80);
		paintedY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		assert.ok(paintedY >= 0);
		selector.setItems(makeItems(["openai/gpt-4o-2024-05-13", "anthropic/claude-sonnet-4-5"]));
		selector.handleMouse(mouseEvent("press", paintedY, 80, lines.length));
		selector.handleMouse(mouseEvent("click", paintedY, 80, lines.length));
		assert.deepEqual(chosen, ["openai/gpt-4o", "openai/gpt-4o"]);

		selector.setItems(makeItems(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]));
		lines = selector.render(80);
		paintedY = lines.findIndex((line) => plain(line).includes("openai/gpt-4o"));
		assert.ok(paintedY >= 0);
		selector.setItems([
			{ id: "openai/gpt-4o", value: "openai/gpt-4o", label: "openai/gpt-4o", disabled: true },
			{
				id: "anthropic/claude-sonnet-4-5",
				value: "anthropic/claude-sonnet-4-5",
				label: "anthropic/claude-sonnet-4-5",
			},
		]);
		selector.handleMouse(mouseEvent("press", paintedY, 80, lines.length));
		selector.handleMouse(mouseEvent("click", paintedY, 80, lines.length));
		assert.deepEqual(chosen, ["openai/gpt-4o", "openai/gpt-4o"]);
	});

	test("handles mouse press and click when a wrapper forwards a mouse event wider than the rendered selector (#5237)", () => {
		for (const [wrapWidth, innerWidth] of [
			[80, 80],
			[80, 76],
		] as const) {
			const chosen: string[] = [];
			const selector = new Selector<string>({
				items: makeItems(["a", "b", "c"]),
				style: PLAIN_SELECTOR_STYLE,
				onSelect: (item) => chosen.push(item.id),
			});
			const lines = selector.render(innerWidth);
			const targetY = lines.findIndex((line) => plain(line).includes(" c"));
			assert.ok(targetY >= 0);

			const pressResult = selector.handleMouse(mouseEvent("press", targetY, wrapWidth, lines.length));
			const clickResult = selector.handleMouse(mouseEvent("click", targetY, wrapWidth, lines.length));
			assert.deepEqual(pressResult, { handled: true, focus: true });
			assert.deepEqual(clickResult, { handled: true });
			assert.deepEqual(chosen, ["c"]);
		}
	});

	test("does not reserve tag space or cut a fitting label when a tag has zero visible width (#5237)", () => {
		for (const tag of ["\u200b", "\u0301", "\x1b[0m", ""]) {
			const selector = new Selector<string>({
				items: [{ id: "a", value: "a", label: "abcdef", tag }],
				style: PLAIN_SELECTOR_STYLE,
			});
			assert.equal(plain(selector.render(10)[0] ?? "").trimEnd(), " ❯ abcdef");
		}
	});

	test("drops narrow tags that would render as a bare ellipsis while keeping short whole tags and 4-column prefixes (#5237)", () => {
		const loginLike = new Selector<string>({
			items: [{ id: "anthropic", value: "anthropic", label: "Anthropic · subscription", tag: "subscription" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		for (const width of [31, 32, 33]) {
			assert.equal(plain(loginLike.render(width)[0] ?? "").trimEnd(), " ❯ Anthropic · subscription");
		}
		assert.equal(plain(loginLike.render(34)[0] ?? "").trimEnd(), " ❯ Anthropic · subscription  s...");

		const modelLike = new Selector<string>({
			items: [{ id: "gpt-4o", value: "gpt-4o", label: "openai/gpt-4o", mark: "on", tag: "current" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		for (const width of [22, 23, 24]) {
			assert.equal(plain(modelLike.render(width)[0] ?? "").trimEnd(), " ❯ ● openai/gpt-4o");
		}
		assert.equal(plain(modelLike.render(25)[0] ?? "").trimEnd(), " ❯ ● openai/gpt-4o  c...");

		const shortTag = new Selector<string>({
			items: [{ id: "gpt-4o", value: "gpt-4o", label: "openai/gpt-4o", tag: "on" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		assert.equal(plain(shortTag.render(20)[0] ?? "").trimEnd(), " ❯ openai/gpt-4o");
		assert.equal(plain(shortTag.render(21)[0] ?? "").trimEnd(), " ❯ openai/gpt-4o  on");

		const emojiTag = new Selector<string>({
			items: [{ id: "a", value: "a", label: "x", tag: "🔒 locked" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		assert.equal(plain(emojiTag.render(11)[0] ?? "").trimEnd(), " ❯ x");
		assert.equal(plain(emojiTag.render(12)[0] ?? "").trimEnd(), " ❯ x  🔒...");

		const cjkTag = new Selector<string>({
			items: [{ id: "a", value: "a", label: "x", tag: "日本語" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		assert.equal(plain(cjkTag.render(11)[0] ?? "").trimEnd(), " ❯ x");
		assert.equal(plain(cjkTag.render(12)[0] ?? "").trimEnd(), " ❯ x  日...");

		const tabTag = new Selector<string>({
			items: [{ id: "a", value: "a", label: "x", tag: "\tlocked" }],
			style: PLAIN_SELECTOR_STYLE,
		});
		for (const width of [11, 12]) {
			assert.equal(plain(tabTag.render(width)[0] ?? "").trimEnd(), " ❯ x");
		}
		assert.equal(plain(tabTag.render(13)[0] ?? "").trimEnd(), " ❯ x  \t...");
	});

	test("notifies onSelectionChange only when the selected row id changes across all input paths (#5237)", () => {
		const changes: Array<string | undefined> = [];
		const selector = new Selector<string>({
			items: makeItems(["alpha", "beta", "gamma"]),
			search: true,
			style: PLAIN_SELECTOR_STYLE,
			onSelectionChange: (item) => changes.push(item?.id),
		});

		selector.setQuery("alp");
		assert.deepEqual(changes, []);
		selector.clearSearch();
		assert.deepEqual(changes, []);

		selector.setQuery("bet");
		assert.deepEqual(changes, ["beta"]);
		selector.clearSearch();
		assert.deepEqual(changes, ["beta"]);

		selector.setQuery("zzz");
		assert.deepEqual(changes, ["beta", undefined]);
		selector.clearSearch();
		assert.deepEqual(changes, ["beta", undefined, "alpha"]);

		selector.setItems(makeItems(["alpha", "beta", "gamma"]));
		assert.deepEqual(changes, ["beta", undefined, "alpha"]);
		selector.setItems(makeItems(["delta", "epsilon"]));
		assert.deepEqual(changes, ["beta", undefined, "alpha", "delta"]);
		selector.setItems(makeItems(["alpha", "beta", "gamma"]), "alpha");
		assert.deepEqual(changes, ["beta", undefined, "alpha", "delta", "alpha"]);

		const lines = selector.render(80);
		const betaY = lines.findIndex((line) => plain(line).includes("beta"));
		selector.handleMouse(mouseEvent("press", betaY, 80, lines.length));
		assert.deepEqual(changes, ["beta", undefined, "alpha", "delta", "alpha", "beta"]);

		const singleEnabled = new Selector<string>({
			items: [
				{ id: "only", value: "only", label: "only" },
				{ id: "disabled", value: "disabled", label: "disabled", disabled: true },
			],
			style: PLAIN_SELECTOR_STYLE,
			onSelectionChange: (item) => changes.push(`single:${item?.id}`),
		});
		singleEnabled.handleMouse(mouseEvent("wheel", 0, 80, 10, { wheelDelta: 1 }));
		assert.deepEqual(changes, ["beta", undefined, "alpha", "delta", "alpha", "beta"]);

		const multiChanges: Array<string | undefined> = [];
		const numberedMulti = new Selector<string>({
			items: makeItems(["one", "two", "three"]),
			mode: "multi",
			numbered: true,
			style: PLAIN_SELECTOR_STYLE,
			onSelectionChange: (item) => multiChanges.push(item?.id),
		});
		numberedMulti.handleInput("1");
		assert.deepEqual(multiChanges, []);
		numberedMulti.handleInput("2");
		assert.deepEqual(multiChanges, ["two"]);
		numberedMulti.handleInput("2");
		assert.deepEqual(multiChanges, ["two"]);
	});

	test("a selection callback can refresh rows without notifying itself again (#5237)", () => {
		const changes: string[] = [];
		const rows = makeItems(["alpha", "beta", "gamma"]);
		const selector = new Selector<string>({
			items: rows,
			style: PLAIN_SELECTOR_STYLE,
			onSelectionChange: (item) => {
				changes.push(item?.id ?? "none");
				if (changes.length < 3) selector.setItems([...rows]);
			},
		});

		selector.handleInput("\x1b[B");
		assert.deepEqual(changes, ["beta"]);
		assert.equal(selector.getSelected()?.id, "beta");
	});

	test("clips rendered lines to the terminal width when escape codes split graphemes or tabs precede marks (#5237)", () => {
		const splitKeycaps = "1\x1b[31m\ufe0f\u20e3".repeat(10);
		const tabCombining = "\t\u0301".repeat(10);
		const tabSpacing = "\t\u0903".repeat(10);
		const selector = new Selector<string>({
			title: splitKeycaps,
			items: [
				{ id: "keycaps", value: "keycaps", label: splitKeycaps },
				{ id: "tab-comb", value: "tab-comb", label: tabCombining },
				{ id: "tab-spac", value: "tab-spac", label: tabSpacing },
			],
		});

		for (const showingHelp of [false, true]) {
			if (showingHelp) selector.handleInput("?");
			for (const width of [12, 20, 30]) {
				for (const line of selector.render(width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`width ${width} exceeded by visibleWidth ${visibleWidth(line)}: ${JSON.stringify(line)}`,
					);
				}
			}
		}
	});

	test("refreshes focus-sensitive hints and notices, preserves label margin and non-essential extra confirm roles, and handles search digits and multi-select clicks (#5237)", () => {
		const rows = makeItems(["alpha", "kappa"]);
		let focusSelector!: Selector<string>;
		focusSelector = new Selector<string>({
			items: rows,
			style: PLAIN_SELECTOR_STYLE,
			extraKeys: [{ hint: { keys: "ctrl+x", label: "copy" }, enabled: () => focusSelector.focused, run: () => {} }],
		});
		assert.ok(!focusSelector.render(80).join("\n").includes("copy"));
		focusSelector.focused = true;
		assert.ok(focusSelector.render(80).join("\n").includes("copy"));

		focusSelector.setNotice({ text: "fresh notice", tone: "muted" });
		assert.ok(focusSelector.render(80).join("\n").includes("fresh notice"));

		const longLabel = "abcdefghijklmnopqrstuvwxyz";
		const marginSelector = new Selector<string>({
			items: [{ id: "long", value: "long", label: longLabel }],
			style: PLAIN_SELECTOR_STYLE,
		});
		assert.equal(
			marginSelector.render(12).find((line) => line.startsWith(" ❯ ")),
			` ❯ ${truncateToWidth(longLabel, 8)}`,
		);

		const kb = getKeybindings();
		const room =
			`${navActionText(kb, "tui.select.confirm")} choose · ${navActionText(kb, "tui.select.cancel")} cancel`.length;
		const fitted = fitHintEntries(
			[
				{ action: "tui.select.confirm", label: "choose", role: "confirm" },
				{ action: "tui.select.confirm", label: "copy", role: "extra" },
				{ action: "tui.select.cancel", label: "cancel", role: "cancel" },
			],
			room,
			kb,
		);
		assert.deepEqual(
			fitted.map((entry) => entry.label),
			["choose", "cancel"],
		);

		let numberedSelected = false;
		const numberedSearch = new Selector<string>({
			items: rows,
			search: true,
			numbered: true,
			style: PLAIN_SELECTOR_STYLE,
			onSelect: () => {
				numberedSelected = true;
			},
		});
		numberedSearch.handleInput("k");
		assert.equal(numberedSearch.state.getQuery(), "k");
		numberedSearch.clearSearch();
		numberedSearch.handleInput("2");
		assert.equal(numberedSelected, false);
		assert.equal(numberedSearch.state.getQuery(), "2");

		let confirmations = 0;
		const multiMouse = new Selector<string>({
			items: rows,
			mode: "multi",
			style: PLAIN_SELECTOR_STYLE,
			onConfirm: () => {
				confirmations++;
			},
		});
		const multiLines = multiMouse.render(80);
		const alphaY = multiLines.findIndex((line) => plain(line).includes("alpha"));
		multiMouse.handleMouse(mouseEvent("press", alphaY, 80, multiLines.length));
		multiMouse.handleMouse(mouseEvent("click", alphaY, 80, multiLines.length));
		assert.equal(confirmations, 0);
		assert.deepEqual(
			multiMouse.state.getChecked().map((item) => item.id),
			["alpha"],
		);

		kb.setUserBindings({ "tui.select.cancel": ["escape", "ctrl+c", "ctrl+shift+c"] });
		let cancelled = false;
		const customCancel = new Selector<string>({
			items: rows,
			search: true,
			style: PLAIN_SELECTOR_STYLE,
			onCancel: () => {
				cancelled = true;
			},
		});
		customCancel.handleInput("al");
		customCancel.handleInput("\x1b[99;6u");
		assert.equal(cancelled, false);
		assert.equal(customCancel.state.getQuery(), "");

		for (const ctrlC of ["\x03", "\x1b[99;5u", "\x1b[1089::99;5u", "\x1b[27;5;99~"]) {
			let helpCancelled = 0;
			const withHelp = new Selector<string>({
				title: "Models",
				items: rows,
				style: PLAIN_SELECTOR_STYLE,
				onCancel: () => {
					helpCancelled++;
				},
			});
			withHelp.handleInput("?");
			assert.ok(withHelp.render(80).some((line) => plain(line).includes("close this help")));
			withHelp.handleInput(ctrlC);
			assert.equal(helpCancelled, 1);
		}
	});
});
