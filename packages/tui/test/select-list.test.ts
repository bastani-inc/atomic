import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("moves by one visible page with selection page keys (#7629)", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
		const list = new SelectList(items, 5, testTheme);
		const selections: string[] = [];
		list.onSelectionChange = (item) => selections.push(item.value);

		for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);

		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);

		list.setFilter("no match");
		list.handleInput("\x1b[6~");
		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);
	});
});

describe("SelectList: the shared picker look (#5224)", () => {
	const items = Array.from({ length: 12 }, (_, index) => ({
		value: `/cmd${index}`,
		label: `/cmd${index}`,
		description: `command ${index}`,
	}));

	it("marks the selected row with ∀ and keeps the other rows aligned", () => {
		const rendered = new SelectList(items.slice(0, 3), 5, testTheme).render(80);
		assert.ok(rendered[0]?.startsWith("∀ /cmd0"), rendered[0]);
		assert.ok(rendered[1]?.startsWith("  /cmd1"), rendered[1]);
	});

	it("says how many rows are above and below the window instead of a position counter", () => {
		const list = new SelectList(items, 5, testTheme);
		for (let step = 0; step < 6; step++) list.handleInput("\x1b[B");
		const rendered = list.render(80);
		const last = rendered.at(-1) ?? "";
		assert.ok(!/\(\d+\/\d+\)/.test(last), last);
		assert.equal(last.trim(), "↑ 4 more · ↓ 3 more");
	});

	it("does not activate an abandoned press when the next click lands on the more indicator (#5693)", () => {
		const list = new SelectList(items, 5, testTheme);
		const chosen: string[] = [];
		list.onSelect = (item) => chosen.push(item.value);
		const send = (type: "press" | "drag" | "release" | "click", y: number) =>
			list.handleMouse({
				type,
				y,
				x: 8,
				screenX: 8,
				screenY: y,
				button: "left",
				height: 6,
				width: 80,
				shift: false,
				alt: false,
				ctrl: false,
			});
		send("press", 4);
		send("drag", 2);
		send("release", 2);
		assert.match(list.render(80)[5]!, /more/);
		send("press", 5);
		send("click", 5);
		assert.deepStrictEqual(chosen, []);
	});

	it("names only the direction that has more rows at an end of the list", () => {
		const rendered = new SelectList(items, 5, testTheme).render(80);
		assert.equal((rendered.at(-1) ?? "").trim(), "↓ 7 more");
	});
});
