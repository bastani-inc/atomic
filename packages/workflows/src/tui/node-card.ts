/**
 * DAG node card — rounded, status-coloured, with an accent focus tab.
 *
 * Visual contract (DESIGN.md §5):
 *  - Rounded border `╭╮╰╯` only. No square or ASCII art.
 *  - Border colour carries status. `running` pulses via sine lerp
 *    against the dim border (focus locks the pulse). `paused`,
 *    `completed` / `failed` stay status-coloured regardless of focus.
 *    `pending` sits on `borderDim` and lifts to `borderActive` when focused.
 *  - When focused, the centred title segment becomes a compact accent
 *    tab painted with `theme.accent` bg + `theme.surface` fg + bold.
 *    The tab is the only focus signal — the surrounding border is
 *    reserved for status. No `[focused]` text, no glow, no resize.
 *  - Single centred duration line in the body, coloured by status.
 *
 * Reuses the existing `paint(...)` color-utils helper (a thin wrapper
 * over `hexBg` + `hexToAnsi` + `BOLD` + `RESET`) so the tab matches
 * the same ANSI shape Pi's renderer uses for every other styled run.
 *
 * cross-ref:
 *   - github.com/bastani-inc/atomic packages/atomic-sdk/src/components/node-card.tsx
 *   - DESIGN.md §5 "Node Cards (orchestrator graph)"
 *   - src/tui/graph-theme.ts `deriveGraphThemeFromPiTheme` — the
 *     accent/surface tokens used below are sourced from Pi's live
 *     `Theme` when the overlay mounts.
 */

import type { StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration, statusIcon } from "./status-helpers.js";
import { lerpColor, hexToAnsi, hexBg, paint, RESET, BOLD } from "./color-utils.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";
import { NODE_W, NODE_H } from "./layout.js";

export interface NodeCardOpts {
  width?: number;
  height?: number;
  focused?: boolean;
  /** 0–1; ignored when status is terminal (complete/failed). */
  pulsePhase?: number;
  theme: GraphTheme;
  /** Run stages, used to resolve blockedByStageId into a short upstream name. */
  stages?: readonly StageSnapshot[];
}

/** Sine-eased pulse `t ∈ [0, 1]`. Phase 0 ≈ quiet, 0.5 ≈ peak. */
function pulseT(phase: number): number {
  return (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}

function pickBorder(
  status: StageStatus,
  focused: boolean,
  phase: number,
  theme: GraphTheme,
): string {
  switch (status) {
    case "running":
      // Focus locks the pulse at peak. Status colour wins either way.
      if (focused) return theme.warning;
      return lerpColor(theme.borderDim, theme.warning, pulseT(phase));
    case "paused":
      return theme.warning;
    case "awaiting_input":
      if (focused) return theme.info;
      return lerpColor(theme.borderDim, theme.info, pulseT(phase));
    case "completed":
      return theme.success;
    case "failed":
      return theme.error;
    case "blocked":
      return theme.dim;
    case "skipped":
      return theme.dim;
    case "pending":
    default:
      // Pending has no semantic colour; the focused-tab carries the
      // cursor signal, so we only lift the border one step.
      return focused ? theme.borderActive : theme.borderDim;
  }
}

function durationColor(status: StageStatus, theme: GraphTheme): string {
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
    default:
      return theme.dim;
  }
}

function blockedBadgeText(
  stage: StageSnapshot,
  stages: readonly StageSnapshot[] | undefined,
  width: number,
): string {
  const base = "↑ blocked";
  const blockedBy = stage.blockedByStageId;
  if (!blockedBy) return base;

  const upstream = stages?.find((s) => s.id === blockedBy)?.name ?? blockedBy;
  const withUpstream = `${base} by ${upstream}`;
  if (visibleWidth(withUpstream) <= width) return withUpstream;
  return base;
}

function durationText(stage: StageSnapshot): string {
  const elapsed = elapsedStageMs(stage);
  return elapsed === undefined ? "—" : fmtDuration(elapsed);
}

