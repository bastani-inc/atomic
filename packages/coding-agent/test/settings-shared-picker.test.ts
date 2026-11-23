import assert from "node:assert/strict";
import type { SettingItem } from "@bastani/atomic-tui";
import { setKeybindings, stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PLAIN_SELECTOR_STYLE, Selector } from "../src/modes/interactive/components/selector.js";
import { SettingsPicker } from "../src/modes/interactive/components/settings-picker.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-selector-submenus.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function rows(): SettingItem[] {
	return [
		{
			id: "auto-compact",
			label: "Auto-compact",
			description: "Compact the context when it gets too large",
			currentValue: "true",
			values: ["true", "false"],
		},
		{ id: "theme", label: "Theme", description: "Color theme", currentValue: "dark", submenu: () => new Text("x") },
		...Array.from({ length: 14 }, (_, index) => ({
			id: `setting-${index}`,
			label: `Setting ${index}`,
			currentValue: "a",
			values: ["a", "b", "c"],
		})),
	];
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));

describe("/settings on the shared picker (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	for (const width of [80, 160]) {
		it(`draws a title, the search box, a value column, a description and one hint line at ${width} columns`, () => {
			const picker = new SettingsPicker(
				rows(),
				() => {},
				() => {},
				{ title: "Settings", search: true },
			);
			const out = plain(picker.render(width));
			assert.equal(out[0]?.trim(), "Settings");
			assert.ok(out.some((line) => line.includes("⌕ Search settings…")));
			assert.match(out.find((line) => line.includes("Auto-compact")) ?? "", /^ ∀ Auto-compact\s+true$/);
			assert.match(out.find((line) => line.includes("Theme")) ?? "", /^ {3}Theme\s+dark ›$/);
			assert.ok(out.some((line) => line.trim() === "↓ 6 more"));
			assert.ok(out.some((line) => line.trim() === "Compact the context when it gets too large"));
			assert.equal(out.at(-1)?.trim(), "↑↓ select · enter/space change · type to search · esc cancel");
			assert.ok(out.every((line) => line.length <= width));
			assert.ok(!out.some((line) => /\(\d+\/\d+\)/.test(line)));
		});
	}

	it("reserves the value column before shortening a label beside a right-hand tag (#5347)", () => {
		const picker = new Selector({
			items: [{ id: "value", value: "value", label: "a".repeat(100), description: "false", tag: "current" }],
			minDescriptionWidth: 6,
			style: PLAIN_SELECTOR_STYLE,
		});
		for (const width of [42, 45, 80, 160]) {
			const out = plain(picker.render(width));
			assert.match(out.find((line) => line.includes("∀")) ?? "", /false\s+current$/);
			assert.ok(out.every((line) => line.length <= width));
		}
	});

	it("uses whole finite columns for the value reservation (#5347)", () => {
		const make = (label: string, minDescriptionWidth?: number) =>
			new Selector({
				items: [{ id: "value", value: "value", label, description: "true" }],
				...(minDescriptionWidth === undefined ? {} : { minDescriptionWidth }),
				style: PLAIN_SELECTOR_STYLE,
			});
		const fallback = make("Auto-compact").render(80);
		assert.ok(fallback.some((line) => line.includes("true")));
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			assert.deepEqual(make("Auto-compact", invalid).render(80), fallback);
		}
		assert.deepEqual(make("a".repeat(100), 6.9).render(45), make("a".repeat(100), 6).render(45));
	});

	it("names what enter does for the selected row: change steps a value, open shows its picker", () => {
		const picker = new SettingsPicker(
			rows(),
			() => {},
			() => {},
			{ search: true },
		);
		picker.handleInput("\x1b[B");
		assert.match(plain(picker.render(100)).at(-1) ?? "", /enter\/space open/);
		for (const ch of "Theme") picker.handleInput(ch);
		assert.equal(plain(picker.render(100)).at(-1)?.trim(), "enter open · type to search · esc clear");
	});

	it("enter and space step a value in place and report it, and a typed space still searches", () => {
		const changes: string[] = [];
		const picker = new SettingsPicker(
			rows(),
			(id, value) => changes.push(`${id}=${value}`),
			() => {},
			{
				search: true,
			},
		);
		picker.handleInput("\r");
		assert.deepEqual(changes, ["auto-compact=false"]);
		assert.match(
			plain(picker.render(100)).find((line) => line.includes("Auto-compact")) ?? "",
			/^ ∀ Auto-compact\s+false$/,
		);
		picker.handleInput(" ");
		assert.deepEqual(changes, ["auto-compact=false", "auto-compact=true"]);
		assert.match(
			plain(picker.render(100)).find((line) => line.includes("Auto-compact")) ?? "",
			/^ ∀ Auto-compact\s+true$/,
		);
		for (const ch of "Setting 1") picker.handleInput(ch);
		assert.ok(plain(picker.render(100)).some((line) => line.includes("⌕ Setting 1")));
		assert.deepEqual(changes, ["auto-compact=false", "auto-compact=true"]);
	});

	it("keeps setting values visible at narrow widths (42-48 columns) and truncates long labels before hiding values", () => {
		const narrowRows: SettingItem[] = [
			{
				id: "auto-compact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: "true",
				values: ["true", "false"],
			},
			{
				id: "background-compaction",
				label: "Background compaction",
				currentValue: "true",
				values: ["true", "false"],
			},
			{
				id: "background-compaction-threshold",
				label: "Background compaction threshold",
				currentValue: "75",
				values: ["50", "75", "90"],
			},
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				currentValue: "none",
				submenu: () => new Text("THINKING"),
			},
			{
				id: "theme",
				label: "Theme",
				currentValue: "dark",
				submenu: () => new Text("THEME"),
			},
		];
		const picker = new SettingsPicker(
			narrowRows,
			() => {},
			() => {},
			{ title: "Settings", search: true },
		);
		for (const width of [42, 45, 48]) {
			const out = plain(picker.render(width));
			assert.ok(out.every((line) => line.length <= width));
			assert.match(out.find((line) => line.includes("Auto-compact")) ?? "", /^ ∀ Auto-compact\s+true$/);
			assert.match(out.find((line) => line.includes("Background compaction thres")) ?? "", /75$/);
			assert.match(out.find((line) => line.includes("Default thinking level")) ?? "", /none ›$/);
			assert.match(out.find((line) => line.includes("Theme")) ?? "", /^ {3}Theme\s+dark ›$/);
		}
	});

	it("ignores right arrow on value and submenu rows while enter and space still activate", () => {
		const changes: string[] = [];
		let submenuOpened = 0;
		const items = rows();
		items[1] = {
			...items[1]!,
			submenu: () => {
				submenuOpened++;
				return new Text("THEME PICKER");
			},
		};
		const picker = new SettingsPicker(
			items,
			(id, value) => changes.push(`${id}=${value}`),
			() => {},
			{ search: true },
		);
		picker.handleInput("\x1b[C");
		assert.deepEqual(changes, []);
		assert.match(
			plain(picker.render(100)).find((line) => line.includes("Auto-compact")) ?? "",
			/^ ∀ Auto-compact\s+true$/,
		);

		picker.handleInput("\x1b[B");
		picker.handleInput("\x1b[C");
		assert.equal(submenuOpened, 0);

		picker.handleInput(" ");
		assert.equal(submenuOpened, 1);
	});

	it("opens a row's picker in place, and its done value updates the row and returns to it", () => {
		const changes: string[] = [];
		let finish: ((value?: string, options?: { navigateTo?: string }) => void) | undefined;
		const items = rows();
		items[1] = {
			...items[1]!,
			submenu: (_current, done) => {
				finish = done;
				return new Text("THEME PICKER");
			},
		};
		const picker = new SettingsPicker(
			items,
			(id, value) => changes.push(`${id}=${value}`),
			() => {},
			{
				search: true,
			},
		);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		assert.ok(plain(picker.render(100)).some((line) => line.includes("THEME PICKER")));
		finish?.("light");
		const out = plain(picker.render(100));
		assert.match(out.find((line) => line.includes("Theme")) ?? "", /^ ∀ Theme\s+light ›$/);
		assert.deepEqual(changes, ["theme=light"]);

		picker.handleInput("\r");
		finish?.(undefined, { navigateTo: "auto-compact" });
		assert.deepEqual(changes, ["theme=light", "auto-compact=false"]);
	});

	it("esc clears a search before it cancels, and updateValue changes a shown value", () => {
		let cancelled = 0;
		const picker = new SettingsPicker(
			rows(),
			() => {},
			() => cancelled++,
			{ search: true },
		);
		picker.updateValue("auto-compact", "false");
		assert.match(plain(picker.render(100)).find((line) => line.includes("Auto-compact")) ?? "", /false$/);
		picker.handleInput("z");
		picker.selectItem("theme");
		assert.match(plain(picker.render(100)).find((line) => line.includes("Theme")) ?? "", /^ ∀ Theme\s+dark ›$/);
		picker.handleInput("z");
		picker.handleInput("\x1b");
		assert.equal(cancelled, 0);
		picker.handleInput("\x1b");
		assert.equal(cancelled, 1);
	});
});

