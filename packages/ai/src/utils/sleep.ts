import { sleepFor } from "@bastani/atomic-timers";

/** @deprecated New internal callers should use the shared deadline timer. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return sleepFor(ms, { signal });
}
