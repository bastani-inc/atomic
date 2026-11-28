const SDK_TIMER_MAX_MS = 2_147_483_647;

/** The OpenAI and Anthropic SDKs always arm a timer; never pass a delay that their timer interprets as 1 ms. */
export function sdkTimerBackstop(timeoutMs: number | undefined): { timeout?: number } {
	return timeoutMs === undefined ? {} : { timeout: Math.min(SDK_TIMER_MAX_MS, Math.ceil(timeoutMs)) };
}
