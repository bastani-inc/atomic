/**
 * Pure helpers for status color, icon, and duration formatting.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/status-helpers.ts
 */
import type { StageStatus, RunStatus } from "../store-types.js";

/** ANSI hex color for each status */
export function statusColor(status: StageStatus | RunStatus): string {
  switch (status) {
    case "pending":
      return "#888888";
    case "running":
      return "#4fc3f7";
    case "completed":
      return "#66bb6a";
    case "failed":
      return "#ef5350";
    case "killed":
      return "#ff9800";
    default:
      return "#888888";
  }
}

/** Unicode icon for each status */
export function statusIcon(status: StageStatus | RunStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "running":
      return "◉";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "killed":
      return "⊘";
    default:
      return "○";
  }
}

/** Format milliseconds as "1m24s", "45s", "3h2m" */
export function fmtDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h${minutes}m`;
    }
    return `${hours}h`;
  }
  if (minutes > 0) {
    if (seconds > 0) {
      return `${minutes}m${seconds}s`;
    }
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
