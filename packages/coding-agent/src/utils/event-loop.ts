import { setImmediate as waitForImmediate } from "node:timers/promises";

/**
 * Yield to the macrotask queue so terminal input, timers, and render work can
 * run between otherwise synchronous startup chunks.
 */
export async function yieldToEventLoop(): Promise<void> {
	await waitForImmediate();
}

/**
 * Yield until the next timer turn so libuv finishes the current poll/check cycle,
 * updates its clock, flushes any already-scheduled 0 ms timers, and polls I/O before continuing.
 */
export async function yieldToTimerTurn(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

export async function yieldToEventLoopIfSlow(startedAt: number, thresholdMs = 16): Promise<void> {
	if (Date.now() - startedAt >= thresholdMs) {
		await yieldToEventLoop();
	}
}
