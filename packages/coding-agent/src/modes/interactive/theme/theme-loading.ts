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

let BUILTIN_THEMES: { directory: string; themes: Record<string, ThemeJson> } | undefined;
const registeredThemes = new Map<string, Theme>();
const themeSources = new WeakMap<Theme, ThemeJson>();

interface CustomThemeFile {
	path: string;
	content: string;
}

let customThemeFiles: { directory: string; files: Map<string, CustomThemeFile> } | undefined;

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getBuiltinThemes(): Record<string, ThemeJson> {
	return loadedBuiltinThemes().themes;
}

function loadedBuiltinThemes(): { directory: string; themes: Record<string, ThemeJson> } {
	BUILTIN_THEMES ??= readBuiltinThemes();
	return BUILTIN_THEMES;
}

function readBuiltinThemes(): { directory: string; themes: Record<string, ThemeJson> } {
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
	return { directory: themesDir, themes };
}

function getCustomThemeFiles(): Map<string, CustomThemeFile> {
	const directory = getCustomThemesDir();
	if (customThemeFiles?.directory !== directory) {
		customThemeFiles = { directory, files: readCustomThemeFiles(directory) };
	}
	return customThemeFiles.files;
}

function readCustomThemeFiles(customThemesDir: string): Map<string, CustomThemeFile> {
	const files = new Map<string, CustomThemeFile>();
	let entries: string[];
	try {
		entries = fs.readdirSync(customThemesDir);
	} catch {
		return files;
	}
	for (const file of entries) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			files.set(file, { path: themePath, content: fs.readFileSync(themePath, "utf-8") });
		} catch {}
	}
	return files;
}

export function readThemeFiles(): void {
	getBuiltinThemes();
	getCustomThemeFiles();
}

export async function refreshCustomThemes(): Promise<void> {
	const customThemesDir = getCustomThemesDir();
	const files = new Map<string, CustomThemeFile>();
	let entries: string[] = [];
	try {
		entries = await fs.promises.readdir(customThemesDir);
	} catch {}
	for (const file of entries) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			files.set(file, { path: themePath, content: await fs.promises.readFile(themePath, "utf-8") });
		} catch {}
	}
	customThemeFiles = { directory: customThemesDir, files };
}

export function hasCustomThemeFile(name: string): boolean {
	const fileName = `${name}.json`;
	if (getCustomThemeFiles().has(fileName)) return true;
	return registeredThemes.get(name)?.sourcePath === path.join(getCustomThemesDir(), fileName);
}

export function getThemeWatchPath(name: string): string | undefined {
	const registered = registeredThemes.get(name);
	if (registered) return registered.sourcePath;
	return getCustomThemeFiles().get(`${name}.json`)?.path;
}

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const builtinThemes = loadedBuiltinThemes();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (info: ThemeInfo) => {
		if (seen.has(info.name)) return;
		seen.add(info.name);
		result.push(info);
	};
	addTheme({ name: SYSTEM_THEME_NAME, path: undefined });

	// Built-in themes
	for (const name of Object.keys(builtinThemes.themes)) {
		addTheme({ name, path: path.join(builtinThemes.directory, `${name}.json`) });
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
	const result: ThemeInfo[] = [];
	for (const file of getCustomThemeFiles().values()) {
		try {
			const customTheme = loadThemeFromContent(file.path, file.content);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: file.path });
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
	const registeredSource = registeredTheme && themeSources.get(registeredTheme);
	if (registeredTheme?.sourcePath && registeredSource) {
		return registeredSource;
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customTheme = getCustomThemeFiles().get(`${name}.json`);
	if (!customTheme) {
		throw new Error(`Theme not found: ${name}`);
	}
	return parseThemeJsonContent(name, customTheme.content);
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
	const theme = createTheme(themeJson, mode, themePath);
	themeSources.set(theme, themeJson);
	return theme;
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
