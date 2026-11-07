import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	ALT_WHEEL_SCROLL_MULTIPLIER,
	parseWheelReport,
	SCROLLBAR_HIDE_DELAY_MS,
	ScrollableComponentViewport,
	type ScrollableComponentViewportOptions,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const ALT_WHEEL_UP = "\x1b[<72;10;5M";
const LEGACY_WHEEL_UP = `\x1b[M${String.fromCharCode(64 + 32)}!!`;
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const PAGE_DOWN = "\x1b[6~";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const PROMPT_MARK = "\x1b]133;A\x07";

class Rows implements Component {
	constructor(public lines: string[]) {}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

const numbered = (count: number, prefix = "row") => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

/** A viewport over `rows`, rendered once at `width` x `height` so scroll limits are known. */
function viewport(
	rows: string[],
	options: ScrollableComponentViewportOptions = {},
	height = 10,
	keybindings: KeybindingsManager = new KeybindingsManager(),
) {
	const content = new Rows(rows);
	const view = new ScrollableComponentViewport(keybindings, options);
	view.setComponents([content]);
	view.setVisibleRows(height);
	const paint = (width = 40) => view.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
	paint();
	return { view, content, paint };
}

/** The index of the first visible content row. */
const topRow = (frame: readonly string[]) => Number(/row-(\d+)/.exec(frame[0] ?? "")?.[1]);

afterEach(() => {
	vi.useRealTimers();
});

describe("wheel scrolling honours fullscreenWheelScrollLines (#4521)", () => {
	test("a numeric setting moves that many rows per event, and Alt multiplies it", () => {
		let lines = 3;
		const { view } = viewport(numbered(100), { wheelScrollLines: () => lines });
		assert.equal(view.handleInput(WHEEL_UP), true);
		assert.equal(view.getScrollFromBottom(), 3);
		lines = 7;
		view.handleInput(WHEEL_UP);
		assert.equal(view.getScrollFromBottom(), 10);
		view.handleInput(ALT_WHEEL_UP);
		assert.equal(view.getScrollFromBottom(), 10 + 7 * ALT_WHEEL_SCROLL_MULTIPLIER);
		view.handleInput(WHEEL_DOWN);
		assert.equal(view.getScrollFromBottom(), 3 + 7 * ALT_WHEEL_SCROLL_MULTIPLIER);
	});

	test("legacy X10 wheel reports scroll too, and horizontal or button reports are consumed without scrolling", () => {
		const { view } = viewport(numbered(100), { wheelScrollLines: () => 2 });
		view.handleInput(LEGACY_WHEEL_UP);
		assert.equal(view.getScrollFromBottom(), 2);
		for (const report of ["\x1b[<66;10;5M", "\x1b[<0;10;5M", "\x1b[<0;10;5m"]) {
			assert.equal(view.handleInput(report), true);
			assert.equal(view.getScrollFromBottom(), 2);
		}
	});

	test('"auto" follows wheel velocity: an isolated notch moves one row and a fast spin accelerates', () => {
		let now = 1_000;
		const { view } = viewport(numbered(500), { accelerateWheel: true, now: () => now }, 10);
		const steps: number[] = [];
		for (const gap of [0, 500, 20, 20, 20, 20]) {
			now += gap;
			const before = view.getScrollFromBottom();
			view.handleInput(WHEEL_UP);
			steps.push(view.getScrollFromBottom() - before);
		}
		assert.deepEqual(steps.slice(0, 2), [1, 1], "a notch after a pause moves one row");
		assert.ok(
			steps.slice(2).every((step) => step >= 1) && steps.at(-1)! >= 4,
			`fast spins accelerate: ${steps.join(",")}`,
		);
		assert.ok(
			steps.every((step) => step <= 6),
			"acceleration is capped as in the main transcript",
		);
	});

	test('"auto" without acceleration moves one row per event, as on terminals that accelerate themselves', () => {
		let now = 0;
		const { view } = viewport(numbered(500), { accelerateWheel: false, now: () => now });
		for (let i = 0; i < 5; i++) {
			now += 10;
			view.handleInput(WHEEL_UP);
		}
		assert.equal(view.getScrollFromBottom(), 5);
	});
});

describe("scrollbar honours fullscreenScrollbar (#4521)", () => {
	test('"hidden" paints none and keeps every column for content', () => {
		const { paint } = viewport([`${"x".repeat(40)}`, ...numbered(50)], { scrollbar: () => "hidden" });
		assert.ok(paint().every((line) => !/[│┃]$/.test(line)));
	});

	test('"always" reserves the rightmost column and tracks the position with a proportional thumb', () => {
		const { view, paint } = viewport(numbered(100), { scrollbar: () => "always" }, 10);
		const following = paint(20);
		assert.equal(following.length, 10);
		assert.ok(following.every((line) => line.length === 20 && /[│┃]$/.test(line)));
		assert.deepEqual(
			following.map((line) => line.at(-1)),
			["│", "│", "│", "│", "│", "│", "│", "│", "┃", "┃"],
			"a 10-row track over 100 rows has a two-row thumb at the bottom while following",
		);
		view.handleInput(CTRL_HOME);
		const top = paint(20);
		assert.equal(top[0]?.at(-1), "┃", "the thumb is at the top of the track at the first row");
		assert.match(top[0] ?? "", /^row-0\s/);
	});

	test('"always" draws a full thumb when nothing scrolls', () => {
		const { paint } = viewport(numbered(3), { scrollbar: () => "always" }, 5);
		assert.deepEqual(
			paint(10).map((line) => line.at(-1)),
			["┃", "┃", "┃", "┃", "┃"],
		);
	});

	test('"auto" shows the scrollbar only while scrolling and asks for a repaint once it hides', () => {
		vi.useFakeTimers();
		let now = 0;
		let repaints = 0;
		const { view, paint } = viewport(numbered(100), {
			scrollbar: () => "auto",
			now: () => now,
			requestRender: () => repaints++,
		});
		assert.ok(
			paint().every((line) => !/[│┃]$/.test(line)),
			"idle: hidden",
		);
		view.handleInput(WHEEL_UP);
		const scrolling = paint();
		assert.ok(
			scrolling.every((line) => /[│┃]$/.test(line)),
			"scrolling: shown over the last column",
		);
		assert.equal(scrolling[0]?.length, 40, "auto does not take a column from the content");
		now += SCROLLBAR_HIDE_DELAY_MS - 1;
		assert.ok(paint().every((line) => /[│┃]$/.test(line)));
		vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
		assert.equal(repaints, 1, "the hide delay asks for exactly one repaint");
		now += 1;
		assert.ok(
			paint().every((line) => !/[│┃]$/.test(line)),
			"hidden again after the delay",
		);
		view.handleInput(CTRL_END);
		view.handleInput(CTRL_END);
		vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
		assert.equal(repaints, 2, "a scroll that does not move schedules nothing");
		view.dispose();
	});

	test('"auto" stays hidden when everything fits', () => {
		const { view, paint } = viewport(numbered(3), { scrollbar: () => "auto" }, 10);
		view.handleInput(WHEEL_UP);
		assert.ok(paint().every((line) => !/[│┃]$/.test(line)));
	});
});

describe("prompt jumps, half pages and top/latest (#4521)", () => {
	const promptRows = Array.from({ length: 60 }, (_, i) => (i % 15 === 0 ? `${PROMPT_MARK}row-${i}` : `row-${i}`));

	test("ctrl+up and ctrl+down park the previous and next semantic prompt at the top", () => {
		const { view, paint } = viewport(promptRows, {}, 10);
		assert.equal(topRow(paint()), 50);
		assert.equal(view.handleInput(CTRL_UP), true);
		assert.equal(topRow(paint()), 45);
		view.handleInput(CTRL_UP);
		assert.equal(topRow(paint()), 30);
		view.handleInput(CTRL_DOWN);
		assert.equal(topRow(paint()), 45);
		view.handleInput(CTRL_DOWN);
		assert.equal(topRow(paint()), 45, "no prompt below the top row leaves the view where it is");
		view.handleInput(CTRL_HOME);
		paint();
		view.handleInput(CTRL_UP);
		assert.equal(topRow(paint()), 0, "no prompt above the first row leaves the view where it is");
	});

	test("the half-page actions move by half the viewport when bound", () => {
		const keys = new KeybindingsManager({
			"tui.altScreen.halfPageUp": "ctrl+b",
			"tui.altScreen.halfPageDown": "ctrl+n",
		});
		const { view } = viewport(numbered(100), {}, 11, keys);
		assert.equal(view.handleInput("\x02"), true);
		assert.equal(view.getScrollFromBottom(), 5);
		view.handleInput("\x02");
		assert.equal(view.getScrollFromBottom(), 10);
		view.handleInput("\x0e");
		assert.equal(view.getScrollFromBottom(), 5);
	});

	test("half-page actions are unbound by default and fall through to the caller", () => {
		const { view } = viewport(numbered(100));
		assert.equal(view.handleInput("\x02"), false);
		assert.equal(view.getScrollFromBottom(), 0);
	});

	test("ctrl+home reaches the first row of history that loaded after the last render", () => {
		const { view, content, paint } = viewport(numbered(30), {}, 10);
		view.handleInput(CTRL_HOME);
		assert.equal(topRow(paint()), 0);
		content.lines = [...numbered(20, "earlier"), ...content.lines];
		view.handleInput(CTRL_HOME);
		assert.match(paint()[0] ?? "", /^earlier-0$/);
	});
});

describe("jump-to-latest indicator and history loading (#4521)", () => {
	const indicator: Pick<Component, "render"> = { render: () => ["JUMP TO LATEST"] };

	test("away from the live end the last row is the indicator, and the first row stays reachable", () => {
		const { view, paint } = viewport(numbered(50), { followIndicator: indicator }, 10);
		assert.ok(!paint().includes("JUMP TO LATEST"), "following: no indicator");
		view.handleInput(WHEEL_UP);
		const detached = paint();
		assert.equal(detached.length, 10);
		assert.equal(detached.at(-1), "JUMP TO LATEST");
		view.handleInput(CTRL_HOME);
		const top = paint();
		assert.equal(top[0], "row-0");
		assert.equal(top.at(-1), "JUMP TO LATEST");
		view.handleInput(CTRL_END);
		assert.ok(!paint().includes("JUMP TO LATEST"));
	});

	test("a one-row viewport keeps its row for content", () => {
		const { view, paint } = viewport(numbered(50), { followIndicator: indicator }, 1);
		view.handleInput(WHEEL_UP);
		assert.deepEqual(paint(), ["row-48"]);
	});

	test("onNearTop runs only while the first visible row is within one viewport of the top", () => {
		let nearTop = 0;
		const { view, paint } = viewport(numbered(100), { onNearTop: () => nearTop++ }, 10);
		assert.equal(nearTop, 0);
		view.scrollTo(15);
		paint();
		assert.equal(nearTop, 0);
		view.scrollTo(9);
		paint();
		assert.equal(nearTop, 1);
	});
});

test("painted rows keep styling, links and prompt marks but drop cursor movement and erasing (#4521)", () => {
	const content = new Rows([
		`${PROMPT_MARK}\x1b[31mred\x1b[0m \x1b]8;;https://example.test\x07link\x1b]8;;\x07 \x1b[2Jclear\x1b[10;1Hmove\rret\x08`,
	]);
	const view = new ScrollableComponentViewport(new KeybindingsManager());
	view.setComponents([content]);
	view.setVisibleRows(1);
	const [row] = view.render(60);
	assert.ok(row);
	assert.ok(row.includes(PROMPT_MARK));
	assert.ok(row.includes("\x1b[31m"));
	assert.ok(row.includes("\x1b]8;;https://example.test\x07"));
	assert.ok(!row.includes("\x1b[2J"));
	assert.ok(!row.includes("\x1b[10;1H"));
	assert.ok(!/[\r\x08]/.test(row));
	assert.match(stripVTControlCharacters(row), /^red link clearmove ret /);
});

test("a reader scrolled up keeps the same top row when the viewport's height changes (#4521)", () => {
	const { view, paint } = viewport(numbered(100), {}, 12);
	view.handleInput(CTRL_HOME);
	assert.equal(topRow(paint()), 0);
	view.setVisibleRows(10);
	assert.equal(topRow(paint()), 0, "a status row taking two rows of a live chat must not hide its first rows");
	view.setVisibleRows(14);
	assert.equal(topRow(paint()), 0);
	view.scrollTo(30);
	paint();
	view.setVisibleRows(11);
	assert.equal(topRow(paint()), 30);
	view.handleInput(CTRL_END);
	paint();
	view.setVisibleRows(12);
	assert.equal(topRow(paint()), 88, "a reader following the end keeps following it");
});

test("Ctrl+Home keeps the first row on top as rows arrive, also across a resize, until another scroll (#4521)", () => {
	const { view, content, paint } = viewport(numbered(50), {}, 10);
	const grow = (prefix: string) => {
		content.lines = [...numbered(20, prefix), ...content.lines];
	};
	view.handleInput(CTRL_HOME);
	assert.equal(paint(40)[0], "row-0");
	grow("early");
	assert.equal(paint(30)[0], "early-0", "the first row stays on top while the width changes");
	for (const [leave, label] of [
		[() => view.handleInput(PAGE_DOWN), "a relative scroll"],
		[() => view.scrollTo(5), "an absolute scroll"],
		[() => view.handleInput(CTRL_END), "Ctrl+End"],
	] as const) {
		view.handleInput(CTRL_HOME);
		paint(40);
		leave();
		paint(40);
		grow(label.replaceAll(" ", "_"));
		assert.notEqual(paint(30)[0], `${label.replaceAll(" ", "_")}-0`, `${label} ends the hold on the top`);
	}
});

test("a legacy X10 wheel report needs all six bytes (#4521)", () => {
	const wheelUp = `\x1b[M${String.fromCharCode(64 + 32)}!!`;
	assert.deepEqual(parseWheelReport(wheelUp), { direction: -1, alt: false });
	for (const truncated of [wheelUp.slice(0, 4), wheelUp.slice(0, 5)])
		assert.equal(parseWheelReport(truncated), undefined, JSON.stringify(truncated));
});

test("a reader scrolled up keeps their distance from the end when the width changes (#4521)", () => {
	const wrapping: Component = {
		render: (width) =>
			Array.from({ length: 30 }, (_, i) => `line-${i} ${"x".repeat(50)}`).flatMap((line) => {
				const rows: string[] = [];
				for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width));
				return rows;
			}),
		invalidate: () => {},
	};
	const view = new ScrollableComponentViewport(new KeybindingsManager(), {});
	view.setComponents([wrapping]);
	view.setVisibleRows(10);
	view.render(40);
	view.scrollBy(-7);
	view.render(40);
	const wide = view.render(60);
	assert.equal(view.getScrollFromBottom(), 7, "the reader stays seven rows above the end");
	assert.equal(wide.length, 10);
});
