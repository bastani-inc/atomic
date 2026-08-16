/**
 * Atomic's own transcript-search matcher and the absolute viewport controls a
 * stage-chat search navigates with.
 *
 * The matcher is a deliberate copy of the algorithm pi-tui keeps private in
 * `alt-screen-search.ts` (spec §5.5): a deep import into `dist/` would resolve
 * today and disappear without a compile error in any upstream refactor. These
 * tests pin the behavior Atomic now owns — literal matching, case and
 * whitespace insensitivity, wrapped matches, and ANSI-safe highlighting — plus
 * `ScrollableComponentViewport.rowCount` / `renderRows` / `scrollTo`, which are
 * what let a search read and reveal rows outside the current window.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Component } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { ScrollableComponentViewport } from "../src/modes/interactive/components/chat-transcript.js";
import {
	findSearchMatches,
	getSearchMatchKey,
	highlightSearchMatchRow,
	type TranscriptSearchHighlightStyles,
} from "../src/modes/interactive/components/transcript-search.js";

const STYLES: TranscriptSearchHighlightStyles = {
	match: (text) => `<m>${text}</m>`,
	currentMatch: (text) => `<c>${text}</c>`,
};

/**
 * These 24–64 KiB transcript rows must stay far below the suite's 30 s
 * timeout. The generous budget detects the old 2.5–6.5 s near-quadratic scans
 * without treating this as a microbenchmark.
 */
const MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS = 1_000;

/** A plain component of fixed text rows, the shape a chat body stacks. */
function textComponent(lines: readonly string[]): Component {
	return {
		render: () => [...lines],
		invalidate: () => {},
	};
}

describe("transcript search matcher", () => {
	test("matches literally, ignoring case and the query's own spacing", () => {
		const lines = ["The Needle in a haystack", "no match here"];

		const matches = findSearchMatches(lines, "  needle   IN  ");

		assert.equal(matches.length, 1);
		// One segment per printable run: the space between the words is a
		// separator in the corpus, not a column anyone highlights.
		assert.deepEqual(matches[0]?.segments, [
			{ row: 0, startCol: 4, endCol: 10 },
			{ row: 0, startCol: 11, endCol: 13 },
		]);
	});

	test("a regex metacharacter is searched for, not interpreted", () => {
		const matches = findSearchMatches(["cost is $1.50", "cost is $1x50"], "$1.50");

		assert.equal(matches.length, 1);
		assert.equal(matches[0]?.segments[0]?.row, 0);
	});

	test("an empty or whitespace-only query matches nothing rather than everything", () => {
		assert.deepEqual(findSearchMatches(["anything at all"], ""), []);
		assert.deepEqual(findSearchMatches(["anything at all"], "   \t "), []);
	});

	test("a phrase broken across a soft wrap matches as one, with a segment per row", () => {
		const matches = findSearchMatches(["a wrapped", "phrase here"], "wrapped phrase");

		assert.equal(matches.length, 1);
		assert.deepEqual(matches[0]?.segments, [
			{ row: 0, startCol: 2, endCol: 9 },
			{ row: 1, startCol: 0, endCol: 6 },
		]);
	});

	test("columns are visible columns, so ANSI styling does not shift a match", () => {
		const matches = findSearchMatches(["\x1b[1mbold\x1b[22m needle"], "needle");

		assert.deepEqual(matches[0]?.segments, [{ row: 0, startCol: 5, endCol: 11 }]);
	});

	test("the match key identifies a match by position, so equal text stays distinguishable", () => {
		const matches = findSearchMatches(["needle", "needle"], "needle");

		assert.equal(matches.length, 2);
		assert.equal(getSearchMatchKey(matches[0]!), "0:0:0:6");
		assert.equal(getSearchMatchKey(matches[1]!), "1:0:1:6");
	});
});

