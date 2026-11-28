import { setLongTimeout } from "@bastani/atomic-timers";

/** @deprecated New internal callers should use the shared deadline timer. */
export function startShellDeadline(timeoutMs: number, expire: () => void): () => void {
	return setLongTimeout(expire, timeoutMs).clear;
}
