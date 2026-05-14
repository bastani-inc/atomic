/**
 * Per-run detail block — the "▎ RUN <id>" surface.
 *
 * Pairs with the status-list overview ({@link renderSessionList}) and the
 * above-editor widget. Emits a 3-row band header, key/value run summary,
 * a ▎ STAGES section, and a ▎ ARTIFACTS section, all rendered against the
 * canonical Catppuccin Mocha palette.
 *
 * Two output modes:
 *   - **themed**  ANSI Catppuccin chrome (theme supplied)
 *   - **plain**   no colour, stable for snapshot tests (theme omitted)
 *
 * cross-ref:
 *  - github.com/nicobailon/pi-subagents src/runs/background/run-status.ts
 *    inspectSubagentStatus — the source UX pattern
 *  - DESIGN.md §5 Section Labels (`▎ LABEL`)
 *  - orchestrator-panel-ui.png — band-header chrome
 */

import type { RunDetail } from "../runs/background/status.js";
import type { StageSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderBandHeader } from "./header.js";
import type { BandBadge } from "./header.js";
import { fmtDuration, statusIcon, statusColor } from "./status-helpers.js";
import { hexToAnsi, RESET, BOLD } from "./color-utils.js";

const SHORT_ID_LEN = 6;
const STAGE_NAME_COL = 14;
const KEY_COL = 14;

export interface RenderRunDetailOpts {
  /** Provide for ANSI output; omit for plain text. */
  theme?: GraphTheme;
  /** Optional clock override for tests. */
  now?: number;
}

/**
 * Render a {@link RunDetail} as a multi-line styled block.
 */
export function renderRunDetail(
  detail: RunDetail,
  opts: RenderRunDetailOpts = {},
): string {
  const now = opts.now ?? Date.now();
  if (opts.theme === undefined) return renderPlain(detail, now);
  return renderThemed(detail, now, opts.theme);
}

// ---------------------------------------------------------------------------
// Plain renderer — used by tests and headless consumers
// ---------------------------------------------------------------------------

