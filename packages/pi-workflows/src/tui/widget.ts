/**
 * Compact above-editor widget renderer.
 * Pure string-rendering — no pi-tui dependency.
 * Returns 1–3 lines from a StoreSnapshot.
 *
 * cross-ref: spec §5.4.4, §5.4.6, §8.1 Phase E
 */

import type { StoreSnapshot, RunSnapshot, StageSnapshot } from "../store-types.js";

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Format elapsed milliseconds as "Xm Ys" (e.g. "1m 24s") or "Xs" if < 60 s.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${minutes}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// Stage summary helpers
// ---------------------------------------------------------------------------

/** Count completed stages (status "completed" or "failed") vs total in a run. */
function stageProgress(run: RunSnapshot): { done: number; total: number } {
  const done = run.stages.filter(
    (s) => s.status === "completed" || s.status === "failed",
  ).length;
  return { done, total: run.stages.length };
}

/** Find the first running stage in a run, or undefined. */
function activeStage(run: RunSnapshot): StageSnapshot | undefined {
  return run.stages.find((s) => s.status === "running");
}

// ---------------------------------------------------------------------------
// Sparkline — thin per-stage progress glyph row
// ---------------------------------------------------------------------------

const STAGE_GLYPHS: Record<string, string> = {
  pending: "·",
  running: "▶",
  completed: "█",
  failed: "✗",
};

/**
 * Build a single-row sparkline string from stage statuses.
 * Each stage = one glyph; stages joined by spaces.
 * Trimmed to `maxWidth` chars if needed.
 */
export function buildSparkline(run: RunSnapshot, maxWidth = 80): string {
  if (run.stages.length === 0) return "";
  const glyphs = run.stages.map((s) => STAGE_GLYPHS[s.status] ?? "·");
  const line = glyphs.join(" ");
  return line.length > maxWidth ? line.slice(0, maxWidth - 1) + "…" : line;
}

// ---------------------------------------------------------------------------
// Primary line 1: active run summary
// ---------------------------------------------------------------------------

/**
 * Build the primary summary line for one run.
 * Format: `▶ <name> · stage X/Y (<active-stage-name>) · ⏱ <duration>`
 */
export function buildRunSummaryLine(run: RunSnapshot): string {
  const now = Date.now();
  const elapsed = run.endedAt !== undefined ? run.durationMs ?? 0 : now - run.startedAt;
  const { done, total } = stageProgress(run);
  const stageNum = done + 1; // next stage is the current one (1-indexed)
  const running = activeStage(run);
  const stageLabel = running ? ` (${running.name})` : "";
  const totalLabel = total > 0 ? `/${total}` : "";
  return `▶ ${run.name} · stage ${stageNum}${totalLabel}${stageLabel} · ⏱ ${formatDuration(elapsed)}`;
}

// ---------------------------------------------------------------------------
// Public API: renderWidgetLines
// ---------------------------------------------------------------------------

/**
 * Render 1–3 compact lines from a StoreSnapshot for the above-editor widget.
 *
 * - Returns [] when no active runs exist.
 * - Line 1: primary active run summary.
 * - Line 2: multi-run count badge (when >1 active run).
 * - Line 3: sparkline of stage statuses for the primary run.
 *
 * @param snap  Current store snapshot.
 * @param width Maximum line width hint (default 80).
 */
export function renderWidgetLines(snap: StoreSnapshot, width = 80): string[] {
  const activeRuns = (snap.runs as RunSnapshot[]).filter((r) => r.endedAt === undefined);
  if (activeRuns.length === 0) return [];

  // Primary run: most recently started active run.
  const primary = activeRuns[activeRuns.length - 1]!;

  const lines: string[] = [];

  // Line 1: primary run summary.
  let line1 = buildRunSummaryLine(primary);
  if (line1.length > width) {
    line1 = line1.slice(0, width - 1) + "…";
  }
  lines.push(line1);

  // Line 2: multi-run count (when >1 in flight).
  if (activeRuns.length > 1) {
    lines.push(`${activeRuns.length} runs in flight — press F2 for overlay`);
  }

  // Line 3: sparkline (only when at least one stage is known).
  if (primary.stages.length > 0) {
    const sparkline = buildSparkline(primary, width);
    if (sparkline.length > 0) {
      lines.push(sparkline);
    }
  }

  return lines;
}
