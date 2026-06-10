/**
 * `/workflow status` list — rounded workflow-tool output surface.
 *
 * Visual contract (DESIGN.md §5):
 *  - One rounded `BACKGROUND` panel with subtitle and count badges.
 *  - One rounded card per run (replaces the indented per-stage rows):
 *      title: runId · workflow · state badge
 *      row 1: mode · progress strip · meta
 *  - Status colour is carried by the card border and state badge semantics,
 *    never by decorative body text.
 *  - One trailing hint row pointing at `/workflow status <id>` for the
 *    most-recently-active run; full per-stage detail moves into
 *    `/workflow status <id>` ({@link renderRunDetail}).
 *
 * Plain mode (theme omitted) preserves the rounded panel/card shape without
 * ANSI escapes, with ASCII bracket cells `[✓][●][○][✗]`.
 *
 * Powers:
 *   - `renderResult({ action: "status" })` (LLM tool path)
 *   - `/workflow session list` chat output (via renderSessionList)
 *   - `/workflow status` chat output
 *
 * cross-ref:
 *  - ui/mockups.html §2 (run list), §4 (truncation)
 *  - src/tui/chat-surface.ts shared primitives
 *  - src/tui/run-detail.ts per-run drill-down surface (unchanged)
 */

import type { RunSnapshot, StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedRunMs, elapsedStageMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import {
  renderHintRows,
  renderRoundedBox,
  progressStrip,
  ELLIPSIS,
  chatWidth,
} from "./chat-surface.js";
import type { FlatBandBadge } from "./chat-surface.js";
import { hexToAnsi, RESET, BOLD } from "./color-utils.js";
import { visibleWidth, truncateToWidth } from "./text-helpers.js";

const SHORT_ID_LEN = 6;
const MIN_TITLE_BUDGET = 12;
const STAGE_LABEL_BUDGET = 24;

export interface RenderStatusListOpts {
  /** Provide for ANSI Catppuccin; omit for plain text. */
  theme?: GraphTheme;
  /** Clock override (tests). */
  now?: number;
  /** When true, show a trailing hint pointing at the detail action. */
  showDetailHint?: boolean;
  /** Render width (cells). Defaults to `process.stdout.columns`. */
  width?: number;
}

/**
 * Render a list of run snapshots as the canonical rounded `BACKGROUND`
 * surface: one panel plus one card per run.
 */
export function renderStatusList(
  runs: readonly RunSnapshot[],
  opts: RenderStatusListOpts = {},
): string {
  const now = opts.now ?? Date.now();
  const width = effectiveWidth(opts.width);
  const cardWidth = Math.max(20, width - 4);

  // The list shows active + recently-ended runs together. Sorting:
  // active first, then ended, each bucket by startedAt desc.
  const sorted = sortRuns(runs);

  // Header counts span the whole snapshot, not just the display window.
  const counts = countBuckets(runs);
  const subtitle = `${sorted.length} run${sorted.length === 1 ? "" : "s"}`;
  const badges: FlatBandBadge[] | undefined = opts.theme
    ? themedBadges(counts, opts.theme)
    : plainBadges(counts);

  const body: string[] = [];

  if (sorted.length === 0) {
    body.push(` ${emptyStateLine(opts.theme)} `);
  } else {
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) body.push("");
      body.push(...renderRunEntry(sorted[i]!, now, cardWidth, opts.theme));
    }
  }

  if (opts.showDetailHint !== false && sorted.length > 0) {
    const sid = shortId(sorted[0]!.id);
    body.push("");
    body.push(
      ...renderHintRows(
        [{ command: `/workflow status ${sid}`, hint: "drill into a run" }],
        opts.theme,
      ).split("\n").map((line) => ` ${line} `),
    );
  }

  const badgeText = badges && badges.length > 0 ? `  ${badges.map((b) => b.text).join("  ")}` : "";
  return renderRoundedBox({
    title: `BACKGROUND  ${subtitle}${badgeText}`,
    bodyLines: body,
    theme: opts.theme,
    width,
  });
}

// ---------------------------------------------------------------------------
// Run card
// ---------------------------------------------------------------------------

