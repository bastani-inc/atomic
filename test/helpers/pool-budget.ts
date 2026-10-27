/**
 * One local worker pool's cold start to its child running: its coordinator and worker processes each load the workflow
 * runtime through jiti, several CPU-seconds apiece, which took about 45 s with the CPU three times oversubscribed.
 * Waits and run signals in pool tests are multiples of this, one per pool the test starts (#4011).
 */
export const POOL_COLD_START_BUDGET_MS = 75_000;

/** What a pool test keeps of its budget, after its waits give up, to close its pools and report the failure. */
export const POOL_CLEANUP_HEADROOM_MS = 15_000;

/** Run signal and test timeout for a test that cold-starts `pools` pools. */
export function poolTestBudgetMs(pools: number): { readonly waitMs: number; readonly timeoutMs: number } {
	const waitMs = pools * POOL_COLD_START_BUDGET_MS;
	return { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };
}
