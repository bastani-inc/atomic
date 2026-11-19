/** Reusable countdown timer for dialog and retry indicators. */
import type { TUI } from "@bastani/atomic-tui";

export class CountdownTimer {
	private stop: (() => void) | undefined;

	constructor(
		timeout: number | { until: number },
		tui: TUI | undefined,
		onTick: (seconds: number) => void,
		onExpire: () => void,
	) {
		if (typeof timeout === "number") {
			let seconds = Math.ceil(timeout / 1000);
			onTick(seconds);
			const timer = setInterval(() => {
				onTick(--seconds);
				tui?.requestRender();
				if (seconds <= 0) {
					this.dispose();
					onExpire();
				}
			}, 1000);
			this.stop = () => clearInterval(timer);
			return;
		}

		// An existing wait keeps its second boundaries even when the view reopens partway through one.
		const tick = () => {
			const remaining = Math.max(0, timeout.until - Date.now());
			const seconds = Math.ceil(remaining / 1000);
			onTick(seconds);
			tui?.requestRender();
			if (seconds === 0) {
				this.stop = undefined;
				onExpire();
				return;
			}
			const timer = setTimeout(tick, remaining - (seconds - 1) * 1000);
			this.stop = () => clearTimeout(timer);
		};
		tick();
	}

	dispose(): void {
		this.stop?.();
		this.stop = undefined;
	}
}
