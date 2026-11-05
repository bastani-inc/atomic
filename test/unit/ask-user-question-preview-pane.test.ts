/**
 * First coverage for `PreviewPane` and for the active-row mark that its
 * side-by-side join buries mid-line.
 *
 * The defect these guard: `OVERLAY_ACTIVE_ROW_MARKER` used a BEL terminator,
 * which ECMA-48 allows for OSC but not for APC. `PreviewPane.renderSideBySide`
 * glues the preview column onto the same physical line as the option row, so on
 * the selected row the mark sat mid-line with the pad, the column gap, and the
 * box border behind it. tmux kept consuming those bytes as APC payload and drew
 * the border 11-13 columns early — on the active row alone. See TMUX-EVIDENCE.md.
 */
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	OVERLAY_ACTIVE_ROW_MARKER,
	stripOverlayActiveRowMarker,
} from "../../packages/coding-agent/src/core/extensions/ui-types.ts";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import type {
	QuestionData,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { OptionListView } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/option-list-view.ts";
import { crossTabLeftWidthWithDonation } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.ts";
import {
	PreviewBlockRenderer,
	PreviewPane,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-pane.js";
import type { WrappingSelectItem } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.ts";
import { getMarkdownTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const BOX_A = [
	"```text",
	"╭──────────────────────────╮",
	"│  api ──▶ db              │",
	"╰──────────────────────────╯",
	"```",
].join("\n");
const BOX_B = [
	"```text",
	"╭──────────────────────────╮",
	"│  api ──▶ cache ──▶ db    │",
	"╰──────────────────────────╯",
	"```",
].join("\n");

/** Box-drawing characters the previews above draw with. */
const BOX_CHARS = new Set(["╭", "╮", "╰", "╯", "│", "─", "┌", "┐", "└", "┘"]);

/** Wide enough that `decideLayout` picks side-by-side; matches the tmux repro's 140-column pane. */
const SIDE_BY_SIDE_TERMINAL_WIDTH = 140;
const SIDE_BY_SIDE_PANE_WIDTH = 120;
/** Below `PREVIEW_MIN_WIDTH`, so `decideLayout` falls back to stacked. */
const STACKED_TERMINAL_WIDTH = 80;
const STACKED_PANE_WIDTH = 70;

function previewQuestion(): QuestionData {
	return {
		question: "PREVIEW-ALIGN-QUESTION",
		header: "Storage",
		options: [
			{ label: "Encrypt at rest", description: "AES-256 at rest", preview: BOX_A },
			{ label: "Plaintext storage", description: "Nothing encrypted", preview: BOX_B },
		],
	};
}

interface Harness {
	readonly pane: PreviewPane;
	readonly render: (selectedIndex: number, paneWidth: number) => string[];
}

/** Mirrors `QuestionnaireBuilder.buildTabFor` + `injectGlobalLeftWidth`. */
function makePane(question: QuestionData, terminalWidth: number): Harness {
	initTheme();
	const markdownTheme = getMarkdownTheme();
	const selectTheme = {
		selectedText: (s: string) => theme.fg("accent", theme.bold(s)),
		description: (s: string) => theme.fg("muted", s),
		scrollInfo: (s: string) => theme.fg("dim", s),
	};
	const items: readonly WrappingSelectItem[] = buildItemsForQuestion(question);
	const optionListView = new OptionListView({ items, theme: selectTheme });
	const previewBlock = new PreviewBlockRenderer({ question, theme, markdownTheme });
	const pane = new PreviewPane({
		question,
		getTerminalWidth: () => terminalWidth,
		optionListView,
		previewBlock,
	});
	pane.setGlobalLeftWidth((paneWidth: number) =>
		crossTabLeftWidthWithDonation([{ multiSelect: question.multiSelect }], [items], [question], paneWidth),
	);
	return {
		pane,
		render: (selectedIndex, paneWidth) => {
			optionListView.setProps({ selectedIndex, focused: true, inputBuffer: "", inputCaret: 0 });
			pane.setProps({ notesVisible: false, selectedIndex, focused: true });
			return pane.render(paneWidth);
		},
	};
}

/**
 * Visible column of the first box-drawing character on `line`, or -1 when the
 * row draws none. Every escape sequence is removed first — CSI, OSC, and APC —
 * so the result is the cell a conforming terminal draws that character in,
 * which is what the tmux capture measures.
 */
function borderColumn(line: string): number {
	const plain = line
		.replace(/\x1b[\]_P^X][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "");
	let column = 0;
	for (const ch of plain) {
		if (BOX_CHARS.has(ch)) return column;
		column += visibleWidth(ch);
	}
	return -1;
}

test("OVERLAY_ACTIVE_ROW_MARKER terminates its APC string with ST, not BEL", () => {
	assert.equal(OVERLAY_ACTIVE_ROW_MARKER.startsWith("\u001B_"), true);
	assert.equal(OVERLAY_ACTIVE_ROW_MARKER.endsWith("\u001B\\"), true);
	assert.equal(OVERLAY_ACTIVE_ROW_MARKER.includes("\u0007"), false);
});

test("the mark still measures as zero cells, so no column arithmetic moves", () => {
	assert.equal(visibleWidth(OVERLAY_ACTIVE_ROW_MARKER), 0);
	assert.equal(visibleWidth(`ab${OVERLAY_ACTIVE_ROW_MARKER}cd`), 4);
});

test("stripOverlayActiveRowMarker removes every occurrence and preserves everything else", () => {
	const lines = [
		`❯ 1. Encrypt at rest${OVERLAY_ACTIVE_ROW_MARKER}   ┌───┐`,
		"  2. Plaintext storage   │   │",
		`${OVERLAY_ACTIVE_ROW_MARKER}twice${OVERLAY_ACTIVE_ROW_MARKER}`,
	];
	const stripped = stripOverlayActiveRowMarker(lines);
	assert.equal(
		stripped.some((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER)),
		false,
	);
	assert.deepEqual(stripped, ["❯ 1. Encrypt at rest   ┌───┐", "  2. Plaintext storage   │   │", "twice"]);
	for (const [i, line] of lines.entries()) {
		assert.equal(visibleWidth(stripped[i] ?? ""), visibleWidth(line));
	}
});

test("stripOverlayActiveRowMarker is a no-op on unmarked lines", () => {
	const lines = ["  1. Encrypt at rest", "", "  2. Plaintext storage"];
	assert.deepEqual(stripOverlayActiveRowMarker(lines), lines);
});

test("no side-by-side row exceeds the pane width, for every selection", () => {
	const { render } = makePane(previewQuestion(), SIDE_BY_SIDE_TERMINAL_WIDTH);
	for (const selectedIndex of [0, 1]) {
		const rows = render(selectedIndex, SIDE_BY_SIDE_PANE_WIDTH);
		assert.ok(rows.length > 1, `expected multiple rows for selection ${selectedIndex}`);
		for (const row of rows) assert.ok(visibleWidth(row) <= SIDE_BY_SIDE_PANE_WIDTH);
	}
});

test("the mark adds no measured width to the row it sits on", () => {
	const { render } = makePane(previewQuestion(), SIDE_BY_SIDE_TERMINAL_WIDTH);
	for (const selectedIndex of [0, 1]) {
		const rows = render(selectedIndex, SIDE_BY_SIDE_PANE_WIDTH);
		const stripped = stripOverlayActiveRowMarker(rows);
		assert.deepEqual(
			rows.map((row) => visibleWidth(row)),
			stripped.map((row) => visibleWidth(row)),
		);
	}
});

test("exactly one side-by-side row carries the mark, and it is the selected option's row", () => {
	const { render } = makePane(previewQuestion(), SIDE_BY_SIDE_TERMINAL_WIDTH);
	for (const selectedIndex of [0, 1]) {
		const rows = render(selectedIndex, SIDE_BY_SIDE_PANE_WIDTH);
		const marked = rows.filter((row) => row.includes(OVERLAY_ACTIVE_ROW_MARKER));
		assert.equal(marked.length, 1, `selection ${selectedIndex} marked ${marked.length} rows`);
		const label = selectedIndex === 0 ? "Encrypt at rest" : "Plaintext storage";
		assert.equal((marked[0] ?? "").includes(label), true);
	}
});

test("the preview box border lands on the same column on every row, for every selection", () => {
	const { render } = makePane(previewQuestion(), SIDE_BY_SIDE_TERMINAL_WIDTH);
	for (const selectedIndex of [0, 1]) {
		const rows = stripOverlayActiveRowMarker(render(selectedIndex, SIDE_BY_SIDE_PANE_WIDTH));
		const columns = rows.map(borderColumn).filter((column) => column >= 0);
		assert.ok(columns.length >= 3, `selection ${selectedIndex} drew ${columns.length} box rows`);
		const distinct = new Set(columns);
		assert.equal(distinct.size, 1, `selection ${selectedIndex} drew borders at columns ${columns.join(",")}`);
	}
});

test("stripping the mark does not move the box border on the active row", () => {
	const { render } = makePane(previewQuestion(), SIDE_BY_SIDE_TERMINAL_WIDTH);
	for (const selectedIndex of [0, 1]) {
		const rows = render(selectedIndex, SIDE_BY_SIDE_PANE_WIDTH);
		const stripped = stripOverlayActiveRowMarker(rows);
		assert.deepEqual(stripped.map(borderColumn), rows.map(borderColumn));
	}
});

test("stacked layout leaves the mark at end of line", () => {
	const { render } = makePane(previewQuestion(), STACKED_TERMINAL_WIDTH);
	const rows = render(1, STACKED_PANE_WIDTH);
	const marked = rows.filter((row) => row.includes(OVERLAY_ACTIVE_ROW_MARKER));
	assert.equal(marked.length, 1);
	assert.equal((marked[0] ?? "").endsWith(OVERLAY_ACTIVE_ROW_MARKER), true);
});

test("multi-select bypasses the preview pane and leaves the mark at end of line", () => {
	const question: QuestionData = { ...previewQuestion(), multiSelect: true };
	const { render } = makePane(question, SIDE_BY_SIDE_TERMINAL_WIDTH);
	const rows = render(1, SIDE_BY_SIDE_PANE_WIDTH);
	const marked = rows.filter((row) => row.includes(OVERLAY_ACTIVE_ROW_MARKER));
	assert.equal(marked.length, 1);
	assert.equal((marked[0] ?? "").endsWith(OVERLAY_ACTIVE_ROW_MARKER), true);
});

test("a question with no previews renders the option list untouched", () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Which option?",
				header: "Choice",
				options: [
					{ label: "Alpha", description: "First option" },
					{ label: "Beta", description: "Second option" },
				],
			},
		],
	};
	const question = params.questions[0];
	assert.ok(question);
	const { render } = makePane(question, SIDE_BY_SIDE_TERMINAL_WIDTH);
	const rows = render(0, SIDE_BY_SIDE_PANE_WIDTH);
	assert.equal(
		rows.every((row) => borderColumn(row) === -1),
		true,
	);
});

test("a multi-select pane measures its option list alone, as it renders (#4333)", () => {
	const question: QuestionData = { ...previewQuestion(), multiSelect: true };
	const { pane, render } = makePane(question, SIDE_BY_SIDE_TERMINAL_WIDTH);
	const rows = render(1, SIDE_BY_SIDE_PANE_WIDTH);
	assert.equal(pane.maxNaturalHeight(SIDE_BY_SIDE_PANE_WIDTH), rows.length);
});

test("a preview pane's measured height covers its tallest preview at the rendered width (#4333)", () => {
	for (const terminalWidth of [SIDE_BY_SIDE_TERMINAL_WIDTH, STACKED_TERMINAL_WIDTH]) {
		const paneWidth = terminalWidth === SIDE_BY_SIDE_TERMINAL_WIDTH ? SIDE_BY_SIDE_PANE_WIDTH : STACKED_PANE_WIDTH;
		const { pane, render } = makePane(previewQuestion(), terminalWidth);
		const tallest = Math.max(render(0, paneWidth).length, render(1, paneWidth).length);
		assert.equal(pane.maxNaturalHeight(paneWidth), tallest);
	}
});