describe("transcript search highlighting", () => {
	test("only the requested columns are styled, and the current match differs", () => {
		const line = "alpha needle omega";
		const highlighted = highlightSearchMatchRow(
			line,
			[
				{ startCol: 0, endCol: 5, current: false },
				{ startCol: 6, endCol: 12, current: true },
			],
			STYLES,
		);

		assert.equal(highlighted, "<m>alpha</m> <c>needle</c> omega");
	});

	test("escape sequences inside the match survive it, unstyled", () => {
		const highlighted = highlightSearchMatchRow(
			"\x1b[1mneedle\x1b[22m",
			[{ startCol: 0, endCol: 6, current: false }],
			STYLES,
		);

		assert.equal(highlighted, "\x1b[1m<m>needle</m>\x1b[22m");
	});

	test("handles repeated malformed ANSI prefixes without regex backtracking", () => {
		const line = `${"\x1b]".repeat(4096)}needle`;
		const highlighted = highlightSearchMatchRow(line, [{ startCol: 0, endCol: line.length, current: false }], STYLES);
		assert.ok(highlighted.includes("needle"));
	});

	test("handles repeated ANSI sequences without polynomial suffix matching", () => {
		const line = `${"\x1b[31m".repeat(2048)}needle`;
		const highlighted = highlightSearchMatchRow(line, [{ startCol: 0, endCol: line.length, current: false }], STYLES);
		assert.ok(highlighted.endsWith("<m>needle</m>"));
	});

	test("keeps literal CSI-at input within the interactive highlight budget", () => {
		const prefix = "\x1b[@".repeat(8192);
		const line = `${prefix}needle`;
		const startedAt = performance.now();
		const highlighted = highlightSearchMatchRow(line, [{ startCol: 0, endCol: line.length, current: false }], STYLES);
		const elapsedMs = performance.now() - startedAt;

		assert.equal(highlighted, `${prefix}<m>needle</m>`);
		assert.ok(
			elapsedMs < MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS,
			`literal CSI-at highlight took ${elapsedMs.toFixed(0)} ms (budget ${MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS} ms)`,
		);
	});

	test("keeps repeated malformed OSC openers within the interactive highlight budget", () => {
		const line = `${"\x1b]".repeat(32768)}needle`;
		const startedAt = performance.now();
		const highlighted = highlightSearchMatchRow(line, [{ startCol: 0, endCol: line.length, current: false }], STYLES);
		const elapsedMs = performance.now() - startedAt;

		assert.equal(highlighted, `${"\x1b]".repeat(32768)}<m>needle</m>`);
		assert.ok(
			elapsedMs < MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS,
			`malformed OSC highlight took ${elapsedMs.toFixed(0)} ms (budget ${MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS} ms)`,
		);
	});

	test("keeps mixed malformed CSI input within the interactive highlight budget", () => {
		const repeats = 8192;
		const prefix = `\x1b[${"@\x1b[ ".repeat(repeats)}`;
		const line = `${prefix}needle`;
		const startedAt = performance.now();
		const highlighted = highlightSearchMatchRow(line, [{ startCol: 0, endCol: line.length, current: false }], STYLES);
		const elapsedMs = performance.now() - startedAt;

		assert.equal(highlighted, `${prefix}n<m>eedle</m>`);
		assert.ok(
			elapsedMs < MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS,
			`mixed malformed CSI highlight took ${elapsedMs.toFixed(0)} ms (budget ${MALFORMED_ANSI_HIGHLIGHT_BUDGET_MS} ms)`,
		);
	});
	test("preserves multiple trailing ANSI sequences after a middle highlight", () => {
		const highlighted = highlightSearchMatchRow(
			"\x1b[31malpha needle omega\x1b[39m\x1b[49m",
			[{ startCol: 6, endCol: 12, current: false }],
			STYLES,
		);

		assert.equal(highlighted, "\x1b[31malpha \x1b[31m<m>needle</m>\x1b[31m omega\x1b[39m\x1b[49m");
	});

	test("a range past the end of the line is clipped rather than padded onto it", () => {
		assert.equal(highlightSearchMatchRow("short", [{ startCol: 10, endCol: 20, current: true }], STYLES), "short");
	});
});

describe("ScrollableComponentViewport absolute row access", () => {
	function viewport(rows: number, visibleRows: number): ScrollableComponentViewport {
		const view = new ScrollableComponentViewport();
		view.setComponents([textComponent(Array.from({ length: rows }, (_, index) => `row ${index + 1}`))]);
		view.setVisibleRows(visibleRows);
		return view;
	}

	test("rowCount reports every row, not the visible window", () => {
		const view = viewport(50, 5);

		assert.equal(view.render(20).length, 5);
		assert.equal(view.rowCount(20), 50);
	});

	test("renderRows paints an absolute range the reader cannot see", () => {
		const view = viewport(50, 5);
		view.render(20);

		// Sticky bottom: rows 46-50 are on screen, row 1 is 45 rows above it.
		assert.equal(view.render(20)[0]?.trim(), "row 46");
		assert.deepEqual(
			view.renderRows(20, 0, 3).map((line) => line.trim()),
			["row 1", "row 2", "row 3"],
		);
	});

	test("scrollTo parks an absolute row at the top of the window", () => {
		const view = viewport(50, 5);
		view.render(20);

		view.scrollTo(10);

		assert.equal(view.render(20)[0]?.trim(), "row 11");
		assert.equal(view.getScrollFromBottom(), 35);
	});

	test("scrollTo clamps instead of scrolling past either end", () => {
		const view = viewport(50, 5);
		view.render(20);

		view.scrollTo(-40);
		assert.equal(view.getScrollFromBottom(), view.getMaxScroll());

		view.scrollTo(9_000);
		assert.equal(view.getScrollFromBottom(), 0);
	});
	test("scrollTo treats NaN as the first row", () => {
		const view = viewport(50, 5);
		view.render(20);

		view.scrollTo(Number.NaN);

		assert.equal(view.getScrollFromBottom(), view.getMaxScroll());
		assert.equal(view.render(20)[0]?.trim(), "row 1");
	});

	/**
	 * The caller that needs an absolute row is a search, and a search measures
	 * the stack as it is *now*: rows may have arrived since the last render.
	 * Resolving the request against the previous frame — its smaller
	 * `maxScroll`, then its anchor — silently answered with a row nobody asked
	 * for, which for a sticky-bottom body meant no movement at all.
	 */
	test("scrollTo names a row of the stack the next render paints, not the last one", () => {
		const view = viewport(100, 5);
		view.render(20);
		assert.equal(view.getMaxScroll(), 95);

		view.setComponents([textComponent(Array.from({ length: 141 }, (_, index) => `row ${index + 1}`))]);
		view.scrollTo(100);

		assert.equal(view.render(20)[0]?.trim(), "row 101");
	});

	test("any other scroll withdraws a pending scrollTo", () => {
		const view = viewport(50, 5);
		view.render(20);

		view.scrollTo(10);
		view.scrollToBottom();

		assert.equal(view.render(20)[0]?.trim(), "row 46");
	});
});