function renderRunEntry(
  run: RunSnapshot,
  now: number,
  width: number,
  theme?: GraphTheme,
): string[] {
  const sid = shortId(run.id);
  const trailing = runTrailing(run, theme);
  const mode = run.stages.length > 1 ? "chain " : "single";
  const bodyWidth = effectiveWidth(width);
  const interior = Math.max(8, bodyWidth - 4);
  const rawMeta = runCardMeta(run, now);
  const modeW = mode.length + 4;
  const maxMetaW = Math.max(0, interior - modeW - 3);
  const meta = truncateToWidth(rawMeta, maxMetaW, ELLIPSIS);
  const metaW = visibleWidth(meta);
  const stripBudget = Math.max(0, interior - modeW - metaW - 2);

  const strip = progressStrip(stageCells(run), stripBudget, theme);
  const usedLeftW = modeW + visibleWidth(strip);
  const gap = Math.max(metaW > 0 ? 1 : 0, interior - usedLeftW - metaW);

  const glyph = statusIconForRun(run);
  const glyphFg = theme ? hexToAnsi(runAccent(run, theme)) : "";
  const accent = theme ? hexToAnsi(theme.accent) : "";
  const text = theme ? hexToAnsi(theme.text) : "";
  const muted = theme ? hexToAnsi(theme.textMuted) : "";
  const dim = theme ? hexToAnsi(theme.dim) : "";
  const reset = theme ? RESET : "";

  const name = truncateToWidth(run.name, Math.max(MIN_TITLE_BUDGET, interior - visibleWidth(sid) - visibleWidth(trailing?.text ?? "") - 8), ELLIPSIS);
  const line1 = theme
    ? ` ${glyphFg}${glyph}${RESET}  ${accent}${sid}${RESET}  ${text}${BOLD}${name}${RESET}  ${glyphFg}${trailing?.text ?? ""}${RESET} `
    : ` ${glyph}  ${sid}  ${name}  ${trailing?.text ?? ""} `;
  const modeSeg = theme ? `${muted}${mode}${reset}` : mode;
  const metaSeg = theme ? `${dim}${meta}${reset}` : meta;
  const line2 = `   ${modeSeg}    ${strip}${" ".repeat(gap)}${metaSeg} `;

  return [line1, line2];
}

function runAccent(run: RunSnapshot, theme?: GraphTheme): string {
  if (!theme) return "#000000";
  switch (run.status) {
    case "completed": return theme.success;
    case "running":   return theme.warning;
    case "paused":    return theme.warning;
    case "failed":    return theme.error;
    case "killed":    return theme.error;
    case "pending":
    default:          return theme.dim;
  }
}

function runTrailing(run: RunSnapshot, theme?: GraphTheme): { text: string; fg?: string } | undefined {
  switch (run.status) {
    case "completed": return { text: "✓ completed", fg: theme?.success };
    case "running":   return { text: "● running", fg: theme?.warning };
    case "paused":    return { text: "❚❚ paused", fg: theme?.warning };
    case "failed":    return { text: "✗ failed", fg: theme?.error };
    case "killed":    return { text: "⊘ killed", fg: theme?.error };
    case "pending":
    default:          return { text: "○ pending", fg: theme?.dim };
  }
}

