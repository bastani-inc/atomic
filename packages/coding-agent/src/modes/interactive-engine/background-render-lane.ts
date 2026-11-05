import { type Terminal, TuiMainScreen, type TuiStopOptions } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.js";
import { yieldToEventLoop } from "../../utils/event-loop.ts";

/**
 * Engine-side queue for render work no keystroke waits on: widget repaints and transcript rows (tool cards and
 * custom messages) whose state streamed in.
 *
 * Interactive work never enters it. Keyboard input and the frames of open dialogs and other custom UIs are handled
 * as soon as their lines arrive, so they run ahead of everything queued here.
 *
 * Each job is keyed by the component it repaints. A newer job for a queued key replaces the queued one in place:
 * the host keeps only a component's newest frame, so the older render would be wasted work. Keeping the original
 * position stops a fast-updating component from starving the rest.
 *
 * Jobs run one per event-loop turn. Terminal input that arrives behind a burst of background renders therefore
 * waits for at most one of them, however many are queued.
 */
export class BackgroundRenderLane {
	private readonly pending = new Map<string, () => void>();
	private draining = false;
	private readonly yieldTurn: () => Promise<void>;

	constructor(yieldTurn: () => Promise<void> = yieldToEventLoop) {
		this.yieldTurn = yieldTurn;
	}

	/**
	 * Queue `job` as the render for `key`, replacing a queued render of the same key.
	 * A job must report its own failures; it must not throw.
	 */
	schedule(key: string, job: () => void): void {
		this.pending.set(key, job);
		if (this.draining) return;
		this.draining = true;
		void this.drain();
	}

	/** Drop the queued render for `key`, if any. */
	cancel(key: string): void {
		this.pending.delete(key);
	}

	/** Renders waiting to run. */
	get size(): number {
		return this.pending.size;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending.size > 0) {
				await this.yieldTurn();
				const next = this.pending.entries().next();
				if (next.done === true) return;
				const [key, job] = next.value;
				this.pending.delete(key);
				job();
			}
		} finally {
			this.draining = false;
		}
	}
}

/**
 * Headless pi-tui screen for a background component in the engine.
 *
 * Its frames are never shown: a frame only tells the engine whether the component's output changed, and so whether
 * to ask the host to repaint it. That check renders the whole component, so it runs on the background lane instead
 * of in pi-tui's render timer, where it would run ahead of queued keyboard input. pi-tui still coalesces and
 * throttles the requests, and the lane coalesces the checks it has not run yet.
 */
export class BackgroundRenderTui extends TuiMainScreen {
	private readonly lane: BackgroundRenderLane;
	private readonly laneKey: string;

	constructor(terminal: Terminal, lane: BackgroundRenderLane, laneKey: string) {
		super(terminal, undefined, getAgentDir());
		this.lane = lane;
		this.laneKey = laneKey;
	}

	override stop(options?: TuiStopOptions): void {
		this.lane.cancel(this.laneKey);
		super.stop(options);
	}

	protected override doRender(): void {
		this.lane.schedule(this.laneKey, () => super.doRender());
	}
}
