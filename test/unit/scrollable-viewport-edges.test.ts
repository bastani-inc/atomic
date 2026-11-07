import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	SCROLLBAR_HIDE_DELAY_MS,
	ScrollableComponentViewport,
	type ScrollableComponentViewportOptions,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";

const WHEEL_UP = "\x1b[<64;10;5M";
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const PROMPT_MARK = "\x1b]133;A\x07";
const GLYPH = /[│┃]$/;

class Rows implements Component {
	constructor(public lines: string[]) {}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

class WidthProbe implements Component {
	render(width: number): string[] {
		return [`w${width}`];
	}
	invalidate(): void {}
}

const numbered = (count: number, prefix = "row") => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());
const topRow = (frame: readonly string[]) => Number(/row-(\d+)/.exec(frame[0] ?? "")?.[1]);

function viewport(rows: string[], options: ScrollableComponentViewportOptions = {}, height = 10) {
	const content = new Rows(rows);
	const view = new ScrollableComponentViewport(new KeybindingsManager(), options);
	view.setComponents([content]);
	view.setVisibleRows(height);
	const paint = (width = 40) => plain(view.render(width));
	paint();
	return { view, content, paint };
}

afterEach(() => {
	vi.useRealTimers();
});

test("input that is not a wheel report is not mistaken for one (#4521)", () => {
	const { view } = viewport(numbered(100));
	for (const input of ["x", "abcd", "\x1b[A", "x\x1b[<64;10;5M", "\x1b[<64;10;5Mx"]) {
		assert.equal(view.handleInput(input), false, JSON.stringify(input));
		assert.equal(view.getScrollFromBottom(), 0, JSON.stringify(input));
	}
	assert.equal(view.handleInput(WHEEL_UP), true);
	assert.equal(view.getScrollFromBottom(), 1);
});

test("prompt and half-page keys are consumed even when they cannot move the view (#4521)", () => {
	const keys = new KeybindingsManager({
		"tui.altScreen.halfPageUp": "ctrl+b",
		"tui.altScreen.halfPageDown": "ctrl+n",
	});
	const view = new ScrollableComponentViewport(keys);
	view.setComponents([new Rows(numbered(100))]);
	view.setVisibleRows(10);
	view.render(40);
	assert.equal(view.handleInput("\x0e"), true);
	assert.equal(view.getScrollFromBottom(), 0);
	assert.equal(view.handleInput(CTRL_UP), true);
	assert.equal(view.handleInput(CTRL_DOWN), true);
	assert.equal(view.getScrollFromBottom(), 0);
});

test("a marker in the middle of a row is not a semantic prompt (#4521)", () => {
	const rows = numbered(60).map((row, i) => (i === 20 ? `text${PROMPT_MARK}${row}` : row));
	rows[10] = `${PROMPT_MARK}${rows[10]}`;
	const { view, paint } = viewport(rows, {}, 10);
	view.scrollTo(30);
	paint();
	view.handleInput(CTRL_UP);
	assert.equal(topRow(paint()), 10);
});

test("previous prompt reaches a prompt on the very first row (#4521)", () => {
	const rows = numbered(60).map((row, i) => (i % 15 === 0 ? `${PROMPT_MARK}${row}` : row));
	const { view, paint } = viewport(rows, {}, 10);
	view.scrollTo(15);
	paint();
	view.handleInput(CTRL_UP);
	assert.equal(topRow(paint()), 0);
});

test("prompt jumps do nothing for a viewport last rendered at zero width (#4521)", () => {
	const rows = numbered(60).map((row, i) => (i % 15 === 0 ? `${PROMPT_MARK}${row}` : row));
	const { view } = viewport(rows, {}, 10);
	view.render(0);
	assert.equal(view.handleInput(CTRL_UP), true);
	assert.equal(view.getScrollFromBottom(), 0);
});

test("a viewport following the end keeps following as rows are appended (#4521)", () => {
	const { view, content, paint } = viewport(numbered(30), {}, 10);
	content.lines = numbered(45);
	assert.equal(topRow(paint()), 35);
	assert.equal(view.getScrollFromBottom(), 0);
});