function renderPlain(detail: RunDetail, now: number): string {
  const out: string[] = [];

  const sid = shortId(detail.runId);
  const stateBadge = stateLabel(detail);
  const innerLabel = ` RUN ${sid} `;
  const inner = "─".repeat(innerLabel.length);
  out.push(` ╭${inner}╮`);
  out.push(` │${innerLabel}│  ${detail.name}    ${stateBadge}`);
  out.push(` ╰${inner}╯`);
  out.push("");

  // Summary key/value lines
  for (const [k, v] of summaryRows(detail, now)) {
    if (v === undefined) continue;
    out.push(`  ${pad(k, KEY_COL)}${v}`);
  }
  out.push("");

  // Stages
  out.push("▎ STAGES");
  out.push("");
  if (detail.stages.length === 0) {
    out.push("  (no stages recorded yet)");
  } else {
    for (const stage of detail.stages) {
      out.push(`  ${stageLinePlain(stage, now)}`);
      if (stage.error) {
        out.push(`  ${" ".repeat(STAGE_NAME_COL + 2)}error  ${stage.error.split("\n")[0]?.slice(0, 60) ?? ""}`);
      }
    }
  }
  out.push("");

  // Artifacts (best-effort: result + error)
  const artifactRows = artifactRowsFor(detail);
  if (artifactRows.length > 0) {
    out.push("▎ ARTIFACTS");
    out.push("");
    for (const [k, v] of artifactRows) {
      out.push(`  ${pad(k, KEY_COL)}${v}`);
    }
    out.push("");
  }

  // Action hints
  if (detail.endedAt === undefined) {
    out.push(`  ▸ workflow interrupt   id=${sid}    cancel`);
  } else {
    out.push(`  ▸ workflow resume id=${sid}    reopen graph`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Themed renderer — ANSI Catppuccin chrome
// ---------------------------------------------------------------------------

function renderThemed(detail: RunDetail, now: number, theme: GraphTheme): string {
  const out: string[] = [];
  const mauve = hexToAnsi(theme.mauve);
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);
  const text = hexToAnsi(theme.text);
  const accent = hexToAnsi(theme.accent);

  const sid = shortId(detail.runId);
  const badges = stateBadges(detail, theme);
  // Band-header chrome lives within ~64 cells regardless of terminal width so
  // it visually echoes the orchestrator overlay (which never spans the whole
  // pane horizontally either).
  out.push(...renderBandHeader({
    label: `RUN ${sid}`,
    subtitle: detail.name,
    badges,
    width: 64,
    theme,
  }));
  out.push("");

  // Summary key/value
  for (const [k, v] of summaryRows(detail, now)) {
    if (v === undefined) continue;
    out.push(`  ${muted}${pad(k, KEY_COL)}${RESET}${text}${v}${RESET}`);
  }
  out.push("");

  // Stages section
  out.push(`${mauve}▎${RESET} ${muted}${BOLD}STAGES${RESET}`);
  out.push("");
  if (detail.stages.length === 0) {
    out.push(`  ${dim}(no stages recorded yet)${RESET}`);
  } else {
    for (const stage of detail.stages) {
      out.push("  " + stageLineThemed(stage, now, theme));
      if (stage.error) {
        const errFg = hexToAnsi(theme.error);
        out.push(
          `  ${" ".repeat(STAGE_NAME_COL + 2)}${muted}error${RESET}    ${errFg}${stage.error.split("\n")[0]?.slice(0, 60) ?? ""}${RESET}`,
        );
      }
    }
  }
  out.push("");

  // Artifacts section
  const artifactRows = artifactRowsFor(detail);
  if (artifactRows.length > 0) {
    out.push(`${mauve}▎${RESET} ${muted}${BOLD}ARTIFACTS${RESET}`);
    out.push("");
    for (const [k, v] of artifactRows) {
      out.push(`  ${muted}${pad(k, KEY_COL)}${RESET}${dim}${v}${RESET}`);
    }
    out.push("");
  }

  // Action hints
  if (detail.endedAt === undefined) {
    out.push(
      `  ${dim}▸${RESET} ${accent}workflow interrupt   id=${sid}${RESET}${dim}    cancel${RESET}`,
    );
  } else {
    out.push(
      `  ${dim}▸${RESET} ${accent}workflow resume id=${sid}${RESET}${dim}    reopen graph${RESET}`,
    );
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Shared row builders
// ---------------------------------------------------------------------------

function summaryRows(detail: RunDetail, now: number): Array<[string, string | undefined]> {
  const startedAgo = formatRelative(now - detail.startedAt);
  const updatedAt = detail.endedAt ?? detail.startedAt;
  const updatedAgo = formatRelative(now - updatedAt);
  const duration = detail.durationMs ?? (detail.endedAt !== undefined ? detail.endedAt - detail.startedAt : now - detail.startedAt);

  const rows: Array<[string, string | undefined]> = [
    ["workflow", detail.name],
    ["state", statePlain(detail)],
    ["mode", detail.mode === "chain" ? `chain · ${detail.stages.length} stages` : "single"],
    ["started", `${formatTime(detail.startedAt)}  (${startedAgo} ago)`],
  ];
  if (detail.endedAt !== undefined) {
    rows.push(["ended", `${formatTime(detail.endedAt)}  (${updatedAgo} ago)`]);
    rows.push(["duration", fmtDuration(duration)]);
  } else {
    rows.push(["elapsed", fmtDuration(duration)]);
  }
  if (detail.error) {
    rows.push(["error", detail.error.split("\n")[0]?.slice(0, 60) ?? ""]);
  }
  return rows;
}

function artifactRowsFor(detail: RunDetail): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (detail.result !== undefined && Object.keys(detail.result).length > 0) {
    rows.push(["result", JSON.stringify(detail.result).slice(0, 80)]);
  }
  const inputKeys = Object.keys(detail.inputs);
  if (inputKeys.length > 0) {
    rows.push(["inputs", inputKeys.join(", ")]);
  }
  return rows;
}

function stageLinePlain(stage: StageSnapshot, now: number): string {
  const icon = statusIcon(stage.status);
  const dur = stageDurationString(stage, now);
  const activity = stageActivityString(stage);
  const parts = [
    pad(`${icon} ${stage.name}`, STAGE_NAME_COL + 2),
    pad(stage.status, 10),
  ];
  if (activity) parts.push(pad(activity, 16));
  if (dur) parts.push(dur);
  return parts.join("");
}

function stageLineThemed(stage: StageSnapshot, now: number, theme: GraphTheme): string {
  const icon = statusIcon(stage.status);
  const iconFg = hexToAnsi(statusColor(stage.status, theme));
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);
  const stateFg = hexToAnsi(statusColor(stage.status, theme));

  const activity = stageActivityString(stage);
  const dur = stageDurationString(stage, now);

  const namePad = pad(stage.name, STAGE_NAME_COL);
  const statePad = pad(stage.status, 10);
  const activitySeg = activity
    ? `${muted}${pad(activity, 16)}${RESET}`
    : " ".repeat(16);
  const durSeg = dur ? `${dim}${dur}${RESET}` : "";

  return `${iconFg}${icon}${RESET} ${text}${namePad}${RESET}  ${stateFg}${statePad}${RESET}${activitySeg}${durSeg}`;
}

function stageDurationString(stage: StageSnapshot, now: number): string | undefined {
  if (stage.durationMs !== undefined) return fmtDuration(stage.durationMs);
  if (stage.startedAt !== undefined && stage.endedAt === undefined) {
    return fmtDuration(now - stage.startedAt);
  }
  return undefined;
}

function stageActivityString(stage: StageSnapshot): string | undefined {
  if (stage.status !== "running") return undefined;
  const last = stage.toolEvents.at(-1);
  if (!last) return undefined;
  if (last.endedAt !== undefined && last.startedAt !== undefined) {
    return `${last.name} · ${fmtDuration(last.endedAt - last.startedAt)}`;
  }
  if (last.startedAt !== undefined) {
    return `${last.name} · ${fmtDuration(Date.now() - last.startedAt)}`;
  }
  return last.name;
}

// ---------------------------------------------------------------------------
// State badges + plain-text equivalents
// ---------------------------------------------------------------------------

function stateBadges(detail: RunDetail, theme: GraphTheme): BandBadge[] {
  switch (detail.status) {
    case "running":
      return [{ text: "● running", fg: theme.warning }];
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
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatRelative(ms: number): string {
  return fmtDuration(Math.max(0, ms));
}
