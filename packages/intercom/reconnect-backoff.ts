const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/** Reconnect backoff delay for the given zero-based attempt (clamped to the max step). */
export function reconnectDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}
