/** Node's longest timer delay: a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Calls `expire` once `timeoutMs` has passed. A command's timeout has no maximum, so a deadline past Node's longest
 * timer is waited out in steps of it rather than firing at once. Returns the function that cancels it.
 */
export function startShellDeadline(timeoutMs: number, expire: () => void): () => void {
	let remaining = timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		const step = Math.min(remaining, MAX_TIMER_DELAY_MS);
		remaining -= step;
		timer = setTimeout(remaining > 0 ? arm : expire, step);
	};
	arm();
	return () => clearTimeout(timer);
}
