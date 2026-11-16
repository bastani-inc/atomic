import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { before, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { truncateToWidth, visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Characters of text made of CSI and OSC introducers that are never terminated. A scan that searches the rest of the
 * text again at every introducer takes over a second over this many.
 */
const LONG_TEXT_LENGTH = 40_000;
/** Marks in one grapheme cluster. Matching it with a backtracking pattern takes seconds; a linear match, microseconds. */
const LONG_CLUSTER_MARKS = 28;
/**
 * How long one measurement, truncation or editor render may take. Linear scanning takes tens of milliseconds even on a
 * loaded machine; quadratic scanning took one to two seconds over LONG_TEXT_LENGTH characters.
 */
const LINEAR_BUDGET_MS = 500;

/**
 * `length` characters of CSI and OSC introducers in turn, starting with `first`. Tests start differently because
 * `visibleWidth` caches widths by content, and a cached width would hide the scan under test.
 */
function unterminatedIntroducers(length: number, first: "csi" | "osc"): string {
	return (first === "csi" ? "\x1b[\x1b]" : "\x1b]\x1b[").repeat(length / 4);
}

function timed<T>(run: () => T): { value: T; elapsed: number } {
	const started = performance.now();
	const value = run();
	return { value, elapsed: performance.now() - started };
}

describe("escape-laden text scaling", () => {
	// Compile the code under test on short text first, so a timing does not include its first compilation.
	before(() => {
		const sample = unterminatedIntroducers(400, "csi");
		visibleWidth(sample);
		truncateToWidth(sample, 120);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(120, 40)), defaultEditorTheme);
		editor.setText(sample);
		editor.render(120);
	});

	it("measures 40k characters of unterminated introducers in linear time", () => {
		const { value: width, elapsed } = timed(() => visibleWidth(unterminatedIntroducers(LONG_TEXT_LENGTH, "csi")));
		assert.strictEqual(width, LONG_TEXT_LENGTH / 2, "each ESC is zero-width and each bracket is one column");
		assert.ok(elapsed < LINEAR_BUDGET_MS, `visibleWidth took ${Math.round(elapsed)} ms`);
	});

	it("truncates 40k characters of unterminated introducers to 120 columns in linear time", () => {
		const text = unterminatedIntroducers(LONG_TEXT_LENGTH, "csi");
		const { value: truncated, elapsed } = timed(() => truncateToWidth(text, 120));
		// 117 brackets fit before the ellipsis, and the zero-width ESC after the last of them is kept too.
		assert.strictEqual(truncated, `${text.slice(0, 235)}\x1b[0m...\x1b[0m`);
		assert.ok(elapsed < LINEAR_BUDGET_MS, `truncateToWidth took ${Math.round(elapsed)} ms`);
	});

	it("lays out 40k characters of unterminated introducers in the editor in linear time", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(120, 40)), defaultEditorTheme);
		editor.setText(unterminatedIntroducers(LONG_TEXT_LENGTH, "osc"));
		const { value: lines, elapsed } = timed(() => editor.render(120));
		assert.ok(lines.length > 2, "the editor renders its borders and the visible text lines");
		assert.ok(elapsed < LINEAR_BUDGET_MS, `Editor.render took ${Math.round(elapsed)} ms`);
	});

	it("measures a long grapheme cluster of ignorable marks in linear time", () => {
		// U+034F is both a mark and default-ignorable; the skin-tone modifier ending the cluster is neither.
		const cluster = `${"\u034f".repeat(LONG_CLUSTER_MARKS)}\u{1f3fb}`;
		const { value: width, elapsed } = timed(() => visibleWidth(cluster));
		assert.strictEqual(width, 2);
		assert.ok(elapsed < LINEAR_BUDGET_MS, `visibleWidth took ${Math.round(elapsed)} ms`);
	});

	it("measures a long grapheme cluster of spacing marks in linear time", () => {
		// U+0F7F is a spacing mark that legacy wcwidth tables also list; the grave accent ending the cluster is neither.
		const cluster = `${"\u0f7f".repeat(LONG_CLUSTER_MARKS)}\u0300`;
		const { value: width, elapsed } = timed(() => visibleWidth(cluster));
		assert.strictEqual(width, 0);
		assert.ok(elapsed < LINEAR_BUDGET_MS, `visibleWidth took ${Math.round(elapsed)} ms`);
	});
});
