/**
 * Per-run detail block surface.
 *
 * Pairs with the status-list overview ({@link renderSessionList}) and the
 * above-editor widget. Emits a rounded run panel, key/value run summary,
 * rounded stage/artifact cards, all rendered against the canonical
 * Catppuccin Mocha palette.
 *
 * Two output modes:
 *   - **themed**  ANSI Catppuccin chrome (theme supplied)
 *   - **plain**   no colour, stable for snapshot tests (theme omitted)
 *
 * cross-ref:
 *  - github.com/nicobailon/pi-subagents src/runs/background/run-status.ts
 *    inspectSubagentStatus — the source UX pattern
 *  - DESIGN.md §5 Section Labels
 *  - orchestrator-panel-ui.png — band-header chrome
 */

import type { RunDetail } from "../runs/background/status.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedRunMs, elapsedStageMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderRoundedBox } from "./chat-surface.js";
import type { FlatBandBadge } from "./chat-surface.js";
import { fmtDuration, statusIcon, statusColor } from "./status-helpers.js";
import { hexToAnsi, RESET, BOLD } from "./color-utils.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

const SHORT_ID_LEN = 6;
const STAGE_NAME_COL = 14;
const KEY_COL = 14;

export interface RenderRunDetailOpts {
  /** Provide for ANSI output; omit for plain text. */
  theme?: GraphTheme;
  /** Optional clock override for tests. */
  now?: number;
  /** Optional render width (cells) for truncating long/wide values. */
  width?: number;
}

/**
 * Render a {@link RunDetail} as a multi-line styled block.
 */
export function renderRunDetail(
  detail: RunDetail,
  opts: RenderRunDetailOpts = {},
): string {
  const now = opts.now ?? Date.now();
  const width = Math.max(32, opts.width ?? 80);
  if (opts.theme === undefined) return renderPlain(detail, now, width);
  return renderThemed(detail, now, opts.theme, width);
}

// ---------------------------------------------------------------------------
// Plain renderer — used by tests and headless consumers
// ---------------------------------------------------------------------------

function renderPlain(detail: RunDetail, now: number, width: number): string {
  const out: string[] = [];

  const sid = shortId(detail.runId);
  const stateBadge = stateLabel(detail);

  for (const [k, v] of summaryRows(detail, now)) {
    if (v === undefined) continue;
    const value = truncateToWidth(v, Math.max(1, width - 4 - KEY_COL), "…");
    out.push(` ${pad(k, KEY_COL)}${value} `);
  }
  out.push("");

  out.push(" STAGES ");
  if (detail.stages.length === 0) {
    out.push("  (no stages recorded yet) ");
  } else {
    for (const stage of detail.stages) {
      out.push(...renderStageRowsPlain(stage, now, width - 4));
    }
  }
  out.push("");

  const artifactRows = artifactRowsFor(detail);
  if (artifactRows.length > 0) {
    out.push(" ARTIFACTS ");
    for (const [k, v] of artifactRows) {
      out.push(` ${pad(k, KEY_COL)}${truncateToWidth(v, Math.max(1, width - 4 - KEY_COL), "…")} `);
    }
    out.push("");
  }

  if (detail.endedAt === undefined) {
    out.push(truncateToWidth(` ▸ workflow interrupt   id=${sid}    cancel `, width - 2, "…"));
  } else {
    out.push(truncateToWidth(` ▸ workflow resume id=${sid}    reopen graph `, width - 2, "…"));
  }

  return renderRoundedBox({
    title: `RUN ${sid}  ${detail.name}  ${stateBadge}`,
    bodyLines: out,
    width,
  });
}

// ---------------------------------------------------------------------------
// Themed renderer — ANSI Catppuccin chrome
// ---------------------------------------------------------------------------