test("a reader scrolled up keeps their rows when rows are appended below (#4521)", () => {
	const { view, content, paint } = viewport(numbered(30), {}, 10);
	view.scrollBy(-5);
	assert.equal(topRow(paint()), 15);
	content.lines = numbered(45);
	assert.equal(topRow(paint()), 15);
});

test("rowCount sums every component's rows at the width the viewport paints with (#4521)", () => {
	const view = new ScrollableComponentViewport(new KeybindingsManager());
	view.setComponents([new Rows(numbered(3)), new Rows(numbered(4))]);
	assert.equal(view.rowCount(40), 7);
	view.setComponents([]);
	assert.equal(view.rowCount(40), 0);
});

test("content is laid out one column narrower only for an always-on scrollbar wider than one column (#4521)", () => {
	const widthSeen = (mode: "hidden" | "auto" | "always", width: number) => {
		const view = new ScrollableComponentViewport(new KeybindingsManager(), { scrollbar: () => mode });
		view.setComponents([new WidthProbe()]);
		view.setVisibleRows(1);
		const rendered = plain(view.render(width))[0] ?? "";
		const ranged = view.renderRows(width, 0, 1)[0];
		return { rendered, ranged };
	};
	assert.equal(widthSeen("always", 20).ranged, "w19");
	assert.equal(widthSeen("always", 2).ranged, "w1");
	assert.equal(widthSeen("always", 1).ranged, "w1");
	assert.equal(widthSeen("hidden", 20).ranged, "w20");
	assert.equal(widthSeen("auto", 20).ranged, "w20");
	assert.match(widthSeen("always", 20).rendered, /^w19\s*[│┃]$/);
	assert.equal(widthSeen("auto", 20).rendered, "w20");
	assert.equal(widthSeen("hidden", 20).rendered, "w20");
	assert.equal(widthSeen("always", 1).rendered, "w1");
	const view = new ScrollableComponentViewport(new KeybindingsManager(), { scrollbar: () => "always" });
	view.setComponents([new Rows(numbered(7))]);
	assert.equal(view.rowCount(20), 7);
});

test("an always-on scrollbar needs at least two columns (#4521)", () => {
	const at = (width: number) => viewport(numbered(100), { scrollbar: () => "always" }, 4).paint(width);
	assert.ok(at(1).every((line) => !GLYPH.test(line)));
	assert.ok(at(2).every((line) => GLYPH.test(line) && line.length === 2));
});

test("scrollbar cells reset styling and links before the glyph, and keep rows to the content width (#4521)", () => {
	const { view } = viewport([`${"x".repeat(40)}`, ...numbered(50)], { scrollbar: () => "always" }, 5);
	view.handleInput(CTRL_HOME);
	const raw = view.render(20);
	for (const line of raw) assert.ok(line.includes("\x1b[0m\x1b]8;;\x07"));
	const first = plain(raw)[0] ?? "";
	assert.equal(first, `${"x".repeat(19)}┃`);
});

test("an auto scrollbar truncates long rows without an ellipsis (#4521)", () => {
	vi.useFakeTimers();
	const { view } = viewport([`${"y".repeat(60)}`, ...numbered(50)], { scrollbar: () => "auto", now: () => 0 }, 5);
	view.handleInput(CTRL_HOME);
	assert.equal(plain(view.render(20))[0], `${"y".repeat(19)}┃`);
	view.dispose();
});

test("the thumb covers the proportional rows at the top, middle and bottom of the track (#4521)", () => {
	const { view, paint } = viewport(numbered(100), { scrollbar: () => "always" }, 10);
	const glyphs = () => paint(20).map((line) => line.at(-1));
	const T = "┃";
	const R = "│";
	assert.deepEqual(glyphs(), [R, R, R, R, R, R, R, R, T, T]);
	view.scrollTo(45);
	assert.deepEqual(glyphs(), [R, R, R, R, T, T, R, R, R, R]);
	view.handleInput(CTRL_HOME);
	assert.deepEqual(glyphs(), [T, T, R, R, R, R, R, R, R, R]);
});

test("rows a component does not fill are padded to the full content width (#4521)", () => {
	const view = new ScrollableComponentViewport(new KeybindingsManager());
	view.setComponents([new Rows(["a"])]);
	view.setVisibleRows(3);
	const rows = view.render(12);
	assert.equal(rows.length, 3);
	assert.equal(rows[1], " ".repeat(12));
	assert.equal(rows[2], " ".repeat(12));
	const narrowed = new ScrollableComponentViewport(new KeybindingsManager(), { scrollbar: () => "always" });
	narrowed.setComponents([new Rows(["a"])]);
	narrowed.setVisibleRows(3);
	assert.equal(stripVTControlCharacters(narrowed.render(12)[1] ?? "").length, 12);
});

