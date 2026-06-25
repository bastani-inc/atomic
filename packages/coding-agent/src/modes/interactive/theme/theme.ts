export { getThemeExportColors, getResolvedThemeColors, isLightTheme } from "./export-colors.ts";
export {
	initTheme,
	onThemeChange,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	theme,
} from "./global-theme.ts";
export {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	getDefaultTheme,
	getThemeForRgbColor,
	parseAutoThemeSetting,
	resolveThemeSetting,
	type TerminalBackgroundThemeDetectionOptions,
	type TerminalBackgroundThemeDetector,
	type TerminalTheme,
	type TerminalThemeDetection,
	type TerminalThemeDetectionOptions,
} from "./terminal-detection.ts";
export { Theme, type ThemeBg, type ThemeColor } from "./theme-class.ts";
export {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	loadThemeFromPath,
	setRegisteredThemes,
	type ThemeInfo,
} from "./theme-loading.ts";
export {
	getEditorTheme,
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
} from "./tui-theme.ts";