function renderThemed(detail: RunDetail, now: number, theme: GraphTheme, width: number): string {
  const out: string[] = [];
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);
  const text = hexToAnsi(theme.text);
  const accent = hexToAnsi(theme.accent);

  const sid = shortId(detail.runId);
  const badges = stateBadges(detail, theme);

  for (const [k, v] of summaryRows(detail, now)) {
    if (v === undefined) continue;
    const value = truncateToWidth(v, Math.max(1, width - 4 - KEY_COL), "…");
    out.push(` ${muted}${pad(k, KEY_COL)}${RESET}${text}${value}${RESET} `);
  }
  out.push("");

  out.push(` ${muted}${BOLD}STAGES${RESET} `);
  if (detail.stages.length === 0) {
    out.push(`  ${dim}(no stages recorded yet)${RESET} `);
  } else {
    for (const stage of detail.stages) {
      out.push(...renderStageRowsThemed(stage, now, theme, width - 4));
    }
  }
  out.push("");

  const artifactRows = artifactRowsFor(detail);
  if (artifactRows.length > 0) {
    out.push(` ${muted}${BOLD}ARTIFACTS${RESET} `);
    for (const [k, v] of artifactRows) {
      out.push(` ${muted}${pad(k, KEY_COL)}${RESET}${dim}${truncateToWidth(v, Math.max(1, width - 4 - KEY_COL), "…")}${RESET} `);
    }
    out.push("");
  }

  if (detail.endedAt === undefined) {
    out.push(
      truncateToWidth(` ${dim}▸${RESET} ${accent}workflow interrupt   id=${sid}${RESET}${dim}    cancel${RESET} `, width - 2, "…"),
    );
  } else {
    out.push(
      truncateToWidth(` ${dim}▸${RESET} ${accent}workflow resume id=${sid}${RESET}${dim}    reopen graph${RESET} `, width - 2, "…"),
    );
  }

  const badgeText = badges.length > 0 ? `  ${badges.map((b) => b.text).join("  ")}` : "";
  return renderRoundedBox({
    title: `RUN ${sid}  ${detail.name}${badgeText}`,
    bodyLines: out,
    accent: theme.accent,
    theme,
    width,
  });
}

// ---------------------------------------------------------------------------
// Shared row builders
// ---------------------------------------------------------------------------

function summaryRows(detail: RunDetail, now: number): Array<[string, string | undefined]> {
  const duration = elapsedRunMs(detail, now);

  const rows: Array<[string, string | undefined]> = [
    ["workflow", detail.name],
    ["state", statePlain(detail)],
    ["mode", detail.mode === "chain" ? `chain · ${detail.stages.length} stages` : "single"],
    ["started", formatTime(detail.startedAt)],
  ];
  if (detail.endedAt !== undefined) {
    rows.push(["ended", formatTime(detail.endedAt)]);
    rows.push(["duration", fmtDuration(duration)]);
  } else {
    rows.push(["elapsed", fmtDuration(duration)]);
  }
  if (detail.error) {
    rows.push(["error", detail.error.split("\n")[0] ?? ""]);
  }
  return rows;
}

function artifactRowsFor(detail: RunDetail): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (detail.result !== undefined && Object.keys(detail.result).length > 0) {
    rows.push(["result", JSON.stringify(detail.result)]);
  }
  const inputKeys = Object.keys(detail.inputs);
  if (inputKeys.length > 0) {
    rows.push(["inputs", inputKeys.join(", ")]);
  }
  return rows;
}

function stageLinePlain(stage: StageSnapshot, now: number, width: number): string {
  const icon = statusIcon(stage.status);
  const dur = stageDurationString(stage, now);
  const activity = stageActivityString(stage, now);
  const name = truncateToWidth(`${icon} ${stage.name}`, STAGE_NAME_COL + 2, "…");
  const activityText = activity ? truncateToWidth(activity, 16, "…") : undefined;
  const parts = [
    pad(name, STAGE_NAME_COL + 2),
    pad(stage.status, 10),
  ];
  if (activityText) parts.push(pad(activityText, 16));
  if (dur) parts.push(dur);
  return truncateToWidth(parts.join(""), width, "…");
}

