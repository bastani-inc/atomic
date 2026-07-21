import {
	Loader,
	Text,
	type Component,
	type LoaderIndicatorOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * One-cell Atomic A. The first six frames add one Braille dot at a time from
 * top to bottom; the remaining frames remove one dot at a time so the cycle
 * never changes by more than one pixel between adjacent frames.
 *
 * Settled 2×4 cell (`⣵`):
 *   ● ·
 *   · ●
 *   ● ●
 *   ● ●
 */
export const ATOMIC_WORKING_FRAMES = ["⠁", "⠑", "⠕", "⠵", "⡵", "⣵", "⡵", "⠵", "⠕", "⠑"] as const;
export const ATOMIC_WORKING_SETTLED_FRAME_INDEX = 5;
export const ATOMIC_WORKING_FRAME_MS = 80;


export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

function normalizedFrameIndex(frame: number): number {
	return ((frame % ATOMIC_WORKING_FRAMES.length) + ATOMIC_WORKING_FRAMES.length) % ATOMIC_WORKING_FRAMES.length;
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const frame = ATOMIC_WORKING_FRAMES[normalizedFrameIndex(this.options.frame ?? 0)];
		const color = this.options.spinnerColor ?? ((text: string) => theme.bold(theme.fg("accent", text)));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		const message = this.options.message ?? "Working...";
		return ["", ...new Text(`${color(frame)} ${messageColor(message)}`, 1, 0).render(width)];
	}
	invalidate(): void {}
}

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: (text: string) => string;
	private readonly messageColor: (text: string) => string;
	private message: string;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private delegate: Loader | undefined;

	constructor(
		ui: TUI,
		spinnerColor: (text: string) => string,
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
		return this.delegate?.render(width) ?? new AtomicWorkingStatusComponent({ frame: this.frame, message: this.message, spinnerColor: this.spinnerColor, messageColor: this.messageColor }).render(width);
	}

	start(): void {
		if (this.delegate) {
			this.delegate.start();
			return;
		}
		this.stop();
		if (process.env.ATOMIC_REDUCED_MOTION === "1") {
			this.frame = ATOMIC_WORKING_SETTLED_FRAME_INDEX;
			return;
		}
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % ATOMIC_WORKING_FRAMES.length;
			this.ui.requestRender();
		}, ATOMIC_WORKING_FRAME_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.delegate?.stop();
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
		this.delegate = indicator ? new Loader(this.ui, this.spinnerColor, this.messageColor, this.message, indicator) : undefined;
		this.frame = process.env.ATOMIC_REDUCED_MOTION === "1" ? ATOMIC_WORKING_SETTLED_FRAME_INDEX : 0;
		if (!this.delegate) this.start();
	}

	invalidate(): void {}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return ATOMIC_WORKING_SETTLED_FRAME_INDEX;
	return Math.floor(now / ATOMIC_WORKING_FRAME_MS) % ATOMIC_WORKING_FRAMES.length;
}
