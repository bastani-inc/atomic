import {
	Loader,
	Text,
	type Component,
	type LoaderIndicatorOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { ansi256ToHex, fgAnsi, hexToRgb } from "../theme/color-utils.ts";
import { theme } from "../theme/theme.ts";

/** Atomic's literal one-cell identity follows the approved ten-step luminance ramp. */
export const ATOMIC_WORKING_FRAMES = ["∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀"] as const;
export const ATOMIC_WORKING_BOLD_PHASES = [false, false, false, false, true, true, true, false, false, false] as const;
export const ATOMIC_WORKING_FRAME_MS = 88;

export interface AtomicWorkingPalette {
	dark: string;
	lift: string;
	muted: string;
	accent: string;
	bright: string;
	peak: string;
}

export type AtomicWorkingTone = keyof AtomicWorkingPalette;

export const ATOMIC_WORKING_PHASES: readonly AtomicWorkingTone[] = [
	"dark", "lift", "muted", "accent", "bright",
	"peak", "bright", "accent", "muted", "lift",
];

export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	palette?: AtomicWorkingPalette | (() => AtomicWorkingPalette);
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

function normalizedFrameIndex(frame: number): number {
	return ((frame % ATOMIC_WORKING_FRAMES.length) + ATOMIC_WORKING_FRAMES.length) % ATOMIC_WORKING_FRAMES.length;
}

function noColorRequested(): boolean {
	return process.env.NO_COLOR !== undefined;
}

function ansiToHex(ansi: string): string | undefined {
	const rgb = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgb) {
		return `#${rgb.slice(1).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`;
	}
	const indexed = /\x1b\[(?:38|48);5;(\d{1,3})m/.exec(ansi);
	if (!indexed) return undefined;
	const index = Number(indexed[1]);
	return index >= 16 ? ansi256ToHex(index) : undefined;
}

function mixHex(from: string, to: string, amount: number): string {
	const a = hexToRgb(from);
	const b = hexToRgb(to);
	const channel = (start: number, end: number) => Math.round(start + (end - start) * amount)
		.toString(16).padStart(2, "0");
	return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

function derivedThemePalette(): AtomicWorkingPalette | undefined {
	const configured = (tone: AtomicWorkingTone): string | undefined => {
		const ansi = theme.getWorkingIndicatorAnsi(tone);
		return ansi ? ansiToHex(ansi) : undefined;
	};
	const dark = configured("dark") ?? ansiToHex(theme.getBgAnsi("selectedBg"));
	const accent = configured("accent") ?? ansiToHex(theme.getFgAnsi("accent"));
	const peak = configured("peak") ?? ansiToHex(theme.getFgAnsi("text"));
	if (!dark || !accent || !peak) return undefined;
	return {
		dark,
		lift: mixHex(dark, accent, 0.25),
		muted: mixHex(dark, accent, 0.6),
		accent,
		bright: mixHex(accent, peak, 0.55),
		peak,
	};
}

function derivedThemePhaseHex(tone: AtomicWorkingTone): string | undefined {
	return derivedThemePalette()?.[tone];
}

function fallbackThemeColor(tone: AtomicWorkingTone, text: string): string {
	if (tone === "dark" || tone === "lift") return theme.fg("dim", text);
	if (tone === "bright" || tone === "peak") return theme.fg("text", text);
	return theme.fg("accent", text);
}

function colorizePhase(
	frameIndex: number,
	text: string,
	paletteOption?: AtomicWorkingPalette | (() => AtomicWorkingPalette),
): string {
	const tone = ATOMIC_WORKING_PHASES[frameIndex]!;
	if (noColorRequested()) return text;
	const palette = typeof paletteOption === "function" ? paletteOption() : paletteOption;
	if (palette) return `${fgAnsi(palette[tone], "truecolor")}${text}\x1b[39m`;
	const configured = theme.getWorkingIndicatorAnsi(tone);
	if (configured) return `${configured}${text}\x1b[39m`;
	const derived = derivedThemePhaseHex(tone);
	if (derived) return `${fgAnsi(derived, theme.getColorMode())}${text}\x1b[39m`;
	return fallbackThemeColor(tone, text);
}

function emphasize(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function styleLegacyFrame(
	frame: string,
	bold: boolean,
	options: AtomicWorkingStatusOptions,
): string | undefined {
	if (!options.spinnerColor && !options.spinnerBoldColor) return undefined;
	const regular = options.spinnerColor?.(frame) ?? theme.fg("accent", frame);
	if (!bold) return regular;
	return options.spinnerBoldColor?.(frame) ?? theme.bold(regular);
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const reducedMotion = process.env.ATOMIC_REDUCED_MOTION === "1";
		const frameIndex = reducedMotion ? 3 : normalizedFrameIndex(this.options.frame ?? 0);
		const frame = ATOMIC_WORKING_FRAMES[frameIndex];
		const message = this.options.message ?? "Working...";
		const bold = !reducedMotion && ATOMIC_WORKING_BOLD_PHASES[frameIndex];
		const icon = styleLegacyFrame(frame, bold, this.options)
			?? (bold
				? emphasize(colorizePhase(frameIndex, frame, this.options.palette))
				: colorizePhase(frameIndex, frame, this.options.palette));
		const styledMessage = noColorRequested()
			? message
			: (this.options.messageColor ?? ((text: string) => theme.fg("muted", text)))(message);
		return ["", ...new Text(`${icon} ${styledMessage}`, 1, 0).render(width)];
	}
	invalidate(): void {}
}

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: ((text: string) => string) | undefined;
	private readonly messageColor: (text: string) => string;
	private message: string;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private delegateGeneration = 0;
	private indicator: LoaderIndicatorOptions | undefined;
	private delegate: Loader | undefined;

	constructor(
		ui: TUI,
		spinnerColor: ((text: string) => string) | undefined,
		messageColor: (text: string) => string,
		message = "Working...",
		indicator?: LoaderIndicatorOptions,
	) {
		this.ui = ui;
		this.spinnerColor = spinnerColor;
		this.messageColor = messageColor;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return this.delegate?.render(width) ?? new AtomicWorkingStatusComponent({
			frame: this.frame,
			message: this.message,
			spinnerColor: this.spinnerColor,
			messageColor: this.messageColor,
		}).render(width);
	}

	start(): void {
		if (this.indicator) {
			this.stop();
			this.createDelegate();
			return;
		}
		this.stop();
		if (process.env.ATOMIC_REDUCED_MOTION === "1") return;
		const timer = setInterval(() => {
			if (this.timer !== timer || this.delegate) return;
			this.frame = (this.frame + 1) % ATOMIC_WORKING_FRAMES.length;
			this.ui.requestRender();
		}, ATOMIC_WORKING_FRAME_MS);
		this.timer = timer;
		this.timer.unref?.();
	}

	stop(): void {
		this.delegateGeneration += 1;
		const delegate = this.delegate;
		this.delegate = undefined;
		delegate?.stop();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.delegate?.setMessage(message);
		this.ui.requestRender();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.stop();
		this.indicator = indicator;
		this.frame = 0;
		if (indicator) this.createDelegate();
		else this.start();
	}

	private createDelegate(): void {
		if (!this.indicator) return;
		const generation = ++this.delegateGeneration;
		const guardedUi = {
			requestRender: () => {
				if (this.delegateGeneration === generation) this.ui.requestRender();
			},
		} as TUI;
		const spinnerColor = this.spinnerColor ?? ((text: string) => theme.fg("accent", text));
		this.delegate = new Loader(guardedUi, spinnerColor, this.messageColor, this.message, this.indicator);
	}

	invalidate(): void {}

	resetForTurn(message: string): void {
		this.message = message;
		if (this.indicator) {
			this.start();
			return;
		}
		this.frame = 0;
		this.start();
		this.ui.requestRender();
	}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return 3;
	return Math.floor(now / ATOMIC_WORKING_FRAME_MS) % ATOMIC_WORKING_FRAMES.length;
}
