interface StageTimerSnapshot {
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly pausedDurationMs?: number;
  readonly pausedAt?: number;
}

interface RunTimerSnapshot {
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly pausedDurationMs?: number;
  readonly pausedAt?: number;
  /** Elapsed ms inherited from prior sessions of a resumed durable run. */
  readonly accumulatedDurationMs?: number;
}

function nonNegative(ms: number): number {
  return Math.max(0, ms);
}

export function rebasedStageStartedAt(accumulatedDurationMs: number | undefined, resumedAt: number): number {
  return resumedAt - nonNegative(accumulatedDurationMs ?? 0);
}

function elapsedFromStart(
  startedAt: number,
  now: number,
  pausedDurationMs: number | undefined,
  pausedAt: number | undefined,
): number {
  const completedPausedSegment = pausedDurationMs ?? 0;
  const activePausedSegment = pausedAt === undefined ? 0 : nonNegative(now - pausedAt);
  return nonNegative(now - startedAt - completedPausedSegment - activePausedSegment);
}

export function accumulatePausedDurationMs(
  pausedDurationMs: number | undefined,
  pausedAt: number | undefined,
  resumedAt: number,
): number {
  if (pausedAt === undefined) return pausedDurationMs ?? 0;
  return (pausedDurationMs ?? 0) + nonNegative(resumedAt - pausedAt);
}

export function elapsedStageMs(stage: StageTimerSnapshot, now = Date.now()): number | undefined {
  if (stage.durationMs !== undefined) return nonNegative(stage.durationMs);
  if (stage.startedAt === undefined) return undefined;
  const effectiveNow = stage.endedAt ?? now;
  return elapsedFromStart(stage.startedAt, effectiveNow, stage.pausedDurationMs, stage.pausedAt);
}

export function elapsedRunMs(run: RunTimerSnapshot, now = Date.now()): number {
  if (run.durationMs !== undefined) return nonNegative(run.durationMs);
  const effectiveNow = run.endedAt ?? now;
  return nonNegative(run.accumulatedDurationMs ?? 0)
    + elapsedFromStart(run.startedAt, effectiveNow, run.pausedDurationMs, run.pausedAt);
}
