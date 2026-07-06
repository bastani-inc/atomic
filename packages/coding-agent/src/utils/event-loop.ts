import { setImmediate as waitForImmediate } from "node:timers/promises";

/**
 * Yield to the macrotask queue so terminal input, timers, and render work can
 * run between otherwise synchronous startup chunks.
 */
export async function yieldToEventLoop(): Promise<void> {
	await waitForImmediate();
}

export async function yieldToEventLoopIfSlow(startedAt: number, thresholdMs = 16): Promise<void> {
	if (Date.now() - startedAt >= thresholdMs) {
		await yieldToEventLoop();
	}
}
