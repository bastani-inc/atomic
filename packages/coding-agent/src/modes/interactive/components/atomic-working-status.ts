import {
	Loader,
	Text,
	type Component,
	type LoaderIndicatorOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Atomic's ordinary working pulse keeps the exact one-cell `∀` identity fixed
 * while weight alone moves through regular → bold → regular.
 */
export const ATOMIC_WORKING_FRAMES = ["∀", "∀", "∀"] as const;
export const ATOMIC_WORKING_BOLD_PHASES = [false, true, false] as const;
export const ATOMIC_WORKING_FRAME_MS = 80;

export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	spinnerBoldColor?: (text: string) => string;
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
		const frameIndex = process.env.ATOMIC_REDUCED_MOTION === "1"
			? 0
			: normalizedFrameIndex(this.options.frame ?? 0);
		const frame = ATOMIC_WORKING_FRAMES[frameIndex];
		const color = this.options.spinnerColor ?? ((text: string) => theme.fg("accent", text));
		const boldColor = this.options.spinnerBoldColor ?? ((text: string) => theme.bold(color(text)));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		const message = this.options.message ?? "Working...";
		const icon = ATOMIC_WORKING_BOLD_PHASES[frameIndex] ? boldColor(frame) : color(frame);
		return ["", ...new Text(`${icon} ${messageColor(message)}`, 1, 0).render(width)];
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
		if (!this.delegate) {
			this.frame = 0;
			this.start();
		}
	}

	invalidate(): void {}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return 0;
	return Math.floor(now / ATOMIC_WORKING_FRAME_MS) % ATOMIC_WORKING_FRAMES.length;
}