function metaText(stage: StageSnapshot): string {
  if (stage.topologyState === "unavailable") return "topology unavailable";
  const deps = stage.parentIds.length;
  const dependencyText = deps === 0 ? "root" : deps === 1 ? "1 dep" : `${deps} deps`;
  return stage.fastMode === true ? `${dependencyText} · fast` : dependencyText;
}

function shortRunId(runId: string): string {
  return runId.length <= 8 ? runId : runId.slice(0, 8);
}

function workflowChildSummaryText(stage: StageSnapshot): string {
  const child = stage.workflowChild ?? stage.workflowChildRun;
  if (child === undefined) return durationText(stage);
  return `↳ ${child.workflow}`;
}

function workflowChildMetaText(stage: StageSnapshot): string {
  const completed = stage.workflowChild;
  if (completed !== undefined) {
    const outputCount = Object.keys(completed.outputs).length;
    const outputs = outputCount === 1 ? "1 out" : `${outputCount} outs`;
    return `run ${shortRunId(completed.runId)} · ${outputs}`;
  }

  const live = stage.workflowChildRun;
  if (live !== undefined) return `run ${shortRunId(live.runId)} · live`;

  return metaText(stage);
}

function statusLabel(status: StageStatus): string {
  switch (status) {
    case "awaiting_input":
      return "awaiting input";
    case "completed":
      return "complete";
    default:
      return status.replace(/_/g, " ");
  }
}

function truncate(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(s) <= maxWidth) return s;
  return truncateToWidth(s, maxWidth, "…");
}

/**
 * Centre a visible string inside `width` cells, wrapping it with `fg`
 * (and optional bold) ANSI escapes. The visible width is computed before
 * the colour escapes are added so padding stays correct. `bg` is
 * re-emitted around the coloured run so trailing pad cells stay on the
 * card stratum instead of dropping to the terminal default.
 */
function centreColored(
  content: string,
  width: number,
  fg: string,
  bg: string,
  opts: { bold?: boolean } = {},
): string {
  const safe = truncate(content, width);
  const safeWidth = visibleWidth(safe);
  const pad = Math.max(0, width - safeWidth);
  const left = Math.max(0, Math.floor(pad / 2));
  const right = Math.max(0, pad - left);
  const bold = opts.bold ? BOLD : "";
  return (
    `${bg}${" ".repeat(left)}` +
    `${hexToAnsi(fg)}${bold}${safe}${RESET}` +
    `${bg}${" ".repeat(right)}`
  );
}

/**
 * Build the title slot — the run of cells between the rounded corners
 * on the top border. Returns a pre-styled fragment plus its visible
 * width so the caller can pad the surrounding dashes correctly.
 *
 * When `focused`, the slot reads as a small accent-coloured tab:
 *   `╭── stage ──╮`
 * Otherwise it falls back to the historical bold-title shape:
 *   `╭── stage ──╮`
 *
 * The visible-width contract is preserved (length of the title slot
 * is included in the dash math) so the card geometry never shifts
 * between the two states — focus only changes the styling of the
 * existing slot, not its size.
 */
function buildTitleSlot(
  name: string,
  innerWidth: number,
  focused: boolean,
  theme: GraphTheme,
  cardBg: string,
): { slot: string; visibleWidth: number } {
  const maxName = Math.max(2, innerWidth - 4);
  const safeName = truncate(name, maxName);
  if (focused) {
    // Flanking spaces sit on the accent tab so the pill reads as a
    // single coloured run. Use `paint` to combine bg + fg + bold +
    // RESET in one ANSI sequence, then re-prime the card stratum so
    // the dashes outside the slot stay on the body bg.
    const tabText = ` ${safeName} `;
    const styled = `${paint(tabText, theme.surface, {
      bg: theme.accent,
      bold: true,
    })}${cardBg}`;
    return { slot: styled, visibleWidth: visibleWidth(tabText) };
  }
  const titleRaw = ` ${safeName} `;
  const styled = `${BOLD}${titleRaw}${RESET}${cardBg}`;
  return { slot: styled, visibleWidth: visibleWidth(titleRaw) };
}

