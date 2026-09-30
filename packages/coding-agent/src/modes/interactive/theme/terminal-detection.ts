import type { RgbColor, TerminalColors } from "@earendil-works/pi-tui";
import { terminalAppearance } from "./system-theme.js";
import { detectColorFgBgTheme, detectTerminalTheme, getTerminalTheme } from "./terminal-colors.js";

export { detectColorFgBgTheme, detectTerminalTheme, getTerminalTheme } from "./terminal-colors.js";

export type TerminalTheme = "dark" | "light";

export function parseAutoThemeSetting(
	themeSetting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

export function resolveThemeSetting(
	themeSetting: string | undefined,
	terminalTheme: TerminalTheme,
): string | undefined {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

export interface TerminalThemeDetection {
	theme: TerminalTheme;
	source: "terminal background" | "COLORFGBG" | "fallback";
	detail: string;
	confidence: "high" | "low";
}

export interface TerminalThemeDetectionOptions {
	env?: NodeJS.ProcessEnv;
}

export interface TerminalBackgroundThemeDetector {
	queryTerminalColors({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColors>;
}

export interface TerminalBackgroundThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalBackgroundThemeDetector;
	timeoutMs: number;
}

export interface TerminalAutoThemeDetector extends TerminalBackgroundThemeDetector {}

export interface TerminalAutoThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalAutoThemeDetector;
	timeoutMs: number;
}

export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return terminalAppearance(rgb);
}

export function detectTerminalBackgroundFromEnv(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const bg = detectColorFgBgTheme(env);
	if (bg !== undefined) {
		return {
			theme: bg,
			source: "COLORFGBG",
			detail: `background color index ${env.COLORFGBG?.split(";").at(-1)}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

export async function detectTerminalBackgroundTheme({
	ui,
	timeoutMs,
	env,
}: TerminalBackgroundThemeDetectionOptions): Promise<TerminalThemeDetection> {
	try {
		const colors = await ui.queryTerminalColors({ timeoutMs });
		const rgb = colors.background;
		if (rgb) {
			return {
				theme: detectTerminalTheme(colors, undefined, env),
				source: "terminal background",
				detail: `OSC 11 background rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
				confidence: "high",
			};
		}
	} catch {
		// Fall back to environment-based detection when the terminal query fails.
	}

	return detectTerminalBackgroundFromEnv({ env });
}

export async function detectTerminalThemeForAuto({
	ui,
	timeoutMs,
	env,
}: TerminalAutoThemeDetectionOptions): Promise<TerminalTheme> {
	return (await detectTerminalBackgroundTheme({ ui, timeoutMs, env })).theme;
}

export function getDefaultTheme(): string {
	return getTerminalTheme();
}
