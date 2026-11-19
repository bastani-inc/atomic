const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/** Reconnect backoff delay for the given zero-based attempt (clamped to the max step). */
export function reconnectDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

/**
 * How long a connection that lost the race with a retiring broker keeps spawning and connecting again before it
 * reports the failure. A broker that retires gives up its multi-node leases for at most two seconds and then exits,
 * and its replacement starts in well under the broker start-up budget, so the race resolves long before this.
 */
export const BROKER_RETIRING_RETRY_WINDOW_MS = 10_000;

/** Delay before the next spawn-and-connect attempt after losing the race with a retiring broker: 100 ms, doubling to 1 s. */
export function brokerRetiringRetryDelayMs(attempt: number): number {
  return Math.min(100 * 2 ** attempt, 1_000);
}
