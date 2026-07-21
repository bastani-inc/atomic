/**
 * Shared sizing helpers for embedded workflow stage chat frames.
 *
 * The main Atomic chat naturally keeps its composer visible because the root
 * TUI viewport is bottom-aligned on resize. Workflow stage chat renders inside
 * a pi-tui overlay, whose max-height clipping keeps the first rows. These
 * helpers make the embedded frame honor the host viewport exactly and reserve
 * room for the chat box before allocating transcript/body rows.
 */

export interface StageChatFramePlanInput {
  readonly viewportRows: number;
  readonly headerRows: number;
  readonly separatorRows: number;
  readonly pendingRows: number;
  readonly workingRows: number;
  readonly usageRows: number;
  readonly editorRows: number;
  readonly footerRows: number;
}

export interface StageChatFramePlan {
  readonly bodyRows: number;
  readonly pendingRows: number;
  readonly workingRows: number;
  readonly usageRows: number;
  readonly editorRows: number;
  readonly footerRows: number;
}

export function resolveStageChatViewportRows(
  reported: number | undefined,
  fallbackRows: number,
): number {
  if (typeof reported !== "number" || !Number.isFinite(reported)) {
    return fallbackRows;
  }
  return Math.max(1, Math.floor(reported));
}

export function planStageChatFrame(input: StageChatFramePlanInput): StageChatFramePlan {
  const viewportRows = Math.max(1, Math.floor(input.viewportRows));
  const baseRows = Math.max(0, input.headerRows) + Math.max(0, input.separatorRows);
  let remaining = Math.max(0, viewportRows - baseRows);

  // The composer is the highest-priority interactive affordance. Reserve it
  // before status/pending/body rows so it cannot be pushed below the overlay
  // clipping boundary on terminal shrink.
  const editorRows = Math.min(Math.max(0, input.editorRows), remaining);
  remaining -= editorRows;

  // Footer is useful but secondary to the actual input box.
  const footerRows = Math.min(Math.max(0, input.footerRows), remaining);
  remaining -= footerRows;

  // Status rows are optional; preserve them in the same visual order as the
  // normal chat surface after the body gives up its space.
  const pendingRows = Math.min(Math.max(0, input.pendingRows), remaining);
  remaining -= pendingRows;
  const requestedWorkingRows = Math.max(0, input.workingRows);
  const workingRows = remaining >= requestedWorkingRows ? requestedWorkingRows : 0;
  remaining -= workingRows;
  const usageRows = Math.min(Math.max(0, input.usageRows), remaining);
  remaining -= usageRows;

  return {
    bodyRows: remaining,
    pendingRows,
    workingRows,
    usageRows,
    editorRows,
    footerRows,
  };
}

export function fitStageChatFrame(
  lines: string[],
  viewportRows: number,
  blankLine: string,
): string[] {
  const rows = Math.max(1, Math.floor(viewportRows));
  if (lines.length > rows) {
    // Extreme fallback: mirror main chat's bottom-anchored behavior so the
    // composer/footer survive even if mandatory chrome exceeds the viewport.
    return lines.slice(lines.length - rows);
  }
  while (lines.length < rows) lines.push(blankLine);
  return lines;
}
