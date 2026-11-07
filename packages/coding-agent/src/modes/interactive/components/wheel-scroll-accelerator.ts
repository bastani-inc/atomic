import type { WheelScrollLines } from "@earendil-works/pi-tui";

const BURST_GAP_MS = 5;
const GESTURE_GAP_MS = 200;
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 6;

/** Local macOS terminals send wheel and trackpad deltas the OS already accelerated, one event per line. */
function terminalAcceleratesWheel(): boolean {
	return (
		process.platform === "darwin" &&
		process.env.SSH_CONNECTION === undefined &&
		process.env.SSH_CLIENT === undefined &&
		process.env.SSH_TTY === undefined
	);
}

/**
 * pi-tui's wheel velocity rule for its main transcript, for viewports outside its renderer: pi-tui keeps its
 * accelerator out of its package entry, and Atomic's extension loader resolves only that entry.
 *
 * A numeric setting moves that many rows per event (at least one). `"auto"` moves one row for an isolated notch and
 * up to six for a fast spin, by the average gap between the events of one gesture, unless the terminal accelerates.
 */
export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	/** Takes a new setting; the next event starts a new gesture. */
	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.lastTime = Number.NEGATIVE_INFINITY;
	}

	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		if (!this.accelerate) return 1;
		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}
		if (gap < BURST_GAP_MS) return 1;
		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}
}
