/**
 * #5607: a broker on a loaded host, or one the operating system suspended, stops running for seconds at a time. Broker
 * traces on Windows CI hosts showed every broker process of a run stalling for 2 to 5 s at once.
 */

/** How much longer than a bound a stall lasts: well past it, as those stalls were. */
export const STALL_PAST_BOUND_MS = 1_500;

/**
 * This process does not run for `ms`, as such a broker does: no timer or I/O callback runs meanwhile, and the ones that
 * came due run once it is back.
 */
export function stallEventLoop(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		// Busy: nothing else in this process runs.
	}
}

/**
 * A database answer on its way. It arrives as I/O does: read in the event loop turn after the timers that came due,
 * not inside a timer callback.
 */
export async function databaseAnswer(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	await new Promise<void>((resolve) => setImmediate(resolve));
}