function runCardMeta(run: RunSnapshot, now: number): string {
  // Builds the right-aligned meta tail.
  //   running  → `3/8 · review-a · 1m42s`
  //   paused   → `3/8 · review-a · 1m42s` (elapsed is frozen by pausedAt)
  //   failed   → `failed at partition · 4m24s ago`
  //   killed   → `<stage> · <duration> · <when>` (mirrors mockup §2)
  //   completed→ `<stage> · <duration> · <when>`
  const parts: string[] = [];
  const isChain = run.stages.length > 1;
  const total = run.stages.length;
  const done = run.stages.filter(
    (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped",
  ).length;
  const ago = run.endedAt !== undefined
    ? `${fmtDuration(now - run.endedAt)} ago`
    : run.startedAt != null
      ? fmtDuration(elapsedRunMs(run, now))
      : undefined;

  if (run.status === "running") {
    if (isChain) parts.push(`${done}/${total}`);
    const labels = runningStageLabels(run);
    if (labels) parts.push(labels);
    if (ago) parts.push(ago);
    return parts.join(" · ");
  }

  if (run.status === "paused") {
    if (isChain) parts.push(`${done}/${total}`);
    const labels = pausedStageLabels(run);
    if (labels) parts.push(labels);
    if (ago) parts.push(ago);
    return parts.join(" · ");
  }

  if (run.status === "failed" || run.status === "killed") {
    const failed = run.stages.find((s) => s.status === "failed");
    if (failed && isChain) parts.push(`failed at ${failed.name}`);
    else if (failed) parts.push(failed.name);
    else if (!isChain && run.stages[0]) parts.push(run.stages[0].name);
    const dur = lastStageDuration(run, now);
    if (dur && parts.length < 2) parts.push(dur);
    if (ago) parts.push(ago);
    return parts.join(" · ");
  }

  if (run.status === "completed") {
    if (!isChain && run.stages[0]) parts.push(run.stages[0].name);
    const dur = lastStageDuration(run, now);
    if (dur) parts.push(dur);
    if (ago) parts.push(ago);
    return parts.join(" · ");
  }

  // pending
  if (ago) parts.push(ago);
  return parts.join(" · ");
}

function runningStageLabels(run: RunSnapshot): string | undefined {
  const running = run.stages.filter((s) => s.status === "running").map((s) => s.name);
  if (running.length === 0) return undefined;
  const joined = running.join(", ");
  return truncateToWidth(joined, STAGE_LABEL_BUDGET, ELLIPSIS);
}

function pausedStageLabels(run: RunSnapshot): string | undefined {
  const paused = run.stages.filter((s) => s.status === "paused").map((s) => s.name);
  if (paused.length === 0) return undefined;
  const joined = paused.join(", ");
  return truncateToWidth(joined, STAGE_LABEL_BUDGET, ELLIPSIS);
}

function lastStageDuration(run: RunSnapshot, now: number): string | undefined {
  // Pick a representative stage duration: the most-recent terminal stage,
  // or the running stage if everything's still in flight.
  const candidate =
    [...run.stages].reverse().find((s) => s.status === "completed" || s.status === "failed" || s.status === "skipped") ??
    run.stages.find((s) => s.status === "running");
  if (!candidate) return undefined;
  return stageDurationString(candidate, now);
}

function stageDurationString(stage: StageSnapshot, now: number): string | undefined {
  const elapsed = elapsedStageMs(stage, now);
  return elapsed === undefined ? undefined : fmtDuration(elapsed);
}

function stageCells(run: RunSnapshot): Array<{ status: StageStatus }> {
  // Single-stage runs render a single cell mirroring run status. Chain
  // runs render one cell per stage.
  if (run.stages.length === 0) {
    return [{ status: stageStatusFromRun(run) }];
  }
  return run.stages.map((s) => ({ status: s.status }));
}

function stageStatusFromRun(run: RunSnapshot): StageStatus {
  switch (run.status) {
    case "completed": return "completed";
    case "running":   return "running";
    case "paused":    return "paused";
    case "failed":    return "failed";
    case "killed":    return "failed";
    case "pending":
    default:          return "pending";
  }
}

/**
 * Resolve the render width for the status surface. Delegates to the
 * shared `chatWidth()` helper which already accounts for the chat host's
 * 2-cell horizontal padding when no explicit width is supplied.
 */
function effectiveWidth(width?: number): number {
  return chatWidth(width);
}

// ---------------------------------------------------------------------------
// Buckets + badges
// ---------------------------------------------------------------------------

interface Counts {
  active: number;
  paused: number;
  completed: number;
  failed: number;
  pending: number;
}

function countBuckets(runs: readonly RunSnapshot[]): Counts {
  const c: Counts = { active: 0, paused: 0, completed: 0, failed: 0, pending: 0 };
  for (const r of runs) {
    if (r.endedAt === undefined) {
      if (r.status === "pending") c.pending++;
      else if (r.status === "paused") c.paused++;
      else if (r.status === "running") c.active++;
      else if (r.status === "completed") c.completed++;
      else c.failed++;
    } else if (r.status === "completed") c.completed++;
    else c.failed++;
  }
  return c;
}

function themedBadges(c: Counts, theme: GraphTheme): FlatBandBadge[] {
  const out: FlatBandBadge[] = [];
  if (c.completed > 0) out.push({ text: `✓ ${c.completed}`, fg: theme.success });
  if (c.active > 0) out.push({ text: `● ${c.active}`, fg: theme.warning });
  // Keep the word label: the pause glyph is less familiar than the other
  // status glyphs, so this intentional asymmetry improves scanability.
  if (c.paused > 0) out.push({ text: `❚❚ ${c.paused} paused`, fg: theme.warning });
  if (c.pending > 0) out.push({ text: `○ ${c.pending}`, fg: theme.dim });
  if (c.failed > 0) out.push({ text: `⊘ ${c.failed}`, fg: theme.error });
  return out;
}

function plainBadges(c: Counts): FlatBandBadge[] {
  const out: FlatBandBadge[] = [];
  if (c.completed > 0) out.push({ text: `✓ ${c.completed}` });
  if (c.active > 0) out.push({ text: `● ${c.active}` });
  // Keep the word label: the pause glyph is less familiar than the other
  // status glyphs, so this intentional asymmetry improves scanability.
  if (c.paused > 0) out.push({ text: `❚❚ ${c.paused} paused` });
  if (c.pending > 0) out.push({ text: `○ ${c.pending}` });
  if (c.failed > 0) out.push({ text: `⊘ ${c.failed}` });
  return out;
}

// ---------------------------------------------------------------------------
// Sorting + helpers
// ---------------------------------------------------------------------------

function sortRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  const active = runs.filter((r) => r.endedAt === undefined);
  const ended = runs.filter((r) => r.endedAt !== undefined);
  const byStart = (a: RunSnapshot, b: RunSnapshot) => (b.startedAt ?? 0) - (a.startedAt ?? 0);
  return [...[...active].sort(byStart), ...[...ended].sort(byStart)];
}

function shortId(id: string): string {
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;
}

function emptyStateLine(theme?: GraphTheme): string {
  if (!theme) return "  no workflow runs in current session";
  return `  ${hexToAnsi(theme.dim)}no workflow runs in current session${RESET}`;
}

function statusIconForRun(run: RunSnapshot): string {
  switch (run.status) {
    case "completed": return "✓";
    case "running": return "●";
    case "paused": return "❚❚";
    case "failed": return "✗";
    case "killed": return "⊘";
    case "pending":
    default: return "○";
  }
}

// Re-export for callers that need to inspect width budgeting.
export { MIN_TITLE_BUDGET };
