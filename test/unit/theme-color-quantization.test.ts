import assert from "node:assert/strict";
import { test } from "vitest";
import { ansi256ToHex, bgAnsi } from "../../packages/coding-agent/src/modes/interactive/theme/color-utils.ts";

/**
 * `rgbTo256` is module-private; `bgAnsi(hex, "256color")` is the public surface that
 * carries its result, emitting `ESC[48;5;<index>m`. Recovering the index there exercises
 * the quantizer through the public API, and `ansi256ToHex` expands it back into the
 * colour space the bug report is written in.
 */
function quantize(hex: string): { index: number; hex: string } {
	const sgr = bgAnsi(hex, "256color");
	const match = /^\x1b\[48;5;(\d+)m$/.exec(sgr);
	assert.ok(match, `expected a 256-colour background sequence for ${hex}, got ${JSON.stringify(sgr)}`);
	const index = Number(match[1]);
	return { index, hex: ansi256ToHex(index) };
}

// Regression: #2550 — near-neutral dark backgrounds quantize onto the 6x6x6 cube instead of
// the far closer 232-255 grayscale ramp. Both expected values below are the true nearest
// palette entry, confirmed by brute-force argmin over all 216 cube + 24 grayscale entries
// under the module's weighted distance (0.299/0.587/0.114).
test("quantizes near-neutral dark backgrounds onto the nearest grayscale ramp entry", () => {
	// rgb(52,53,65): cube gives #5f5f5f at weighted distance ~1691; grey 237 sits at ~31.
	assert.deepEqual(quantize("#343541"), { index: 237, hex: "#3a3a3a" });

	// rgb(40,40,50): cube invents a blue (#00005f) because b rounds up to 95 while r,g round to 0.
	assert.deepEqual(quantize("#282832"), { index: 235, hex: "#262626" });

	// Rounded luminance chooses 236, but actual weighted distance favors 237.
	assert.deepEqual(quantize("#2f3a2f"), { index: 237, hex: "#3a3a3a" });
	assert.deepEqual(quantize("#000000"), { index: 16, hex: "#000000" });
	assert.deepEqual(quantize("#ffffff"), { index: 231, hex: "#ffffff" });
	assert.deepEqual(quantize("#808080"), { index: 244, hex: "#808080" });
});

test("preserves saturated colors and vivid theme accents without changing truecolor", () => {
	const cases: [string, number][] = [
		["#ff0000", 196],
		["#00ff00", 46],
		["#0000ff", 21],
		["#00d7ff", 45],
		["#5f87ff", 69],
		["#ffff00", 226],
	];
	for (const [hex, index] of cases) {
		assert.deepEqual(quantize(hex), { index, hex });
		assert.ok(index >= 16 && index < 232);
	}
	for (const hex of ["#343541", "#282832", "#2f3a2f", ...cases.map(([hex]) => hex)]) {
		const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
		assert.equal(bgAnsi(hex, "truecolor"), `\x1b[48;2;${channels.join(";")}m`);
	}
});

// Regression: #2550. Stride 5 includes both endpoints: 52^3 = 140,608 inputs.
// Compare every result with all 216 cube and 24 ramp entries; equal minima are valid.
test("returns a nearest palette entry across a stride-5 RGB sweep", () => {
	const palette = Array.from({ length: 240 }, (_, offset) => {
		const hex = ansi256ToHex(offset + 16);
		return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
	});
	for (let r = 0; r <= 255; r += 5) {
		for (let g = 0; g <= 255; g += 5) {
			for (let b = 0; b <= 255; b += 5) {
				const hex = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
				const { index } = quantize(hex);
				assert.ok(index >= 16 && index <= 255);
				const distance = ([pr, pg, pb]: number[]) =>
					0.299 * (r - pr) ** 2 + 0.587 * (g - pg) ** 2 + 0.114 * (b - pb) ** 2;
				const actual = distance(palette[index - 16]);
				const minimum = Math.min(...palette.map(distance));
				assert.equal(actual, minimum, `${hex}: index ${index} is not a nearest palette entry`);
			}
		}
	}
});
