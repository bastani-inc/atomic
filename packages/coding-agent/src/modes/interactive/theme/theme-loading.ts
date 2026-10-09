import * as fs from "node:fs";
import * as path from "node:path";
import { getCustomThemesDir, getThemesDir } from "../../../config.js";
import { type ColorMode, detectColorMode, resolveThemeColors } from "./color-utils.ts";
import { generateSystemThemeColors, SYSTEM_THEME_NAME } from "./system-theme.js";
import { areTerminalColorsPending, getTerminalColors, getTerminalTheme } from "./terminal-colors.js";
import { Theme, type ThemeColor, type WorkingIndicatorTone } from "./theme-class.ts";
import { assertThemeNameIsValid, parseThemeJsonContent } from "./theme-parse.ts";
import type { ThemeJson } from "./theme-schema.ts";
import { splitThemeColors, withThemeTokenFallbacks } from "./theme-tokens.ts";

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;
const registeredThemes = new Map<string, Theme>();

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const themes: Record<string, ThemeJson> = {};
		for (const file of fs.readdirSync(themesDir).sort()) {
			if (!file.endsWith(".json")) {
				continue;
			}
			const themePath = path.join(themesDir, file);
			const themeJson = parseThemeJsonContent(themePath, fs.readFileSync(themePath, "utf-8"));
			themes[themeJson.name] = themeJson;
		}
		BUILTIN_THEMES = themes;
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (info: ThemeInfo) => {
		if (seen.has(info.name)) return;
		seen.add(info.name);
		result.push(info);
	};
	addTheme({ name: SYSTEM_THEME_NAME, path: undefined });

	// Built-in themes
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	for (const info of getCustomThemeInfos()) {
		addTheme(info);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) =>
		a.name === SYSTEM_THEME_NAME ? -1 : b.name === SYSTEM_THEME_NAME ? 1 : a.name.localeCompare(b.name),
	);
}

function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// Invalid themes are ignored here; the resource loader reports them
			// during normal startup/reload.
		}
	}
	return result;
}

export function loadThemeJson(name: string): ThemeJson {
	if (name === SYSTEM_THEME_NAME)
		return {
			name,
			colors: generateSystemThemeColors({
				...getTerminalColors(),
				saturation: areTerminalColorsPending() ? 0 : 1,
				appearanceHint: getTerminalTheme(),
			}).colors,
		};
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string, dim?: ThemeColor[]): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const workingIndicator = themeJson.workingIndicator
		? resolveThemeColors(themeJson.workingIndicator, themeJson.vars)
		: undefined;
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(resolvedColors));
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
		workingIndicator: workingIndicator as Partial<Record<WorkingIndicatorTone, string | number>> | undefined,
		dim,
	});
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	return loadThemeFromContent(themePath, content, mode);
}

export function loadThemeFromContent(themePath: string, content: string, mode?: ColorMode): Theme {
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

export function loadTheme(name: string, mode?: ColorMode): Theme {
	if (name === SYSTEM_THEME_NAME) {
		const generated = generateSystemThemeColors({
			...getTerminalColors(),
			saturation: areTerminalColorsPending() ? 0 : 1,
			appearanceHint: getTerminalTheme(),
		});
		return createTheme({ name, colors: generated.colors }, mode, undefined, generated.dim);
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			assertThemeNameIsValid(theme.name);
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function setRegisteredTheme(name: string, theme: Theme): void {
	registeredThemes.set(name, theme);
}
