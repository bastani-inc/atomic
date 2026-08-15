/** Abort-signal helpers shared by the model runtime and its interactive callers. */

/** Create an operation-local signal for public APIs whose signal is optional. */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}

/**
 * Stop waiting for an operation when its signal aborts while continuing to
 * observe the abandoned promise so a later rejection is always handled.
 */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted)
		return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
