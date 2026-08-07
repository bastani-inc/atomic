import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import {
	ChatTranscriptComponent,
	ScrollableChatTranscriptComponent,
	ScrollableComponentViewport,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";

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

/**
 * Windowed component whose rows come from identity-tagged segments.
 *
 * This is the production shape: `ChatTranscriptComponent` occupies a single
 * viewport slot and renders *every* chat entry inside it, so a scrolled-up
 * viewer's anchor row always falls in this component's interior.
 */
class SegmentedRows implements Component {
	readonly supportsRowWindow = true as const;
	constructor(public segments: Array<{ id: object; rows: readonly string[] }>) {}
	rowCount(): number {
		return this.allRows().length;
	}
	renderRows(_width: number, startRow: number, endRow: number): string[] {
		return this.allRows().slice(startRow, endRow);
	}
	rowSegments(): Array<{ id: unknown; rows: number }> {
		return this.segments.map((segment) => ({ id: segment.id, rows: segment.rows.length }));
	}
	render(): string[] {
		return this.allRows();
	}
	invalidate(): void {}
	private allRows(): string[] {
		return this.segments.flatMap((segment) => [...segment.rows]);
	}
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

	test("a component that shrinks in its interior above the anchor keeps the anchored rows", () => {
		// The whole transcript is one component, so the anchor is always *inside*
		// it and per-component row counts cannot say where the rows changed.
		// Compaction deletes entries from that interior while the tail below the
		// anchor is untouched; the viewer must stay on the same entry.
		const transcript = new SegmentedRows(
			Array.from({ length: 30 }, (_, i) => ({ id: { entry: i }, rows: [`entry-${i}`] })),
		);
		const viewport = new ScrollableComponentViewport();
		viewport.setComponents([transcript]);
		viewport.setVisibleRows(VISIBLE_ROWS);

		viewport.render(WIDTH);
		// maxScroll is 20, so this parks the first visible row on entry-10.
		viewport.scrollBy(-10);
		const anchored = viewport.render(WIDTH);
		assert.equal(anchored[0], "entry-10", "precondition: viewer is parked at entry-10");

		// Three entries vanish from the interior, all above the anchored row.
		transcript.segments.splice(5, 3);
		const afterInteriorShrink = viewport.render(WIDTH);
		assert.equal(
			afterInteriorShrink[0],
			"entry-10",
			"rows removed inside the anchored component, above the anchor, must not move the anchored rows",
		);
		assert.deepEqual(afterInteriorShrink, anchored);
	});

	test("compaction that renumbers every transcript cache key keeps the anchored entry", () => {
		// The production path: `replaceMessages` splices the entries array in
		// place, so every surviving entry gets a new index -- and the transcript
		// cache key embeds the index, so every key changes. Only the entry
		// objects themselves survive the splice.
		const entries: Array<{ role: "assistant"; text: string }> = Array.from({ length: 30 }, (_, i) => ({
			role: "assistant",
			text: `entry-${i}`,
		}));
		const transcript = new ChatTranscriptComponent(
			entries,
			(entry) => ({ render: () => [entry.text], invalidate: () => {} }),
			(entry, index) => `${index}:${entry.text}`,
		);
		const viewport = new ScrollableComponentViewport();
		viewport.setComponents([transcript]);
		viewport.setVisibleRows(VISIBLE_ROWS);

		viewport.render(WIDTH);
		viewport.scrollBy(-10);
		const anchored = viewport.render(WIDTH);
		assert.equal(anchored[0], "entry-10", "precondition: viewer is parked at entry-10");

		// Compaction drops everything above the anchor and re-seats the rest.
		entries.splice(0, entries.length, ...entries.slice(6));
		const afterCompaction = viewport.render(WIDTH);
		assert.equal(afterCompaction[0], "entry-10", "the viewer must stay on the entry they were reading");
		assert.deepEqual(afterCompaction, anchored);
	});
});

describe("ScrollableChatTranscriptComponent anchoring", () => {
	/**
	 * The exported scrollable transcript builds its inner component WITHOUT a
	 * cache key, deliberately: that is what lets it reflect entries mutated in
	 * place. It is therefore not a windowed component, so an earlier revision of
	 * this fix did not reach it -- `rowSegments` returned `[]` for anything that
	 * was not windowed, and the reviewer's drift survived on this class alone.
	 *
	 * A static component can still say which entry produced which rows, and it is
	 * still the single component spanning the anchor, so the anchor asks it too.
	 *
	 * Entries use the assistant role: `needsLeadingSpacer` prepends a blank row to
	 * user/custom/notice/system/summary entries, which would park the viewer on a
	 * spacer rather than on an identifiable entry.
	 */
	const WIDE = 40;
	const ROWS = 10;

	function build(entries: Array<{ role: "assistant"; text: string }>) {
		const scrollable = new ScrollableChatTranscriptComponent(entries, (entry) => ({
			render: () => [entry.text],
			invalidate: () => {},
		}));
		scrollable.setVisibleRows(ROWS);
		return scrollable;
	}

	test("entries removed above the viewer keep the anchored entry in place", () => {
		const entries = Array.from({ length: 30 }, (_, i) => ({ role: "assistant" as const, text: `entry-${i}` }));
		const scrollable = build(entries);

		scrollable.render(WIDE);
		scrollable.handleInput("\x1b[5~"); // PageUp
		scrollable.handleInput("\x1b[5~");
		const anchored = scrollable.render(WIDE);
		const firstRow = anchored[0];
		assert.ok(firstRow?.startsWith("entry-"), `precondition: viewer parked on an entry, got ${firstRow}`);

		// Remove three entries strictly above the anchored one.
		const anchoredIndex = entries.findIndex((entry) => entry.text === firstRow);
		assert.ok(anchoredIndex >= 3, "precondition: at least three entries sit above the anchor");
		entries.splice(anchoredIndex - 3, 3);

		const after = scrollable.render(WIDE);
		assert.equal(after[0], firstRow, "removing entries above the viewer must not move the anchored entry");
		assert.deepEqual(after, anchored);
	});

	test("an entry mutated in place is still reflected", () => {
		// The reason this class has no cache key. Guarding the regression that
		// switching it to a windowed component would have caused.
		const entries = [{ role: "assistant" as const, text: "first" }];
		const scrollable = build(entries);
		assert.equal(scrollable.render(WIDE)[0], "first");
		entries[0]!.text = "updated";
		assert.equal(scrollable.render(WIDE)[0], "updated");
	});
});
