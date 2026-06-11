/**
 * Theme-aware helpers for status colour, icon, and duration formatting.
 *
 * `statusColor` resolves a status against role tokens on a {@link GraphTheme}
 * so the rest of the renderer never sees raw hex. Icons are a fixed Unicode
 * set per DESIGN.md §1 (Iconography).
 */
import type { StageStatus, RunStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";

/** Role-mapped colour for each status. */
export function statusColor(
  status: StageStatus | RunStatus,
  theme: GraphTheme,
): string {
  switch (status) {
    case "running":
      return theme.warning;
    case "paused":
      return theme.warning;
    case "awaiting_input":
      return theme.info;
    case "completed":
      return theme.success;
    case "failed":
      return theme.error;
    case "killed":
      return theme.error;
    case "blocked":
      return theme.dim;
    case "skipped":
      return theme.dim;
    case "cancelled":
      return theme.dim;
    case "pending":
    default:
      return theme.dim;
  }
}

/** Unicode glyph for each status (no emoji — terminal-stable). */
export function statusIcon(status: StageStatus | RunStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "awaiting_input":
      return "？";
    case "blocked":
      return "↑";
    case "skipped":
      return "⊘";
    case "cancelled":
      return "⊘";
    case "running":
      return "●";
    case "paused":
      return "❚❚";
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

/** Format milliseconds as "1m 24s", "45s", "3h 2m". */
export function fmtDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }
  if (minutes > 0) {
    if (seconds > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