test("a multi-row follow indicator contributes only its first row (#4521)", () => {
	const { view, paint } = viewport(numbered(50), { followIndicator: { render: () => ["FIRST", "SECOND"] } }, 10);
	view.handleInput(WHEEL_UP);
	const frame = paint();
	assert.equal(frame.length, 10);
	assert.equal(frame.at(-1), "FIRST");
	assert.ok(!frame.includes("SECOND"));
});

test("onNearTop does not run when the first visible row is exactly one viewport from the top (#4521)", () => {
	let nearTop = 0;
	const { view, paint } = viewport(numbered(100), { onNearTop: () => nearTop++ }, 10);
	view.scrollTo(10);
	paint();
	assert.equal(nearTop, 0);
	view.scrollTo(9);
	paint();
	assert.equal(nearTop, 1);
});

test("an auto scrollbar appears for a scroll even when the position did not change, if a row was requested (#4521)", () => {
	vi.useFakeTimers();
	const { view, paint } = viewport(numbered(100), { scrollbar: () => "auto", now: () => 0, requestRender: () => {} });
	view.scrollToBottom();
	assert.ok(
		paint().every((line) => !GLYPH.test(line)),
		"a no-op scroll to the bottom shows nothing",
	);
	view.scrollTo(90);
	assert.ok(
		paint().every((line) => GLYPH.test(line)),
		"an absolute scroll request shows the scrollbar",
	);
	view.dispose();
});

test("only an auto scrollbar with a repaint hook schedules the hide timer (#4521)", () => {
	vi.useFakeTimers();
	let repaints = 0;
	const scrollOnce = (options: ScrollableComponentViewportOptions) => {
		const { view } = viewport(numbered(100), options);
		view.handleInput(WHEEL_UP);
		return view;
	};
	const always = scrollOnce({ scrollbar: () => "always", requestRender: () => repaints++ });
	const hidden = scrollOnce({ scrollbar: () => "hidden", requestRender: () => repaints++ });
	const noHook = scrollOnce({ scrollbar: () => "auto" });
	assert.equal(vi.getTimerCount(), 0);
	vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS * 2);
	assert.equal(repaints, 0);
	const auto = scrollOnce({ scrollbar: () => "auto", requestRender: () => repaints++ });
	assert.equal(vi.getTimerCount(), 1);
	vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
	assert.equal(repaints, 1);
	for (const view of [always, hidden, noHook, auto]) view.dispose();
});

test("a no-op scroll leaves an auto scrollbar hidden and schedules nothing (#4521)", () => {
	vi.useFakeTimers();
	let repaints = 0;
	const { view, paint } = viewport(numbered(100), {
		scrollbar: () => "auto",
		now: () => 0,
		requestRender: () => repaints++,
	});
	view.scrollBy(5);
	view.handleInput(CTRL_END);
	assert.equal(vi.getTimerCount(), 0);
	assert.ok(paint().every((line) => !GLYPH.test(line)));
	view.dispose();
});

test("an auto scrollbar needs content that overflows, and hidden mode never paints one (#4521)", () => {
	let now = 0;
	const exact = viewport(numbered(10), { scrollbar: () => "auto", now: () => now }, 10);
	exact.view.scrollTo(0);
	assert.ok(exact.paint().every((line) => !GLYPH.test(line)));
	const hidden = viewport(numbered(100), { scrollbar: () => "hidden", now: () => now }, 10);
	hidden.view.handleInput(WHEEL_UP);
	assert.ok(hidden.paint().every((line) => !GLYPH.test(line)));
	const overflowing = viewport(numbered(11), { scrollbar: () => "auto", now: () => now }, 10);
	overflowing.view.scrollTo(0);
	assert.ok(overflowing.paint().every((line) => GLYPH.test(line)));
	now += SCROLLBAR_HIDE_DELAY_MS;
	assert.ok(overflowing.paint().every((line) => !GLYPH.test(line)));
});
