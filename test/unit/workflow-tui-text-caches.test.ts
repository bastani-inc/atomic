import assert from "node:assert/strict";
import { truncateToWidth as piTruncateToWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { fillBackground } from "../../packages/workflows/src/tui/color-utils.ts";
import { BoundedTextCache, truncateToWidth } from "../../packages/workflows/src/tui/text-helpers.ts";

const rows = [
	"plain ascii row",
	"\x1b[38;2;120;120;120m╭────── worker-1 ──────╮\x1b[0m",
	"\x1b[1m✓ complete\x1b[0m 漢字 emoji 🚀 tail",
	"tab\tseparated\tcolumns",
	"\x1b]8;;https://example.com\x07link\x1b]8;;\x07 text",
];

test("workflow truncateToWidth matches pi-tui for fitting and overflowing rows", () => {
	for (const row of rows) {
		for (const width of [1, 4, 12, 24, 80]) {
			assert.equal(truncateToWidth(row, width, "…"), piTruncateToWidth(row, width, "…", false), `${row} @ ${width}`);
		}
	}
});

test("BoundedTextCache computes each key once and resets when full", () => {
	const cache = new BoundedTextCache(2);
	let computed = 0;
	const compute = (value: string) => () => {
		computed++;
		return value.toUpperCase();
	};
	assert.equal(cache.get("a", compute("a")), "A");
	assert.equal(cache.get("a", compute("a")), "A");
	assert.equal(computed, 1);
	cache.get("b", compute("b"));
	cache.get("c", compute("c"));
	cache.get("a", compute("a"));
	assert.equal(computed, 4);
});

test("fillBackground returns the same row for repeated frames", () => {
	const background = "\x1b[48;2;30;30;30m";
	const first = fillBackground("\x1b[1mstatus\x1b[0m hints", 40, background);
	assert.equal(fillBackground("\x1b[1mstatus\x1b[0m hints", 40, background), first);
	assert.notEqual(fillBackground("\x1b[1mstatus\x1b[0m hints", 30, background), first);
});
