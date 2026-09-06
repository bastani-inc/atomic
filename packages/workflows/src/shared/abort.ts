/** Observe late settlement while releasing a caller that no longer owns the wait. */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(signal.reason ?? new DOMException("Workflow request aborted", "AbortError"));
	}
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => {
		abort.reject(signal.reason ?? new DOMException("Workflow request aborted", "AbortError"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([operation, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}
