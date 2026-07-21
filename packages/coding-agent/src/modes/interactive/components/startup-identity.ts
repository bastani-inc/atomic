import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { STARTUP_ASSEMBLY_GAPS, STARTUP_FRAME_MS } from "./atomic-banner.ts";

export interface StartupAnimationState {
	gap: number;
	manifestoPhase: number;
	complete: boolean;
}

export function startupStateAtElapsed(elapsedMs: number): StartupAnimationState {
	if (elapsedMs >= 1040) return { gap: 0, manifestoPhase: 4, complete: true };
	if (elapsedMs >= 960) return { gap: 0, manifestoPhase: 3, complete: false };
	if (elapsedMs >= 880) return { gap: 0, manifestoPhase: 2, complete: false };
	if (elapsedMs >= 800) return { gap: 0, manifestoPhase: 1, complete: false };
	if (elapsedMs >= 640) return { gap: 0, manifestoPhase: 0, complete: false };
	const frame = Math.min(7, Math.floor(Math.max(0, elapsedMs) / STARTUP_FRAME_MS));
	return { gap: STARTUP_ASSEMBLY_GAPS[frame]!, manifestoPhase: 0, complete: false };
}

export function startupMotionEnabled(): boolean {
	return process.stdout.isTTY === true && process.env.ATOMIC_REDUCED_MOTION !== "1";
}

export class StartupIdentityComponent implements Component {
	private readonly ui: TUI;
	private readonly compose: (width: number, state: StartupAnimationState) => string;
	private readonly startedAt = Date.now();
	private settled = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		ui: TUI,
		compose: (width: number, state: StartupAnimationState) => string,
		animate = startupMotionEnabled(),
	) {
		this.ui = ui;
		this.compose = compose;
		this.settled = !animate;
		if (animate) {
			this.timer = setInterval(() => {
				if (Date.now() - this.startedAt >= 1040) this.settle();
				this.ui.requestRender();
			}, STARTUP_FRAME_MS);
			this.timer.unref?.();
		}
	}

	render(width: number): string[] {
		const state = this.settled
			? { gap: 0, manifestoPhase: 4, complete: true }
			: startupStateAtElapsed(Date.now() - this.startedAt);
		return new Text(this.compose(width, state), 1, 0).render(width);
	}

	settle(): boolean {
		if (this.settled) return false;
		this.settled = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.ui.requestRender();
		return true;
	}

	refresh(): void {
		this.ui.requestRender();
	}

	setExpanded(_expanded: boolean): void {}
	invalidate(): void {}
}
