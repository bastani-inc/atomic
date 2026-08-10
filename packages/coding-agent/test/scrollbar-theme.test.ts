import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { loadThemeFromContent } from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";

type ThemeJsonFixture = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

function loadDarkTheme(): ThemeJsonFixture {
	return JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	) as ThemeJsonFixture;
}

describe("scrollbar theme color", () => {
	it("falls back to selectedBg when scrollbarThumb is omitted", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "legacy-scrollbar-theme";
		delete themeJson.colors.scrollbarThumb;

		const loadedTheme = loadThemeFromContent("legacy-scrollbar-theme.json", JSON.stringify(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("scrollbarThumb")).toBe(loadedTheme.getBgAnsi("selectedBg"));
	});

	it("uses an explicitly configured scrollbarThumb", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-scrollbar-theme";
		themeJson.colors.scrollbarThumb = "#123456";

		const loadedTheme = loadThemeFromContent("custom-scrollbar-theme.json", JSON.stringify(themeJson), "truecolor");
		expect(loadedTheme.getBgAnsi("scrollbarThumb")).toBe("\x1b[48;2;18;52;86m");
	});

	it("accepts a user theme defining scrollbarThumb in both schema forms", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "schema-scrollbar-theme";
		themeJson.colors.scrollbarThumb = "#123456";
		const schema = JSON.parse(readFileSync(join(getThemesDir(), "theme-schema.json"), "utf8")) as object;
		const validateJsonSchema = new Ajv({ allErrors: true }).compile(schema);

		expect(validateJsonSchema(themeJson), JSON.stringify(validateJsonSchema.errors)).toBe(true);
		expect(validateThemeJson.Check(themeJson)).toBe(true);
		expect(loadThemeFromContent("schema-scrollbar-theme.json", JSON.stringify(themeJson), "truecolor").name).toBe(
			themeJson.name,
		);
	});
});
