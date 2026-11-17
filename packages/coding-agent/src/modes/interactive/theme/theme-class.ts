import { Chalk } from "chalk";
import type { SourceInfo } from "../../../core/source-info.ts";
import { bgAnsi, type ColorMode, fgAnsi, resolveThemeStyleLevel, type ThemeStyleLevel } from "./color-utils.ts";
import {
	isStatusToken,
	splitThemeColors,
	type ThemeBg,
	type ThemeColor,
	type ThemeColorValues,
	withThemeTokenFallbacks,
} from "./theme-tokens.ts";

export type { ThemeBg, ThemeColor } from "./theme-tokens.ts";

export type WorkingIndicatorTone = "dark" | "lift" | "muted" | "accent" | "bright" | "peak";

const CHALK_BY_LEVEL = [
	new Chalk({ level: 0 }),
	new Chalk({ level: 1 }),
	new Chalk({ level: 2 }),
	new Chalk({ level: 3 }),
] as const;

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;
	private workingIndicatorColors: Map<WorkingIndicatorTone, string>;

	constructor(
		fgColors: Pick<ThemeColorValues<string | number>, ThemeColor>,
		bgColors: Pick<ThemeColorValues<string | number>, ThemeBg>,
		mode: ColorMode,
		options: {
			name?: string;
			sourcePath?: string;
			sourceInfo?: SourceInfo;
			workingIndicator?: Partial<Record<WorkingIndicatorTone, string | number>>;
			dim?: ThemeColor[];
		} = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(
			withThemeTokenFallbacks({ ...fgColors, ...bgColors }),
		);
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(foregrounds) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, `${options.dim?.includes(key) ? "\x1b[2m" : ""}${fgAnsi(value, mode)}`);
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode, isStatusToken(key) ? "preserve-hue" : "nearest"));
		}
		this.workingIndicatorColors = new Map();
		for (const [key, value] of Object.entries(options.workingIndicator ?? {}) as [
			WorkingIndicatorTone,
			string | number,
		][]) {
			this.workingIndicatorColors.set(key, fgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}${ansi.startsWith("\x1b[2m") ? "\x1b[22m" : ""}\x1b[39m`; // Reset foreground and optional faint styling
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		// Truncation and nested components may reset SGR inside a filled row.
		// Restore the enclosing background before ellipses and trailing padding.
		const filled = text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + ansi);
		return `${ansi}${filled}\x1b[49m`; // Reset only background color
	}

	private style() {
		return CHALK_BY_LEVEL[this.getStyleLevel()];
	}

	getStyleLevel(): ThemeStyleLevel {
		return resolveThemeStyleLevel(this.mode);
	}

	bold(text: string): string {
		return this.style().bold(text);
	}

	italic(text: string): string {
		return this.style().italic(text);
	}

	underline(text: string): string {
		return this.style().underline(text);
	}

	dim(text: string): string {
		return this.style().dim(text);
	}

	inverse(text: string): string {
		return this.style().inverse(text);
	}

	strikethrough(text: string): string {
		return this.style().strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getWorkingIndicatorAnsi(tone: WorkingIndicatorTone): string | undefined {
		return this.workingIndicatorColors.get(tone);
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
	): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}
