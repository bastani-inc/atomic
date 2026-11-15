import { compositeTuiLine, visibleWidth } from "@bastani/atomic-tui";
import { describe, expect, it } from "vitest";
import { compositeOverlayLine } from "../src/modes/interactive/overlay-line-composite.ts";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

function stripSequences(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, "");
}

describe("compositeOverlayLine", () => {
	const base = "\x1b[38;5;244mmain chat line with ✓ glyphs and 漢字\x1b[0m trailing";

	it("matches pi-tui for partial-width overlays", () => {
		const overlay = "\x1b[1mpicker\x1b[0m";
		expect(compositeOverlayLine(base, overlay, 4, 20, 60)).toBe(compositeTuiLine(base, overlay, 4, 20, 60));
	});

	it("paints a full-width overlay row without reading the hidden base line", () => {
		const overlay = "\x1b[48;5;236m graph ✓ 漢字 \x1b[0m";
		const result = compositeOverlayLine(base, overlay, 0, 40, 40);
		expect(result.startsWith(SEGMENT_RESET)).toBe(true);
		expect(result.endsWith(SEGMENT_RESET)).toBe(true);
		expect(visibleWidth(result)).toBe(40);
		expect(stripSequences(result)).toBe(stripSequences(compositeTuiLine(base, overlay, 0, 40, 40)));
	});

	it("delegates to pi-tui when the base row carries an inline image", () => {
		const imageRow = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		expect(compositeOverlayLine(imageRow, "overlay", 0, 20, 20)).toBe(
			compositeTuiLine(imageRow, "overlay", 0, 20, 20),
		);
	});

	it("delegates to pi-tui when the overlay row is wider than its slot", () => {
		const wide = "x".repeat(30);
		expect(compositeOverlayLine(base, wide, 0, 20, 20)).toBe(compositeTuiLine(base, wide, 0, 20, 20));
	});
});
