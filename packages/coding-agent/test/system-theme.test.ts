import assert from "node:assert/strict";
import { colorToOklch, colorToRgb, parseColor, rgbColor } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { generateSystemThemeColors, wcagContrast } from "../src/modes/interactive/theme/system-theme.js";
import { detectTerminalTheme, setTerminalColors } from "../src/modes/interactive/theme/terminal-colors.js";
import { getAvailableThemes, getThemeByName } from "../src/modes/interactive/theme/theme.js";

const rgb = (hex: string) => colorToRgb(parseColor(hex));
afterEach(() => setTerminalColors({}));
test("system theme preserves readable body text across dark, light and mid-gray terminals", () => {
	for (const [background, foreground] of [
		["#282a36", "#f8f8f2"],
		["#fdf6e3", "#657b83"],
		["#808080", "#ffffff"],
	]) {
		const input = { background: rgb(background), foreground: rgb(foreground) };
		const { colors } = generateSystemThemeColors(input);
		const resolved = (token: "text" | "selectedBg" | "toolTitle" | "toolErrorBg") =>
			colors[token] === "" ? input.foreground : rgb(colors[token] as string);
		assert.ok(wcagContrast(resolved("text"), input.background) >= 4.5);
		assert.ok(wcagContrast(resolved("text"), resolved("selectedBg")) >= 4.5);
		assert.ok(wcagContrast(resolved("toolTitle"), resolved("toolErrorBg")) >= 4.5);
	}
});
test("system theme is selectable and closes faint styling when no terminal colors are available", () => {
	assert.equal(getAvailableThemes()[0], "system");
	const result = generateSystemThemeColors({});
	assert.equal(result.colors.error, 1);
	assert.equal(result.colors.userMessageBg, "");
	const theme = getThemeByName("system");
	assert.ok(theme);
	assert.match(theme.fg("muted", "x"), /\x1b\[22m\x1b\[39m$/);
});
test("terminal appearance uses background before scheme and only the last COLORFGBG field", () => {
	assert.equal(detectTerminalTheme({ background: rgb("#ffffff") }, "dark", {}), "light");
	assert.equal(detectTerminalTheme({}, undefined, { COLORFGBG: "15;default" }), "dark");
	assert.equal(detectTerminalTheme({}, undefined, { COLORFGBG: "0;7" }), "light");
});
test("system theme keeps pastel palette colors pastel at other lightnesses (#10255)", () => {
	const palette = ["#51576d", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#b5bfe2"]
		.concat(["#626880", "#e67172", "#8ec772", "#d9ba73", "#7b9ef0", "#f2a4db", "#5abfb5", "#a5adce"])
		.map(rgb);
	const frappe = { background: rgb("#303446"), foreground: rgb("#c6d0f5"), palette };
	const oklch = ({ r, g, b }: { r: number; g: number; b: number }) => colorToOklch(rgbColor(r, g, b));
	const { colors } = generateSystemThemeColors(frappe);
	const resolved = (token: "accent" | "userMessageBg" | "customMessageBg") => rgb(colors[token] as string);

	const pink = oklch(palette[5]);
	const accent = oklch(resolved("accent"));
	assert.ok(accent.l < pink.l - 0.05);
	assert.ok(accent.c <= pink.c * 1.03);
	for (const panel of ["userMessageBg", "customMessageBg"] as const) {
		assert.ok(oklch(resolved(panel)).c <= 0.1, panel);
	}
});
