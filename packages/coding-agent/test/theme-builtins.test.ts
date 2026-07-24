import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	isLightTheme,
	loadThemeFromContent,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";

const BUNDLED_THEME_NAMES = [
	"catppuccin-frappe",
	"catppuccin-latte",
	"catppuccin-macchiato",
	"catppuccin-mocha",
	"dark",
	"light",
] as const;

const CATPPUCCIN_THEMES = [
	"catppuccin-frappe",
	"catppuccin-latte",
	"catppuccin-macchiato",
	"catppuccin-mocha",
] as const;

const ATOMIC_THEME_SCHEMA_URL = "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

describe("built-in themes", () => {
	it("includes the bundled Catppuccin themes", () => {
		const availableThemes = getAvailableThemes();

		for (const themeName of CATPPUCCIN_THEMES) {
			expect(availableThemes).toContain(themeName);
		}
	});

	it("loads every bundled Catppuccin theme by name", () => {
		for (const themeName of CATPPUCCIN_THEMES) {
			expect(getThemeByName(themeName)?.name).toBe(themeName);
		}
	});

	it("reports built-in Catppuccin theme file paths", () => {
		const themePaths = new Map(getAvailableThemesWithPaths().map((theme) => [theme.name, theme.path]));

		for (const themeName of CATPPUCCIN_THEMES) {
			expect(themePaths.get(themeName)).toMatch(new RegExp(`${themeName}\\.json$`));
		}
	});

	it("treats Catppuccin Latte as a light theme", () => {
		expect(isLightTheme("catppuccin-latte")).toBe(true);
		expect(isLightTheme("catppuccin-mocha")).toBe(false);
	});

	it("validates every bundled theme against its declared Atomic-owned local schema", () => {
		const themesDir = getThemesDir();
		const schemaPath = join(themesDir, "theme-schema.json");
		const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
		expect(schema.title).toBe("Atomic Coding Agent Theme");
		expect(schema.description).toBe("Theme schema for the Atomic coding agent");
		const validateDeclaredSchema = new Ajv({ allErrors: true }).compile(schema);

		for (const name of BUNDLED_THEME_NAMES) {
			const content = JSON.parse(readFileSync(join(themesDir, `${name}.json`), "utf8"));
			expect(content.$schema, name).toBe(ATOMIC_THEME_SCHEMA_URL);
			expect(validateDeclaredSchema(content), `${name}: ${JSON.stringify(validateDeclaredSchema.errors)}`).toBe(true);
			expect(validateThemeJson.Check(content), name).toBe(true);
		}
	});

	it("keeps the schema declaration optional for valid custom themes", () => {
		const content = JSON.parse(readFileSync(join(getThemesDir(), "dark.json"), "utf8"));
		delete content.$schema;
		content.name = "valid-custom-no-schema";
		expect(validateThemeJson.Check(content)).toBe(true);
		expect(loadThemeFromContent("valid-custom-no-schema.json", JSON.stringify(content)).name).toBe(content.name);
	});
});