/**
 * Render a stage as a multi-line card string.
 * Returns array of exactly `height` lines, each `width` cells wide.
 */
export function renderNodeCard(stage: StageSnapshot, opts: NodeCardOpts): string[] {
  const width = opts.width ?? NODE_W;
  const height = opts.height ?? NODE_H;
  const focused = opts.focused ?? false;
  const phase = opts.pulsePhase ?? 0;
  const theme = opts.theme;

  const borderHex = pickBorder(stage.status, focused, phase, theme);
  const bc = hexToAnsi(borderHex);
  // Card stratum bg — painted explicitly on every cell so internal
  // RESETs never let the terminal default leak through as a shadow
  // strip on the right/bottom of the card. Per DESIGN.md the card
  // background is `base` (same as the canvas), so this paints flush
  // with the body bg and only the border outline reads visually.
  const bg = hexBg(theme.bg);
  const innerWidth = Math.max(2, width - 2);

  // Title sits inside the top border. Focus adds an accent-coloured
  // pill to the name slot without adding an extra glyph.
  const { slot: titleSlot, visibleWidth: titleVisibleWidth } = buildTitleSlot(
    stage.name,
    innerWidth,
    focused,
    theme,
    bg,
  );
  const titleStart = Math.max(1, Math.floor((innerWidth - titleVisibleWidth) / 2));
  const titleEnd = titleStart + titleVisibleWidth;
  const topMiddle =
    `${bc}${"─".repeat(titleStart)}` +
    `${titleSlot}${bc}` +
    `${"─".repeat(Math.max(0, innerWidth - titleEnd))}`;
  const top = `${bg}${bc}╭${topMiddle}╮${RESET}`;
  const bottom = `${bg}${bc}╰${"─".repeat(innerWidth)}╯${RESET}`;

  // Interior — compact status + duration. Child workflow boundary
  // stages otherwise look like empty completed nodes, so use the first
  // body row for the child workflow identity and the final row for a
  // terse child-run summary. This keeps the graph dense while making
  // the boundary explain what actually ran.
  const bodyText = stage.nodeKind === "tool"
    ? (stage.error ?? stage.result ?? "durable tool")
    : stage.status === "blocked"
      ? blockedBadgeText(stage, opts.stages, innerWidth)
      : workflowChildSummaryText(stage);
  const bodyHex = durationColor(stage.status, theme);
  const statusText = `${statusIcon(stage.status)} ${stage.toolStatus ?? statusLabel(stage.status)}`;
  const statusLine =
    `${bg}${bc}│${RESET}` +
    centreColored(statusText, innerWidth, bodyHex, bg, {
      bold: stage.status === "running" || stage.status === "awaiting_input",
    }) +
    `${bg}${bc}│${RESET}`;
  const durLine =
    `${bg}${bc}│${RESET}` +
    centreColored(bodyText, innerWidth, bodyHex, bg, {
      bold: stage.status === "blocked",
    }) +
    `${bg}${bc}│${RESET}`;
  const metaLine =
    `${bg}${bc}│${RESET}` +
    centreColored(workflowChildMetaText(stage), innerWidth, theme.dim, bg) +
    `${bg}${bc}│${RESET}`;

  const interior: string[] =
    stage.status === "awaiting_input"
      ? [
          statusLine,
          `${bg}${bc}│${RESET}` +
            centreColored("waiting for response", innerWidth, theme.info, bg) +
            `${bg}${bc}│${RESET}`,
          `${bg}${bc}│${RESET}` +
            centreColored("↵ enter to respond", innerWidth, theme.dim, bg) +
            `${bg}${bc}│${RESET}`,
        ]
      : [durLine, statusLine, metaLine];

  // Pad / clip to exactly `height` lines.
  const contentRows = Math.max(0, height - 2);
  while (interior.length < contentRows) {
    interior.push(
      `${bg}${bc}│${RESET}${bg}${" ".repeat(innerWidth)}${bg}${bc}│${RESET}`,
    );
  }
  if (interior.length > contentRows) {
    interior.length = contentRows;
  }

  return [top, ...interior, bottom];
}
