import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	isLightTheme,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";

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
		const themes = getAvailableThemesWithPaths();
		const schemaPath = join(dirname(themes[0]!.path), "theme-schema.json");
		const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
		expect(schema.title).toBe("Atomic Coding Agent Theme");
		expect(schema.description).toBe("Theme schema for the Atomic coding agent");
		const validateDeclaredSchema = new Ajv({ allErrors: true }).compile(schema);

		for (const bundled of themes) {
			const content = JSON.parse(readFileSync(bundled.path, "utf8"));
			expect(content.$schema, bundled.name).toBe(ATOMIC_THEME_SCHEMA_URL);
			expect(validateDeclaredSchema(content), `${bundled.name}: ${JSON.stringify(validateDeclaredSchema.errors)}`).toBe(true);
			expect(validateThemeJson.Check(content), bundled.name).toBe(true);
		}
	});
});
