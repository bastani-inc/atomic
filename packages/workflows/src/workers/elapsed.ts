/** A moment read on both the monotonic clock and the wall clock, to measure the time elapsed since it (#5058). */
export interface Instant {
	readonly monotonic: number;
	readonly wall: number;
}

/** Now, on both clocks. */
export function instant(): Instant {
	return { monotonic: performance.now(), wall: Date.now() };
}

/**
 * The time elapsed since `since`, as the longer of the two clocks measure it (#5058). The monotonic clock stops while
 * the system is suspended, and a step back of the wall clock hides time from it; neither hides elapsed time from the
 * longer measure. A step forward of the wall clock only makes it longer, so a check that guards a lease acts early,
 * never late.
 */
export function elapsedSince(since: Instant): number {
	return Math.max(performance.now() - since.monotonic, Date.now() - since.wall);
}
