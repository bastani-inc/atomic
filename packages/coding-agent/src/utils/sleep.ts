import { sleepFor } from "@bastani/atomic-timers";

/** @deprecated New internal callers should use the shared deadline timer. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleepFor(ms);
	return sleepFor(ms, { signal }).catch((error) => {
		throw signal.aborted ? new Error("Aborted") : error;
	});
}
