import { describe, expect, it } from "vitest";
import {
	CONTRAST_AA_LARGE,
	CONTRAST_AA_NORMAL,
	colorValueToHex,
	contrastRatio,
	rateContrast,
	relativeLuminance,
} from "../src/modes/interactive/theme/color-utils.ts";

describe("WCAG contrast helpers", () => {
	it("computes relative luminance at the extremes", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	it("returns 21:1 for black on white and 1:1 for identical colors", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
		expect(contrastRatio("#808080", "#808080")).toBeCloseTo(1, 5);
	});

	it("is order-independent", () => {
		expect(contrastRatio("#123456", "#abcdef")).toBeCloseTo(contrastRatio("#abcdef", "#123456"), 10);
	});

	it("matches a known reference pair (#767676 on #ffffff ~= 4.54)", () => {
		expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
	});

	it("rates ratios against WCAG AA thresholds", () => {
		expect(rateContrast(CONTRAST_AA_NORMAL)).toBe("AA");
		expect(rateContrast(5)).toBe("AA");
		expect(rateContrast(CONTRAST_AA_LARGE)).toBe("AA-large");
		expect(rateContrast(4.49)).toBe("AA-large");
		expect(rateContrast(2.9)).toBe("FAIL");
	});

	it("resolves ColorValue forms to hex, and terminal-default to undefined", () => {
		expect(colorValueToHex("#a1b2c3")).toBe("#a1b2c3");
		expect(colorValueToHex("")).toBeUndefined();
		expect(colorValueToHex(15)).toBe("#ffffff"); // ansi 15 -> white approximation
	});
});
