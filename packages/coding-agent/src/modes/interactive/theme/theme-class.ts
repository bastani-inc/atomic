import { Chalk } from "chalk";
import type { SourceInfo } from "../../../core/source-info.ts";
import {
	bgAnsi,
	type ColorEnvironment,
	type ColorMode,
	colorEnvironment,
	fgAnsi,
	onColorEnvironmentChange,
	type ThemeStyleLevel,
	themeStyleLevel,
} from "./color-utils.ts";
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

type ThemePalette = {
	readonly fg: ReadonlyMap<ThemeColor, string>;
	readonly bg: ReadonlyMap<ThemeBg, string>;
	readonly workingIndicator: ReadonlyMap<WorkingIndicatorTone, string>;
};

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private readonly palettes = new Map<ColorMode | "off", ThemePalette>();
	private readonly foregrounds: ReadonlyMap<ThemeColor, string | number>;
	private readonly backgrounds: ReadonlyMap<ThemeBg, string | number>;
	private readonly workingIndicator: ReadonlyMap<WorkingIndicatorTone, string | number>;
	private readonly dimmed: ReadonlySet<ThemeColor>;
	private mode: ColorMode;
	/**
	 * The sequences and style level painting uses now. `applyColorEnvironment` sets them when the theme is created and
	 * whenever `refreshColorEnvironment` reads NO_COLOR and FORCE_COLOR again, so painting never reads the environment.
	 */
	private fgColors!: ReadonlyMap<ThemeColor, string>;
	private bgColors!: ReadonlyMap<ThemeBg, string>;
	private workingIndicatorColors!: ReadonlyMap<WorkingIndicatorTone, string>;
	private styleLevel!: ThemeStyleLevel;

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
		this.foregrounds = new Map(Object.entries(foregrounds) as [ThemeColor, string | number][]);
		this.backgrounds = new Map(Object.entries(backgrounds) as [ThemeBg, string | number][]);
		this.workingIndicator = new Map(
			Object.entries(options.workingIndicator ?? {}) as [WorkingIndicatorTone, string | number][],
		);
		this.dimmed = new Set(options.dim ?? []);
		this.applyColorEnvironment(colorEnvironment());
		onColorEnvironmentChange(this);
	}

	/** The escape sequences of every theme color in one color mode, built once per mode; `off` maps each to "". */
	private palette(mode: ColorMode | "off"): ThemePalette {
		let palette = this.palettes.get(mode);
		if (palette) return palette;
		const fg = new Map<ThemeColor, string>();
		for (const [name, value] of this.foregrounds) {
			fg.set(name, mode === "off" ? "" : `${this.dimmed.has(name) ? "\x1b[2m" : ""}${fgAnsi(value, mode)}`);
		}
		const bg = new Map<ThemeBg, string>();
		for (const [name, value] of this.backgrounds) {
			bg.set(name, mode === "off" ? "" : bgAnsi(value, mode, isStatusToken(name) ? "preserve-hue" : "nearest"));
		}
		const workingIndicator = new Map<WorkingIndicatorTone, string>();
		for (const [name, value] of this.workingIndicator)
			workingIndicator.set(name, mode === "off" ? "" : fgAnsi(value, mode));
		palette = { fg, bg, workingIndicator };
		this.palettes.set(mode, palette);
		return palette;
	}

	/**
	 * Choose the palette and style level for a color environment. NO_COLOR or FORCE_COLOR=0 turns colors off;
	 * FORCE_COLOR=1 or 2 limits a true-color theme to 256 colors; the terminal's own color mode is never raised.
	 */
	applyColorEnvironment(environment: ColorEnvironment): void {
		const level = themeStyleLevel(this.mode, environment);
		const palette = this.palette(level === 0 ? "off" : level === 3 ? this.mode : "256color");
		this.fgColors = palette.fg;
		this.bgColors = palette.bg;
		this.workingIndicatorColors = palette.workingIndicator;
		this.styleLevel = level;
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) {
			// An empty sequence means color is turned off.
			if (ansi === "") return text;
			throw new Error(`Unknown theme color: ${color}`);
		}
		return `${ansi}${text}${ansi.startsWith("\x1b[2m") ? "\x1b[22m" : ""}\x1b[39m`; // Reset foreground and optional faint styling
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) {
			if (ansi === "") return text;
			throw new Error(`Unknown theme background color: ${color}`);
		}
		// Truncation and nested components may reset SGR inside a filled row.
		// Restore the enclosing background before ellipses and trailing padding.
		const filled = text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + ansi);
		return `${ansi}${filled}\x1b[49m`; // Reset only background color
	}

	private style() {
		return CHALK_BY_LEVEL[this.styleLevel];
	}

	/** The level colors and text styles share, so the two never disagree. */
	getStyleLevel(): ThemeStyleLevel {
		return this.styleLevel;
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

	/** The sequence that starts `color`, or an empty string while color is turned off. */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getWorkingIndicatorAnsi(tone: WorkingIndicatorTone): string | undefined {
		return this.workingIndicatorColors.get(tone);
	}

	/** The sequence that starts background `color`, or an empty string while color is turned off. */
	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme background color: ${color}`);
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
