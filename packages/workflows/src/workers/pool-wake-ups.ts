/**
 * What a shared pool does with the wake-ups its journal sends on Postgres (#5103). A wake-up names the root whose
 * work became ready or whose attempt ended, or is undefined when wake-ups may have been missed. It only ends a wait
 * early: every poll it shortens still runs.
 */

/** The pauses of a pool's idle workers between asks for work, which a wake-up of their root ends early. */
export class IdleClaimPauses {
	private readonly waiting = new Set<() => void>();

	constructor(private readonly pauseMs: number) {}

	/** Resolves after the pause, or once a wake-up ends it. */
	pause(): Promise<void> {
		return new Promise((resolve) => {
			const end = () => {
				clearTimeout(timer);
				this.waiting.delete(end);
				resolve();
			};
			const timer = setTimeout(end, this.pauseMs);
			this.waiting.add(end);
		});
	}

	/**
	 * A wake-up of `root`, this pool's own: one pause ends for a wake-up naming it, since one child became ready or one
	 * attempt ended; every pause ends when wake-ups may have been missed. Another root's wake-up ends none.
	 */
	wake(woken: string | undefined, root: string | undefined): void {
		if (woken === undefined) for (const end of [...this.waiting]) end();
		else if (woken === root) this.waiting.values().next().value?.();
	}
}

/**
 * The listener a worker host gives its journal: a wake-up of a root it does not serve, or a missed one, starts a poll
 * that attaches it, at most once per `minIntervalMs`. A served root's satellite hears its root's wake-ups itself.
 */
export function hostWakeUps(
	serves: (root: string) => boolean,
	poll: () => void,
	minIntervalMs: number,
	now: () => number = () => performance.now(),
): (root: string | undefined) => void {
	let polledAt = Number.NEGATIVE_INFINITY;
	return (root) => {
		if (root !== undefined && serves(root)) return;
		const at = now();
		if (at - polledAt < minIntervalMs) return;
		polledAt = at;
		poll();
	};
}
