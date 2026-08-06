import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { ScrollableComponentViewport } from "../../packages/coding-agent/src/modes/interactive/components/index.js";

/**
 * Regression coverage for the scroll anchor in ScrollableComponentViewport.
 *
 * The viewport stores the scroll offset as a distance from the bottom, so the
 * first visible row is `maxScroll - scrollFromBottom`. When the content stack
 * changes height at the bottom (a live subagent widget gains or loses its
 * current-tool row on every tool_execution_start / tool_execution_end), the
 * offset has to move by the same delta or the anchored content slides.
 *
 * Compensation used to run only for growth, so a shrink left the anchor behind
 * and the viewer drifted off the rows they had scrolled to.
 */

/** Component with a fixed body, used as the anchored content above the fold. */
class FixedLines implements Component {
	constructor(private readonly lines: readonly string[]) {}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

/** Component that stands in for a live widget whose height oscillates. */
class VariableLines implements Component {
	constructor(public count: number) {}
	render(): string[] {
		return Array.from({ length: this.count }, (_, i) => `live-${i}`);
	}
	invalidate(): void {}
}

/** Variable-height component whose rows are named, used above the anchor. */
class NamedVariableLines implements Component {
	constructor(
		private readonly prefix: string,
		public count: number,
	) {}
	render(): string[] {
		return Array.from({ length: this.count }, (_, i) => `${this.prefix}-${i}`);
	}
	invalidate(): void {}
}

const WIDTH = 40;
const VISIBLE_ROWS = 10;
const HISTORY_ROWS = 30;

function buildViewport(): { viewport: ScrollableComponentViewport; live: VariableLines } {
	const history = new FixedLines(Array.from({ length: HISTORY_ROWS }, (_, i) => `history-${i}`));
	const live = new VariableLines(10);
	const viewport = new ScrollableComponentViewport();
	viewport.setComponents([history, live]);
	viewport.setVisibleRows(VISIBLE_ROWS);
	return { viewport, live };
}

describe("ScrollableComponentViewport scroll anchor", () => {
	test("keeps a scrolled-up viewer anchored when the content stack shrinks", () => {
		const { viewport, live } = buildViewport();

		// Establish the baseline height (30 history + 10 live = 40 rows).
		viewport.render(WIDTH);
		// Scroll up into history; maxScroll is 30, so this anchors at row 12.
		viewport.scrollBy(-18);
		const anchored = viewport.render(WIDTH);
		assert.equal(anchored[0], "history-12", "precondition: viewer is parked at history-12");

		// tool_execution_end: the live widget loses rows.
		live.count = 7;
		const afterShrink = viewport.render(WIDTH);
		assert.deepEqual(afterShrink, anchored, "shrinking the live widget must not move the anchored rows");

		// tool_execution_start: the live widget regains them.
		live.count = 10;
		const afterGrow = viewport.render(WIDTH);
		assert.deepEqual(afterGrow, anchored, "regrowing the live widget must not move the anchored rows");
	});

	test("keeps the anchor across repeated shrink/grow tool cycles", () => {
		const { viewport, live } = buildViewport();
		viewport.render(WIDTH);
		viewport.scrollBy(-18);
		const anchored = viewport.render(WIDTH);

		for (let cycle = 0; cycle < 6; cycle += 1) {
			live.count = cycle % 2 === 0 ? 9 : 10;
			assert.deepEqual(viewport.render(WIDTH), anchored, `cycle ${cycle} moved the anchored rows`);
		}
	});

	test("a viewer already at the bottom still sticks to the bottom", () => {
		const { viewport, live } = buildViewport();
		viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 0, "precondition: sticky bottom by default");

		live.count = 14;
		const grown = viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 0, "growth must not lift a bottom-anchored viewer");
		assert.equal(grown.at(-1), "live-13", "bottom-anchored viewer follows new content");

		live.count = 6;
		const shrunk = viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 0, "shrink must not lift a bottom-anchored viewer");
		assert.equal(shrunk.at(-1), "live-5", "bottom-anchored viewer follows removed content");
	});

	test("a shrink larger than the remaining offset clamps to the bottom", () => {
		const { viewport, live } = buildViewport();
		viewport.render(WIDTH);
		viewport.scrollBy(-4);
		assert.equal(viewport.getScrollFromBottom(), 4);

		live.count = 1;
		viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 0, "offset cannot go negative");
		assert.ok(viewport.getScrollFromBottom() <= viewport.getMaxScroll(), "offset stays within maxScroll");
	});

	test("rows removed above the anchor do not move the anchored content", () => {
		// A component above the viewer shrinks. The bottom-relative distance to
		// the anchored rows is unchanged, so the offset must stay put. Adjusting
		// it by the total height delta -- which a symmetric
		// `scrollFromBottom += lineCount - lastLineCount` does -- slides the
		// viewer down by exactly the rows that were removed.
		const header = new NamedVariableLines("header", 12);
		const body = new FixedLines(Array.from({ length: 30 }, (_, i) => `body-${i}`));
		const viewport = new ScrollableComponentViewport();
		viewport.setComponents([header, body]);
		viewport.setVisibleRows(VISIBLE_ROWS);

		viewport.render(WIDTH);
		viewport.scrollBy(-18);
		const anchored = viewport.render(WIDTH);
		assert.equal(anchored[0], "body-2", "precondition: viewer is parked at body-2");

		header.count = 9;
		const afterTopShrink = viewport.render(WIDTH);
		assert.equal(afterTopShrink[0], "body-2", "removing rows above the anchor must not move the anchored rows");
		assert.deepEqual(afterTopShrink, anchored);

		header.count = 15;
		const afterTopGrow = viewport.render(WIDTH);
		assert.equal(afterTopGrow[0], "body-2", "adding rows above the anchor must not move the anchored rows");
		assert.deepEqual(afterTopGrow, anchored);
	});

	test("a plain scroll is not overridden by anchor compensation", () => {
		const { viewport } = buildViewport();
		viewport.render(WIDTH);
		viewport.scrollBy(-7);
		assert.equal(viewport.getScrollFromBottom(), 7);
		viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 7, "an unchanged stack must leave the user's offset alone");
		viewport.scrollBy(3);
		assert.equal(viewport.getScrollFromBottom(), 4);
		viewport.render(WIDTH);
		assert.equal(viewport.getScrollFromBottom(), 4);
	});
});
