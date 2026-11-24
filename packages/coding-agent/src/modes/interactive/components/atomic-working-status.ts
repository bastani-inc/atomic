import {
	type Component,
	Loader,
	type LoaderIndicatorOptions,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { ansi256ToHex, fgAnsi, hexToRgb } from "../theme/color-utils.ts";
import { theme } from "../theme/theme.js";
import { formatTokenSegment } from "./token-segment.ts";
import {
	formatWorkingElapsed,
	formatWorkingMeta,
	normalizeWorkingRunSnapshot,
	type WorkingRunMetaInput,
} from "./working-run-meter.ts";

/** Atomic's literal one-cell identity follows the approved ten-step luminance ramp. */
export const ATOMIC_WORKING_FRAMES = ["∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀", "∀"] as const;
export const ATOMIC_WORKING_BOLD_PHASES = [false, false, false, false, true, true, true, false, false, false] as const;
export const ATOMIC_WORKING_FRAME_MS = 88;
export const DEFAULT_WORKING_MESSAGE = "Working…";

const IRREGULAR_WORKED_VERBS: Readonly<Record<string, string>> = {
	building: "built",
	doing: "did",
	feeding: "fed",
	finding: "found",
	forgiving: "forgave",
	freeing: "freed",
	getting: "got",
	giving: "gave",
	having: "had",
	letting: "let",
	making: "made",
	reading: "read",
	running: "ran",
	sending: "sent",
	shaking: "shook",
	spellbinding: "spellbound",
	spinning: "spun",
	taking: "took",
	teaching: "taught",
	thinking: "thought",
	unbinding: "unbound",
	winding: "wound",
	writing: "wrote",
};

const UNICODE_LETTER = /^\p{L}$/u;
const WORKED_WORD_CHAR = /^[\p{L}'-]$/u;

function previousCodePoint(text: string, endIndex: number): { char: string; start: number } | undefined {
	if (endIndex <= 0) return undefined;
	const lo = text.charCodeAt(endIndex - 1);
	if (lo >= 0xdc00 && lo <= 0xdfff && endIndex >= 2) {
		const hi = text.charCodeAt(endIndex - 2);
		if (hi >= 0xd800 && hi <= 0xdbff) {
			return { char: text.slice(endIndex - 2, endIndex), start: endIndex - 2 };
		}
	}
	return { char: text[endIndex - 1]!, start: endIndex - 1 };
}

function nextCodePoint(text: string, startIndex: number): string | undefined {
	if (startIndex >= text.length) return undefined;
	const cp = text.codePointAt(startIndex);
	return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function findIngWord(message: string): string | undefined {
	let pos = 0;
	while (pos < message.length) {
		const cp = message.codePointAt(pos)!;
		const charLen = cp > 0xffff ? 2 : 1;
		if (!WORKED_WORD_CHAR.test(message.slice(pos, pos + charLen))) {
			pos += charLen;
			continue;
		}
		const runStart = pos;
		let runEnd = pos + charLen;
		while (runEnd < message.length) {
			const nextCp = message.codePointAt(runEnd)!;
			const nextLen = nextCp > 0xffff ? 2 : 1;
			if (!WORKED_WORD_CHAR.test(message.slice(runEnd, runEnd + nextLen))) break;
			runEnd += nextLen;
		}
		// Inside this maximal [\p{L}'-]+ run, greedy [\p{L}'-]* picks the rightmost valid \p{L}ing(?!\p{L}).
		let searchEnd = runEnd - 3;
		while (searchEnd >= runStart) {
			const idx = message.lastIndexOf("ing", searchEnd);
			if (idx < runStart) break;
			const after = nextCodePoint(message, idx + 3);
			const prev = idx > runStart ? previousCodePoint(message, idx) : undefined;
			if (
				(after === undefined || !UNICODE_LETTER.test(after)) &&
				prev !== undefined &&
				UNICODE_LETTER.test(prev.char)
			) {
				return message.slice(runStart, idx + 3);
			}
			searchEnd = idx - 1;
		}
		pos = runEnd;
	}
	return undefined;
}

export function workedVerb(message: string | undefined): string {
	const word = findIngWord(message ?? "");
	if (word === undefined || word.toLowerCase() === "working") return "Worked";
	const lower = word.toLowerCase();
	const base = lower.slice(0, -3);
	const past = IRREGULAR_WORKED_VERBS[lower] ?? (/[^aeiou]y$/.test(base) ? `${base.slice(0, -1)}ied` : `${base}ed`);
	return `${past.charAt(0).toUpperCase()}${past.slice(1)}`;
}

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
	"dark",
	"lift",
	"muted",
	"accent",
	"bright",
	"peak",
	"bright",
	"accent",
	"muted",
	"lift",
];

export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	palette?: AtomicWorkingPalette | (() => AtomicWorkingPalette);
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
	messageColor?: (text: string) => string;
	meta?: WorkingRunMetaInput;
	logo?: boolean;
}

let sharedClockFrame = 0;
let sharedClockTimer: ReturnType<typeof setTimeout> | undefined;
const sharedClockListeners = new Set<() => void>();

function scheduleAtomicWorkingClockTick(): void {
	if (sharedClockTimer !== undefined || sharedClockListeners.size === 0 || process.env.ATOMIC_REDUCED_MOTION === "1") {
		return;
	}
	const timer = setTimeout(() => {
		if (sharedClockTimer !== timer) return;
		sharedClockTimer = undefined;
		if (sharedClockListeners.size === 0 || process.env.ATOMIC_REDUCED_MOTION === "1") {
			return;
		}
		sharedClockFrame = (sharedClockFrame + 1) % ATOMIC_WORKING_FRAMES.length;
		for (const listener of [...sharedClockListeners]) {
			if (sharedClockListeners.has(listener)) listener();
		}
		scheduleAtomicWorkingClockTick();
	}, ATOMIC_WORKING_FRAME_MS);
	sharedClockTimer = timer;
	sharedClockTimer.unref?.();
}

function syncAtomicWorkingClock(): void {
	if (sharedClockListeners.size === 0 || process.env.ATOMIC_REDUCED_MOTION === "1") {
		if (sharedClockTimer !== undefined) {
			clearTimeout(sharedClockTimer);
			sharedClockTimer = undefined;
		}
		if (sharedClockListeners.size === 0) {
			sharedClockFrame = 0;
		}
		return;
	}
	scheduleAtomicWorkingClockTick();
}

export function watchAtomicWorkingClock(listener: () => void): () => void {
	let active = true;
	const subscription = () => listener();
	sharedClockListeners.add(subscription);
	syncAtomicWorkingClock();
	return () => {
		if (!active) return;
		active = false;
		sharedClockListeners.delete(subscription);
		syncAtomicWorkingClock();
	};
}

export function resetAtomicWorkingClock(): void {
	sharedClockFrame = 0;
	if (sharedClockTimer !== undefined) {
		clearTimeout(sharedClockTimer);
		sharedClockTimer = undefined;
	}
	syncAtomicWorkingClock();
}

export function atomicLogoMark(palette?: AtomicWorkingPalette | (() => AtomicWorkingPalette)): string {
	return noColorRequested() ? "∀" : emphasize(colorizePhase(ATOMIC_WORKING_PHASES.indexOf("accent"), "∀", palette));
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
		return `#${rgb
			.slice(1)
			.map((value) => Number(value).toString(16).padStart(2, "0"))
			.join("")}`;
	}
	const indexed = /\x1b\[(?:38|48);5;(\d{1,3})m/.exec(ansi);
	if (!indexed) return undefined;
	const index = Number(indexed[1]);
	return ansi256ToHex(index);
}

function mixHex(from: string, to: string, amount: number): string {
	const a = hexToRgb(from);
	const b = hexToRgb(to);
	const channel = (start: number, end: number) =>
		Math.round(start + (end - start) * amount)
			.toString(16)
			.padStart(2, "0");
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
	if (palette) return `${fgAnsi(palette[tone], theme.getColorMode())}${text}\x1b[39m`;
	const configured = theme.getWorkingIndicatorAnsi(tone);
	if (configured) return `${configured}${text}\x1b[39m`;
	const derived = derivedThemePhaseHex(tone);
	if (derived) return `${fgAnsi(derived, theme.getColorMode())}${text}\x1b[39m`;
	return fallbackThemeColor(tone, text);
}

function emphasize(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function styleLegacyFrame(frame: string, bold: boolean, options: AtomicWorkingStatusOptions): string | undefined {
	if (!options.spinnerColor && !options.spinnerBoldColor) return undefined;
	const regular = options.spinnerColor?.(frame) ?? theme.fg("accent", frame);
	if (!bold) return regular;
	return options.spinnerBoldColor?.(frame) ?? theme.bold(regular);
}

export function atomicWorkingGlyph(frameOrOptions: number | AtomicWorkingStatusOptions = {}): string {
	const options = typeof frameOrOptions === "number" ? { frame: frameOrOptions } : frameOrOptions;
	const reducedMotion = process.env.ATOMIC_REDUCED_MOTION === "1";
	const frameIndex = reducedMotion ? 3 : normalizedFrameIndex(options.frame ?? atomicWorkingFrame());
	const frame = ATOMIC_WORKING_FRAMES[frameIndex];
	const bold = !reducedMotion && ATOMIC_WORKING_BOLD_PHASES[frameIndex];
	if (options.logo) {
		return styleLegacyFrame("∀", true, options) ?? atomicLogoMark(options.palette);
	}
	const legacy = styleLegacyFrame(frame, bold, options);
	if (legacy !== undefined) return legacy;
	if (noColorRequested()) return frame;
	return bold
		? emphasize(colorizePhase(frameIndex, frame, options.palette))
		: colorizePhase(frameIndex, frame, options.palette);
}

/** A working line's message, or one that fits itself to the columns the line leaves it. */
export type AtomicWorkingMessage = string | ((columns: number) => string);

/**
 * The columns a working line `width` columns wide leaves its message on one row: all but its one-column margins, its
 * glyph and the space after it, and `meta`.
 */
export function workingMessageColumns(width: number, meta?: WorkingRunMetaInput): number {
	const metaText = meta ? formatWorkingMeta(meta) : "";
	return Math.max(0, width - 4 - (metaText ? visibleWidth(` (${metaText})`) : 0));
}

function workingMessageText(message: AtomicWorkingMessage, columns = Number.POSITIVE_INFINITY): string {
	return typeof message === "string" ? message : message(columns);
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const message = this.options.message ?? DEFAULT_WORKING_MESSAGE;
		const icon = atomicWorkingGlyph(this.options);
		const styledMessage = noColorRequested()
			? message
			: (this.options.messageColor ?? ((text: string) => theme.fg("muted", text)))(message);
		const metaText = this.options.meta ? formatWorkingMeta(this.options.meta) : "";
		const meta = metaText ? ` (${metaText})` : "";
		const metaColor = this.options.messageColor ?? ((text: string) => theme.fg("dim", text));
		const styledMeta = meta && !noColorRequested() ? metaColor(meta) : meta;
		return ["", ...new Text(`${icon} ${styledMessage}${styledMeta}`, 1, 0).render(width)];
	}
	invalidate(): void {}
}

export interface AtomicWorkedStatusOptions {
	message?: string;
	snapshot: WorkingRunMetaInput;
	color?: (text: string) => string;
}

export class AtomicWorkedStatusComponent implements Component {
	private readonly options: AtomicWorkedStatusOptions;

	constructor(options: AtomicWorkedStatusOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		const snapshot = normalizeWorkingRunSnapshot(this.options.snapshot);
		const segment = formatTokenSegment({ mode: "receiving", count: snapshot.tokens });
		const tokens = segment ? ` · ${segment}` : "";
		const text = `${workedVerb(this.options.message)} for ${formatWorkingElapsed(snapshot.elapsedMs)}${tokens}`;
		const color = noColorRequested()
			? (value: string) => value
			: (this.options.color ?? ((value: string) => theme.fg("dim", value)));
		return ["", ...new Text(`${color("∀")} ${color(text)}`, 1, 0).render(width)];
	}

	invalidate(): void {}
}

/**
 * A complete escape sequence, kept whole: a CSI such as a color, or an OSC or APC string ended by BEL or ST, such as a
 * link or the marker of a clickable key hint. Any other control character is dropped from a border row.
 */
const BORDER_LINE_CONTROLS =
	/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\))|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g;

