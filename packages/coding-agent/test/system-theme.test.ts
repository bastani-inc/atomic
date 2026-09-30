import assert from "node:assert/strict";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";
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
