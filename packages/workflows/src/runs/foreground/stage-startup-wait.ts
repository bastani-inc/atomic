/**
 * Cancel only a startup consumer, never the underlying creation or reload owner.
 * Settle in one continuation so already-ready sessions keep prompt admission in
 * the caller's turn (a race followed by finally adds extra admission hops).
 */
export function waitForStageStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new DOMException("Stage startup cancelled", "AbortError"));
		};
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}
