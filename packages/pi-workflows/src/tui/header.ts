/**
 * Header band showing workflow name, status count badges, elapsed duration.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/header.tsx
 */
import type { RunSnapshot } from "../store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { statusIcon, fmtDuration } from "./status-helpers.js";
import { hexToAnsi, hexBg, RESET } from "./color-utils.js";

export interface HeaderOpts {
  width: number;
  theme: GraphTheme;
}

/**
 * Render the header for a workflow run.
 * Returns 1-2 lines.
 */
export function renderHeader(run: RunSnapshot, opts: HeaderOpts): string[] {
  const { width, theme } = opts;
  const bg = hexBg(theme.headerBg);
  const fg = hexToAnsi(theme.headerFg);

  const icon = statusIcon(run.status);
  let elapsed: string;
  if (run.durationMs != null) {
    elapsed = fmtDuration(run.durationMs);
  } else if (run.startedAt != null) {
    elapsed = fmtDuration(Date.now() - run.startedAt);
  } else {
    elapsed = "";
  }

  // Count stages by status
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const s of run.stages) {
    if (s.status in counts) counts[s.status as keyof typeof counts]++;
  }

  const badges = [
    counts.pending > 0 ? `○${counts.pending}` : "",
    counts.running > 0 ? `◉${counts.running}` : "",
    counts.completed > 0 ? `✓${counts.completed}` : "",
    counts.failed > 0 ? `✗${counts.failed}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const elapsedStr = elapsed ? ` [${elapsed}]` : "";
  const right = `${badges}${elapsedStr}`;
  const title = `${icon} ${run.name}`;

  // Fit title and right side into width
  const gap = width - title.length - right.length;
  const spacer = gap > 0 ? " ".repeat(gap) : " ";
  const line = `${bg}${fg}${title}${spacer}${right}${RESET}`;

  return [line];
}
