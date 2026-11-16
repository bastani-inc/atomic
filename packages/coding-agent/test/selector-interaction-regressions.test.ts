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

	test("ignores mouse press and click when the painted width differs from the mouse event width until re-rendered (#5237)", () => {
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

		container.handleMouse(mouseEvent("press", targetY, 80, painted.length));
		selector.setItems(makeItems(["x", "y", "a", "b", "c", "d", "e"]));
		container.handleMouse(mouseEvent("wheel", 0, 30, painted.length, { wheelDelta: 1 }));

		container.handleMouse(mouseEvent("press", targetY, 80, painted.length));
		container.handleMouse(mouseEvent("click", targetY, 80, painted.length));
		assert.deepEqual(chosen, []);

		const repainted = container.render(80);
		const repaintedY = repainted.findIndex((line) => plain(line).endsWith(" e"));
		assert.ok(repaintedY >= 0);
		container.handleMouse(mouseEvent("click", repaintedY, 80, repainted.length));
		assert.deepEqual(chosen, []);
		container.handleMouse(mouseEvent("press", repaintedY, 80, repainted.length));
		container.handleMouse(mouseEvent("click", repaintedY, 80, repainted.length));
		assert.deepEqual(chosen, ["e"]);
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
