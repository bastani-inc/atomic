const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/** Reconnect backoff delay for the given zero-based attempt (clamped to the max step). */
export function reconnectDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

/**
 * Backoff for one run's route client. Runs fail together when the broker is saturated, so the delay
 * is spread over the upper half of the step: it never exceeds {@link reconnectDelayMs}, and the
 * route clients that failed at the same moment retry at different ones.
 */
export function jitteredReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = reconnectDelayMs(attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}
