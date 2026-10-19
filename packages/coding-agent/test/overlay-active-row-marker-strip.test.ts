import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { OVERLAY_ACTIVE_ROW_MARKER, stripOsc133Marks } from "../src/core/extensions/ui-types.ts";
import { createFullscreenTui, createInteractiveTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

/**
 * `OVERLAY_ACTIVE_ROW_MARKER` is the zero-width mark a custom component puts on
 * the row it needs kept on screen. Only `ReservedBottomOverlay.takeActiveRow`
 * used to remove it, so every host that mounts a component without that wrapper
 * — the workflows stage-chat slot among them — painted the mark straight to the
 * terminal. In `ask_user_question`'s side-by-side preview layout the mark sits
 * mid-line, and tmux, which follows ECMA-48 in ending an APC string on ST
 * rather than BEL, swallowed the pad and the column gap behind it and drew the
 * preview box border 11-13 columns early on the selected row alone.
 *
 * Both renderers now strip the mark in `applyLineResets`, pi-tui's last
 * transform over the composited screen. These assert on the bytes the terminal
 * actually receives, which is the only place the defect was ever visible.
 */

/** A component that marks its active row the way `WrappingSelect` does — mid-line, in side-by-side layout. */
class MarkedRowComponent implements Component {
	constructor(private readonly activeRow: number) {}

	render(): string[] {
		return [
			"  1. Encrypt at rest             |  box row 1",
			"  2. Plaintext storage           |  box row 2",
			"  3. Chat about this             |  box row 3",
		].map((row, index) =>
			index === this.activeRow ? `${row.slice(0, 22)}${OVERLAY_ACTIVE_ROW_MARKER}${row.slice(22)}` : row,
		);
	}

	handleInput(): boolean {
		return false;
	}

	invalidate(): void {}
}

const originalTerm = process.env.TERM;

afterEach(() => {
	if (originalTerm === undefined) delete process.env.TERM;
	else process.env.TERM = originalTerm;
});

test("the mark measures zero cells, so stripping it moves no column", () => {
	assert.equal(visibleWidth(OVERLAY_ACTIVE_ROW_MARKER), 0);
	assert.equal(OVERLAY_ACTIVE_ROW_MARKER.endsWith("\u001B\\"), true);
	assert.equal(OVERLAY_ACTIVE_ROW_MARKER.includes("\u0007"), false);
});

test("the fullscreen renderer never writes the active-row mark to the terminal", () => {
	const terminal = new RecordingTerminal();
	terminal.columns = 60;
	terminal.rows = 10;
	const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal });
	try {
		for (const activeRow of [0, 1, 2]) {
			tui.setLayoutRoot(new MarkedRowComponent(activeRow));
			tui.start();
			tui.renderNow(true);
			const written = terminal.writes.join("");
			assert.equal(
				written.includes(OVERLAY_ACTIVE_ROW_MARKER),
				false,
				`active row ${activeRow} leaked the mark to the terminal`,
			);
			assert.equal(written.includes("\u001B_atomic:active"), false);
			assert.equal(written.includes("Encrypt at rest"), true, "the frame itself must still be painted");
		}
	} finally {
		tui.stop();
	}
});

test("the main-screen fallback renderer never writes the active-row mark either", () => {
	process.env.TERM = "dumb";
	const terminal = new RecordingTerminal();
	terminal.columns = 60;
	terminal.rows = 10;
	const tui = createInteractiveTui({ showHardwareCursor: false, logDirectory: tmpdir(), terminal });
	assert.equal(tui.mode, "regular", "TERM=dumb must select the main-screen fallback");
	try {
		tui.addChild(new MarkedRowComponent(1));
		tui.start();
		tui.renderNow(true);
		const written = terminal.writes.join("");
		assert.equal(written.includes(OVERLAY_ACTIVE_ROW_MARKER), false);
		assert.equal(written.includes("\u001B_atomic:active"), false);
		assert.equal(written.includes("Plaintext storage"), true);
	} finally {
		tui.stop();
	}
});

test("strips OSC 133 A/B/C marks anywhere in a line, with BEL or ST terminators (#3739)", () => {
	const cases: Array<[string, string]> = [
		["\x1b]133;A\x07prompt", "prompt"],
		["\x1b]133;B\x1b\\prompt", "prompt"],
		["mid \x1b]133;C\x07line", "mid line"],
		["mid \x1b]133;A;cl=m\x1b\\line", "mid line"],
		["end\x1b]133;C;exit=0\x1b\\", "end"],
		["\x1b]133;A\x07a\x1b]133;B\x1b\\b\x1b]133;C\x07c", "abc"],
	];
	for (const [input, expected] of cases) {
		const [stripped] = stripOsc133Marks([input]);
		assert.equal(stripped, expected, JSON.stringify(input));
		assert.equal(visibleWidth(stripped), visibleWidth(input), "stripping must not move a column");
	}
});

test("keeps OSC 133 D, other OSC sequences, unmarked lines, and line order (#3739)", () => {
	const lines = [
		"plain",
		"\x1b]133;D;0\x07done",
		'\x1b]7501;{"state":"working"}\x07status',
		"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
		"",
		"\x1b[31mred\x1b[0m",
	];
	assert.deepEqual(stripOsc133Marks(lines), lines);
	assert.deepEqual(stripOsc133Marks(["one\x1b]133;A\x07", "two", "\x1b]133;B\x07three"]), ["one", "two", "three"]);
});