/** What a working row drew: its animation phase and its run meta. */
interface WorkingRowDrawn {
	readonly frame: number;
	readonly meta: WorkingRunMetaInput | undefined;
}

/**
 * Running animates. Held is a row whose turn ended while its run goes on: it keeps what it last drew (or, when it has
 * not drawn yet, what it first draws) until the next turn restarts it.
 */
type WorkingRowMotion =
	| { readonly kind: "running" }
	| { readonly kind: "held"; readonly drawn: WorkingRowDrawn | undefined };

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: ((text: string) => string) | undefined;
	private readonly messageColor: (text: string) => string;
	private message: AtomicWorkingMessage;
	private stopClock: (() => void) | undefined;
	private delegateGeneration = 0;
	private indicator: LoaderIndicatorOptions | undefined;
	private delegate: Loader | undefined;
	private meta: (() => WorkingRunMetaInput | undefined) | undefined;
	private logo = false;
	private metaTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Running animates; held is a row whose turn ended while its run goes on, kept exactly as last drawn (phase, run
	 * meta and message) until the next turn restarts it.
	 */
	private motion: WorkingRowMotion = { kind: "running" };
	private lastDrawn: WorkingRowDrawn | undefined;

	constructor(
		ui: TUI,
		spinnerColor: ((text: string) => string) | undefined,
		messageColor: (text: string) => string,
		message: AtomicWorkingMessage = DEFAULT_WORKING_MESSAGE,
		indicator?: LoaderIndicatorOptions,
	) {
		this.ui = ui;
		this.spinnerColor = spinnerColor;
		this.messageColor = messageColor;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		if (this.delegate) return this.delegate.render(width);
		const drawn = this.drawn();
		const meta = drawn.meta;
		return new AtomicWorkingStatusComponent({
			frame: drawn.frame,
			message: workingMessageText(this.message, workingMessageColumns(width, meta)),
			spinnerColor: this.spinnerColor,
			messageColor: this.messageColor,
			meta,
			logo: this.logo,
		}).render(width);
	}

	private sanitizeBorderLine(line: string): string {
		// Preserve ANSI escape sequences whole (including Atomic's animation colors, and the BEL that ends a clickable key
		// hint's marker), while making extension-controlled text safe for a single terminal row.
		return line
			.replaceAll("\t", " ")
			.replace(BORDER_LINE_CONTROLS, (_control, sequence: string | undefined) => sequence ?? "");
	}

	private renderSingleBorderLine(width: number): string {
		// Border status is a single-line presentation. Keep the stored extension
		// message/frames verbatim, but collapse rendered rows here so embedded
		// newlines cannot make an unbounded width-search loop.
		return this.render(Math.max(16, width + 2))
			.slice(1)
			.map((line) => this.sanitizeBorderLine(line).trim())
			.filter((line) => stripTerminalSequences(line).length > 0)
			.join(" ");
	}

	renderInBorder(width: number): string {
		// Keep the loader's ANSI styling: Atomic's ten frames share the same `∀`
		// glyph and animate entirely through their color/bold phase.
		return truncateToWidth(this.renderSingleBorderLine(width).trim(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		// The spinner is always the first rendered cell. Extract it by visible
		// width rather than reverse-matching an extension-controlled message.
		return truncateToWidth(this.renderSingleBorderLine(width).trimStart(), Math.min(1, width), "");
	}

	private drawn(): WorkingRowDrawn {
		if (this.motion.kind === "held") {
			const drawn = this.motion.drawn ?? { frame: atomicWorkingFrame(), meta: this.meta?.() };
			this.motion = { kind: "held", drawn };
			return drawn;
		}
		this.lastDrawn = { frame: atomicWorkingFrame(), meta: this.meta?.() };
		return this.lastDrawn;
	}

	/** Whether the row is held between two turns of its run (`holdBetweenTurns`). */
	get betweenTurns(): boolean {
		return this.motion.kind === "held";
	}

	/**
	 * The turn ended and the run continues: keep the row on screen exactly as drawn, with no timers, until the next turn
	 * restarts it (`resetForTurn`) or it is stopped. It keeps the phase and run meta it last drew, read nothing new; a
	 * custom indicator keeps its own last frame.
	 */
	holdBetweenTurns(): void {
		if (this.motion.kind === "held") return;
		this.motion = { kind: "held", drawn: this.lastDrawn };
		// Late callbacks of the delegate's stopped timer are fenced.
		this.delegateGeneration += 1;
		this.delegate?.stop();
		const stopClock = this.stopClock;
		this.stopClock = undefined;
		stopClock?.();
		if (this.metaTimer) clearInterval(this.metaTimer);
		this.metaTimer = undefined;
	}

	start(): void {
		if (this.indicator) {
			this.stop();
			this.createDelegate();
			return;
		}
		this.stop();
		this.armMetaTimer();
		if (process.env.ATOMIC_REDUCED_MOTION === "1" || this.logo) return;
		let active = true;
		const unsubscribe = watchAtomicWorkingClock(() => {
			if (!active || this.stopClock !== stop || this.delegate) return;
			this.ui.requestRender();
		});
		const stop = () => {
			if (!active) return;
			active = false;
			unsubscribe();
		};
		this.stopClock = stop;
	}

	stop(): void {
		this.motion = { kind: "running" };
		this.lastDrawn = undefined;
		this.delegateGeneration += 1;
		const delegate = this.delegate;
		this.delegate = undefined;
		delegate?.stop();
		const stopClock = this.stopClock;
		this.stopClock = undefined;
		stopClock?.();
		if (this.metaTimer) clearInterval(this.metaTimer);
		this.metaTimer = undefined;
	}

	setMeta(meta: (() => WorkingRunMetaInput | undefined) | undefined): void {
		this.meta = meta;
		this.armMetaTimer();
		this.ui.requestRender();
	}

	setLogo(logo: boolean): void {
		this.logo = logo;
		if (logo && this.stopClock) {
			const stopClock = this.stopClock;
			this.stopClock = undefined;
			stopClock();
		}
		this.armMetaTimer();
		this.ui.requestRender();
	}

	private armMetaTimer(): void {
		if (this.metaTimer) clearInterval(this.metaTimer);
		this.metaTimer = undefined;
		if (
			this.motion.kind === "held" ||
			this.indicator ||
			this.delegate ||
			!this.meta ||
			(!this.logo && process.env.ATOMIC_REDUCED_MOTION !== "1")
		)
			return;
		const timer = setInterval(() => this.ui.requestRender(), 1000);
		timer.unref?.();
		this.metaTimer = timer;
	}

	setMessage(message: AtomicWorkingMessage): void {
		// A held row shows the ended turn's message until the next turn sets its own.
		if (this.motion.kind === "held") return;
		this.message = message;
		this.delegate?.setMessage(workingMessageText(message));
		this.ui.requestRender();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.stop();
		this.indicator = indicator;
		if (indicator) {
			this.createDelegate();
		} else {
			this.start();
		}
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
		this.delegate = new Loader(
			guardedUi,
			spinnerColor,
			this.messageColor,
			workingMessageText(this.message),
			this.indicator,
		);
	}

	invalidate(): void {}

	resetForTurn(message: string): void {
		this.message = message;
		if (this.indicator) {
			this.start();
			return;
		}
		this.start();
		this.ui.requestRender();
	}
}

export function atomicWorkingFrame(now?: number): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return 3;
	if (now !== undefined) {
		return normalizedFrameIndex(Math.floor(now / ATOMIC_WORKING_FRAME_MS));
	}
	return sharedClockFrame;
}