function stageLineThemed(stage: StageSnapshot, now: number, theme: GraphTheme, width: number): string {
  const icon = statusIcon(stage.status);
  const iconFg = hexToAnsi(statusColor(stage.status, theme));
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);
  const stateFg = hexToAnsi(statusColor(stage.status, theme));

  const activity = stageActivityString(stage, now);
  const dur = stageDurationString(stage, now);

  const nameText = truncateToWidth(stage.name, STAGE_NAME_COL, "…");
  const namePad = pad(nameText, STAGE_NAME_COL);
  const statePad = pad(stage.status, 10);
  const activityText = activity ? truncateToWidth(activity, 16, "…") : undefined;
  const activitySeg = activityText
    ? `${muted}${pad(activityText, 16)}${RESET}`
    : " ".repeat(16);
  const durSeg = dur ? `${dim}${dur}${RESET}` : "";

  return truncateToWidth(
    `${iconFg}${icon}${RESET} ${text}${namePad}${RESET}  ${stateFg}${statePad}${RESET}${activitySeg}${durSeg}`,
    width,
    "…",
  );
}

function renderStageRowsPlain(stage: StageSnapshot, now: number, width: number): string[] {
  const rows = [` ${stageLinePlain(stage, now, Math.max(1, width - 2))} `];
  if (stage.error) {
    rows.push(`   error  ${truncateToWidth(stage.error.split("\n")[0] ?? "", Math.max(1, width - 10), "…")} `);
  }
  return rows;
}

function renderStageRowsThemed(
  stage: StageSnapshot,
  now: number,
  theme: GraphTheme,
  width: number,
): string[] {
  const rows = [` ${stageLineThemed(stage, now, theme, Math.max(1, width - 2))} `];
  if (stage.error) {
    const errFg = hexToAnsi(theme.error);
    rows.push(`   ${hexToAnsi(theme.textMuted)}error${RESET}  ${errFg}${truncateToWidth(stage.error.split("\n")[0] ?? "", Math.max(1, width - 12), "…")}${RESET} `);
  }
  return rows;
}

function stageDurationString(stage: StageSnapshot, now: number): string | undefined {
  const elapsed = elapsedStageMs(stage, now);
  return elapsed === undefined ? undefined : fmtDuration(elapsed);
}

// `now` is the stable, capture-once clock threaded down from renderRunDetail
// (opts.now). Using it — not a fresh Date.now() — keeps a running stage's active
// tool-activity label (e.g. `bash · 6s`) byte-stable across host re-renders so a
// scrollback run-detail card that has scrolled above the viewport fold does not
// retrigger pi-tui's full-screen redraw (CSI 2J/H/3J) every render tick. The
// companion below-editor widget owns the live, ticking view.
function stageActivityString(stage: StageSnapshot, now: number): string | undefined {
  if (stage.status !== "running") return undefined;
  const last = stage.toolEvents.at(-1);
  if (!last) return undefined;
  if (last.endedAt !== undefined && last.startedAt !== undefined) {
    return `${last.name} · ${fmtDuration(last.endedAt - last.startedAt)}`;
  }
  if (last.startedAt !== undefined) {
    return `${last.name} · ${fmtDuration(now - last.startedAt)}`;
  }
  return last.name;
}

// ---------------------------------------------------------------------------
// State badges + plain-text equivalents
// ---------------------------------------------------------------------------

function stateBadges(detail: RunDetail, theme: GraphTheme): FlatBandBadge[] {
  switch (detail.status) {
    case "running":
      return [{ text: "● running", fg: theme.warning }];
    case "paused":
      return [{ text: "❚❚ paused", fg: theme.warning }];
    case "completed":
      return [{ text: "✓ completed", fg: theme.success }];
    case "failed":
      return [{ text: "✗ failed", fg: theme.error }];
    case "killed":
      return [{ text: "⊘ killed", fg: theme.dim }];
    case "pending":
    default:
      return [{ text: "○ pending", fg: theme.dim }];
  }
}

function stateLabel(detail: RunDetail): string {
  switch (detail.status) {
    case "running": return "● running";
    case "paused": return "❚❚ paused";
    case "completed": return "✓ completed";
    case "failed": return "✗ failed";
    case "killed": return "⊘ killed";
    case "pending":
    default: return "○ pending";
  }
}

function statePlain(detail: RunDetail): string {
  return stateLabel(detail);
}

// ---------------------------------------------------------------------------
// Tiny formatters
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;
}

function pad(s: string, n: number): string {
  const width = visibleWidth(s);
  if (width >= n) return s;
  return s + " ".repeat(n - width);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