describe("settings value pickers on the shared picker (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	for (const width of [80, 160]) {
		it(`marks the current value ● and the others ○, with one hint line at ${width} columns`, () => {
			const submenu = new SelectSubmenu(
				"Decision model",
				"Saves to global settings.",
				[
					{ value: "", label: "  Automatic", description: "Use the current chat model" },
					{ value: "judge/custom", label: "✓ judge/custom", description: "Judge" },
				],
				"judge/custom",
				() => {},
				() => {},
				undefined,
				true,
			);
			const out = plain(submenu.render(width));
			assert.equal(out[0]?.trim(), "Decision model");
			assert.ok(out.some((line) => line.includes("⌕ Search…")));
			assert.match(
				out.find((line) => line.includes("Automatic")) ?? "",
				/^ {3}○ Automatic\s+Use the current chat model$/,
			);
			assert.match(out.find((line) => line.includes("judge/custom")) ?? "", /^ ∀ ● judge\/custom\s+Judge$/);
			assert.equal(out.at(-1)?.trim(), "↑↓ select · enter choose · type to search · esc back");
			assert.ok(out.every((line) => line.length <= width));
		});
	}

	it("ignores right arrow in a value picker while enter chooses the highlighted option", () => {
		const chosen: string[] = [];
		const submenu = new SelectSubmenu(
			"Theme",
			"Select a theme",
			[
				{ value: "dark", label: "dark" },
				{ value: "light", label: "light" },
			],
			"light",
			(value) => chosen.push(value),
			() => {},
		);
		submenu.handleInput("\x1b[C");
		assert.deepEqual(chosen, []);
		submenu.handleInput("\r");
		assert.deepEqual(chosen, ["light"]);
	});
});
