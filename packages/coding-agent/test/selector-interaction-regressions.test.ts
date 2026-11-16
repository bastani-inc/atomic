import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, getKeybindings, setKeybindings, type TuiMouseEvent, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PLAIN_SELECTOR_STYLE, Selector, type SelectorItem } from "../src/modes/interactive/components/selector.js";
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

	test("re-renders row hit targets at the mouse event width after a container re-measures at another width (#5237)", () => {
		const chosen: string[] = [];
		const selector = new Selector<string>({
			title: "Pick",
			subtitle: "word ".repeat(24).trim(),
			items: makeItems(["a", "b", "c", "d", "e"]),
			style: PLAIN_SELECTOR_STYLE,
			onSelect: (item) => chosen.push(item.id),
		});
		const container = new Container();
		container.addChild(selector);

		const painted = container.render(80);
		const targetY = painted.findIndex((line) => plain(line).includes("item") || plain(line).endsWith(" e"));
		assert.ok(targetY >= 0);

		container.handleMouse(mouseEvent("wheel", 0, 30, painted.length, { wheelDelta: 1 }));

		container.handleMouse(mouseEvent("press", targetY, 80, painted.length));
		container.handleMouse(mouseEvent("click", targetY, 80, painted.length));
		assert.deepEqual(chosen, ["e"]);
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

		const lines = selector.render(80);
		const betaY = lines.findIndex((line) => plain(line).includes("beta"));
		selector.handleMouse(mouseEvent("press", betaY, 80, lines.length));
		assert.deepEqual(changes, ["beta"]);

		const singleEnabled = new Selector<string>({
			items: [
				{ id: "only", value: "only", label: "only" },
				{ id: "disabled", value: "disabled", label: "disabled", disabled: true },
			],
			style: PLAIN_SELECTOR_STYLE,
			onSelectionChange: (item) => changes.push(`single:${item?.id}`),
		});
		singleEnabled.handleMouse(mouseEvent("wheel", 0, 80, 10, { wheelDelta: 1 }));
		assert.deepEqual(changes, ["beta"]);

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
});
