import chalk from "chalk";
import { failureDebugFields, reportDebug } from "../core/debug.ts";

/** Progress of the startup work that runs before the TUI paints, such as loading and preparing a resumed session. */
export interface StartupProgress {
	/**
	 * A new step started. The one before it is shown now if it ran for the delay and no timer showed it. A step known
	 * to be slow before it starts, such as reading a long history, is `immediate`: it is written at once, so it is on
	 * the terminal while the step runs.
	 */
	phase(message: string, options?: { readonly immediate?: true }): void;
	/** Startup reached the TUI. The last step is shown first if it ran for the delay; nothing more is shown. */
	done(): void;
}

export interface StartupProgressOptions {
	/** How long a step runs before it is shown. Default {@link STARTUP_PROGRESS_DELAY_MS}. */
	readonly delayMs?: number;
	/** Milliseconds on a monotonic clock. Default `performance.now`. */
	readonly now?: () => number;
}

/** Steps that finish sooner than this stay silent, so a quick start prints nothing. */
export const STARTUP_PROGRESS_DELAY_MS = 400;

interface PendingStep {
	readonly message: string;
	readonly startedAt: number;
	shown: boolean;
}

function formatElapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Shows the steps of a slow start on the terminal before the TUI exists, one line each, so resuming a large session
 * is never a blank screen (#4660). Lines end with `\r\n`, since the terminal may already be in raw mode.
 *
 * A step that blocks the event loop, like reading a long history, never lets a timer fire. Such a step is shown, with
 * how long it took, when the next step starts or startup ends.
 */
export function createStartupProgress(
	write: (text: string) => void,
	options: StartupProgressOptions = {},
): StartupProgress {
	const delayMs = options.delayMs ?? STARTUP_PROGRESS_DELAY_MS;
	const now = options.now ?? (() => performance.now());
	let anyShown = false;
	let finished = false;
	let current: PendingStep | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writable = true;
	const show = (line: string) => {
		anyShown = true;
		if (!writable) return;
		try {
			write(`\r${chalk.dim(`${line}…`)}\r\n`);
		} catch (error) {
			// Progress is a courtesy: a terminal that cannot be written to never stops a resume. Said once, to the log.
			writable = false;
			reportDebug("storage", "startup-progress-unwritable", failureDebugFields(error));
		}
	};
	const stopTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const settleCurrent = () => {
		stopTimer();
		const step = current;
		current = undefined;
		if (step === undefined || step.shown) return;
		const elapsed = now() - step.startedAt;
		if (elapsed >= delayMs) show(`${step.message} (${formatElapsed(elapsed)})`);
	};
	return {
		phase(message, phaseOptions) {
			if (finished) return;
			settleCurrent();
			const step: PendingStep = { message, startedAt: now(), shown: false };
			current = step;
			if (anyShown || phaseOptions?.immediate === true) {
				step.shown = true;
				show(message);
				return;
			}
			timer = setTimeout(() => {
				timer = undefined;
				step.shown = true;
				show(message);
			}, delayMs);
			timer.unref?.();
		},
		done() {
			if (finished) return;
			settleCurrent();
			finished = true;
		},
	};
}
