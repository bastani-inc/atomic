/**
 * Workflow session picker — a centred overlay listing runs the user can
 * connect to (open the orchestrator pane) or kill.
 *
 * Visual contract (DESIGN.md §5 Picker Rows + pi-subagents/src/tui/render-helpers.ts):
 *  - Rounded `╭─ Title ─╮` chrome in `border` colour with title in `accent`.
 *  - Section header rows use the mauve `▎` glyph (matches GraphView).
 *  - Selected row: `picker-row-selected` token (blue bg, surface0 fg, bold).
 *  - Footer: dim hints, active key letters in `text`.
 *
 * Render is pure: input → ANSI string lines. Input handling lives in
 * `handleSessionPickerInput` so the overlay-mount adapter can keep state
 * between key events without dragging the renderer into a class.
 *
 * cross-ref:
 *  - src/tui/switcher.ts (selection-row + viewport pattern)
 *  - src/tui/graph-theme.ts (role tokens)
 *  - DESIGN.md §5 Components — picker-row-* tokens
 */

import type { RunSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration, statusIcon, statusColor } from "./status-helpers.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";
import { visibleWidth } from "./text-helpers.js";

// ---------------------------------------------------------------------------
// State + filtering
// ---------------------------------------------------------------------------

export interface SessionPickerState {
  /** Free-text filter applied to name + runId prefix. */
  query: string;
  /** 0-based index into the filtered/visible list. */
  selectedIndex: number;
  /** Toggle for "include long-ended runs". Default false. */
  includeAll: boolean;
  /** True when the filter input has focus (typing routes to query). */
  filterFocused: boolean;
}

export function createSessionPickerState(): SessionPickerState {
  return { query: "", selectedIndex: 0, includeAll: false, filterFocused: false };
}

/** A run plus a derived bucket — keeps the renderer monomorphic. */
export interface PickerRow {
  readonly run: RunSnapshot;
  readonly bucket: "active" | "recent";
}

const RECENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Slice runs into picker rows. Active = `endedAt === undefined`. Recent =
 * ended within the last hour. With `includeAll`, the hour cutoff is dropped.
 *
 * Sort: active first (newest start last in the list = bottom-of-pane),
 * then recent newest-end first.
 */
export function selectRunsForPicker(
  runs: readonly RunSnapshot[],
  query: string,
  includeAll: boolean,
  now: number = Date.now(),
): PickerRow[] {
  const q = query.trim().toLowerCase();
  const matches = (r: RunSnapshot): boolean => {
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.id.startsWith(q);
  };

  const active: PickerRow[] = [];
  const recent: PickerRow[] = [];
  for (const r of runs) {
    if (!matches(r)) continue;
    if (r.endedAt === undefined) {
      active.push({ run: r, bucket: "active" });
      continue;
    }
    if (includeAll || now - (r.endedAt ?? 0) <= RECENT_WINDOW_MS) {
      recent.push({ run: r, bucket: "recent" });
    }
  }
  active.sort((a, b) => a.run.startedAt - b.run.startedAt);
  recent.sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0));
  return [...active, ...recent];
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface SessionPickerRenderOpts {
  width: number;
  theme: GraphTheme;
  rows: readonly PickerRow[];
  state: SessionPickerState;
  /** Optional: now override for deterministic tests. */
  now?: number;
}

/** Pad a visible string (any embedded ANSI is OK; we measure visibly). */
function padTo(s: string, width: number): string {
  const vis = visibleWidth(s);
  if (vis >= width) return s;
  return s + " ".repeat(width - vis);
}

const TITLE = "Connect to workflow run";

function renderHeader(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  const accent = hexToAnsi(theme.accent);
  const padded = ` ${TITLE} `;
  const padLen = Math.max(0, inner - visibleWidth(padded));
  const left = Math.min(2, padLen);
  const right = padLen - left;
  return `${border}╭${"─".repeat(left)}${RESET}${accent}${padded}${RESET}${border}${"─".repeat(right)}╮${RESET}`;
}

/**
 * Bottom corner row — clean `╰─────╯`, no embedded text. Pairs with
 * `renderHeader` to close the box; the keyboard-hint line is emitted
 * separately by `renderHintsRow` so the box border stays uncluttered.
 */
function renderBottomBorder(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  return `${border}╰${"─".repeat(inner)}╯${RESET}`;
}

/**
 * Footer keyboard hints, rendered as a plain text line **below** the
 * picker's bottom border (no leading `╰` / trailing `╯`). Matches the
 * spacing in `ui/workflows/Screenshot 2026-05-13 at 1.11.49 AM.png`.
 */
function renderHintsRow(width: number, theme: GraphTheme, state: SessionPickerState): string {
  const dim = hexToAnsi(theme.dim);
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);
  const sep = `${dim} · ${RESET}`;

  const hints: Array<[string, string]> = state.filterFocused
    ? [
        ["↵", "submit"],
        ["esc", "exit filter"],
      ]
    : [
        ["↑↓", "navigate"],
        ["↵", "connect"],
        ["x", "kill"],
        ["a", state.includeAll ? "active only" : "all"],
        ["/", "filter"],
        ["esc", "close"],
      ];

  const parts = hints.map(([k, l]) => `${text}${k}${RESET} ${muted}${l}${RESET}`);
  // Two-space indent matches `renderEmptyState` and the section-row
  // chrome, keeping the hint glyphs aligned with the panel interior
  // even though they live outside the box border.
  const line = "  " + parts.join(sep);
  // The renderer clamps each line to `width` in the host composite
  // pass; explicit clip here keeps the test-time render() output
  // width-safe as well.
  const lineWidth = visibleWidth(line);
  if (lineWidth >= width) return line;
  return line + " ".repeat(width - lineWidth);
}

function renderBlankRow(inner: number, theme: GraphTheme): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  return `${border}│${RESET}${panelBg}${" ".repeat(inner)}${RESET}${border}│${RESET}`;
}

function renderSectionRow(label: string, inner: number, theme: GraphTheme): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  const mauve = hexToAnsi(theme.mauve);
  const muted = hexToAnsi(theme.textMuted);
  const content = ` ${mauve}▎${RESET}${panelBg} ${muted}${BOLD}${label}${RESET}`;
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

function renderFilterRow(inner: number, theme: GraphTheme, state: SessionPickerState): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  const mauve = hexToAnsi(theme.mauve);
  const muted = hexToAnsi(theme.textMuted);
  const text = hexToAnsi(theme.text);
  const accent = hexToAnsi(theme.accent);
  const cursor = state.filterFocused ? `${accent}▌${RESET}${panelBg}` : "";
  const label = state.filterFocused ? `${accent}filter` : `${muted}filter`;
  const value = state.query
    ? `${text}${state.query}${RESET}${panelBg}`
    : `${muted}(type to filter by name or id)${RESET}${panelBg}`;
  const content = ` ${mauve}▎${RESET}${panelBg} ${label}${RESET}${panelBg}  ${value}${cursor}`;
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

function fmtElapsed(run: RunSnapshot, now: number): string {
  if (run.endedAt !== undefined && run.durationMs !== undefined) {
    return fmtDuration(run.durationMs);
  }
  if (run.endedAt !== undefined) {
    return fmtDuration(Math.max(0, run.endedAt - run.startedAt));
  }
  return fmtDuration(Math.max(0, now - run.startedAt));
}

function stageProgress(run: RunSnapshot): string {
  const total = run.stages.length;
  const done = run.stages.filter(
    (s) => s.status === "completed" || s.status === "failed",
  ).length;
  return `${done}/${total} stages`;
}

function renderRunRow(
  row: PickerRow,
  isSelected: boolean,
  inner: number,
  theme: GraphTheme,
  now: number,
): string {
  const border = hexToAnsi(theme.border);
  const run = row.run;
  const icon = statusIcon(run.status);
  const idShort = run.id.slice(0, 8);
  const elapsed = fmtElapsed(run, now);
  const progress = stageProgress(run);

  // Layout columns: glyph(1) idShort(8) name(flex) elapsed(R) progress(R)
  const elapsedCol = elapsed.padStart(8, " ");
  const progressCol = progress.padStart(10, " ");

  if (isSelected) {
    const pillBg = hexBg(theme.accent);
    const pillFg = hexToAnsi(theme.backgroundElement);
    const left = ` ${icon} ${idShort}  ${run.name}`;
    const right = `${elapsedCol}   ${progressCol} `;
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    const content = `${left}${" ".repeat(gap)}${right}`;
    return `${border}│${RESET}${pillBg}${pillFg}${BOLD}${padTo(content, inner)}${RESET}${border}│${RESET}`;
  }

  const panelBg = hexBg(theme.bg);
  const iconColor = hexToAnsi(statusColor(run.status, theme));
  const dim = hexToAnsi(theme.dim);
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);

  const left =
    ` ${iconColor}${icon}${RESET}${panelBg} ${dim}${idShort}${RESET}${panelBg}  ${text}${run.name}${RESET}${panelBg}`;
  const right = `${muted}${elapsedCol}${RESET}${panelBg}   ${dim}${progressCol}${RESET}${panelBg} `;
  const visLeft = 1 + 1 + 1 + 8 + 2 + run.name.length;
  const visRight = visibleWidth(elapsedCol) + 3 + visibleWidth(progressCol) + 1;
  const gap = Math.max(1, inner - visLeft - visRight);
  const content = `${left}${" ".repeat(gap)}${right}`;
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

function renderEmptyState(inner: number, theme: GraphTheme): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  const dim = hexToAnsi(theme.dim);
  const msg = "no workflow runs to show — start one with /workflow <name>";
  const content = `  ${dim}${msg}${RESET}`;
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

const VIEWPORT = 10;

export function renderSessionPicker(opts: SessionPickerRenderOpts): string[] {
  const { width, theme, rows, state } = opts;
  const now = opts.now ?? Date.now();
  const inner = Math.max(40, width - 2);

  const lines: string[] = [];
  lines.push(renderHeader(width, theme));
  lines.push(renderBlankRow(inner, theme));
  lines.push(renderFilterRow(inner, theme, state));
  lines.push(renderBlankRow(inner, theme));

  if (rows.length === 0) {
    lines.push(renderEmptyState(inner, theme));
    lines.push(renderBlankRow(inner, theme));
    lines.push(renderBottomBorder(width, theme));
    lines.push(renderHintsRow(width, theme, state));
    return lines;
  }

  // Viewport window around selection.
  const sel = Math.max(0, Math.min(state.selectedIndex, rows.length - 1));
  const start = Math.max(0, Math.min(sel - Math.floor(VIEWPORT / 2), rows.length - VIEWPORT));
  const visible = rows.slice(Math.max(0, start), Math.max(0, start) + VIEWPORT);

  let prevBucket: PickerRow["bucket"] | null = null;
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i]!;
    if (row.bucket !== prevBucket) {
      lines.push(renderSectionRow(row.bucket === "active" ? "ACTIVE" : "RECENT", inner, theme));
      prevBucket = row.bucket;
    }
    const absIndex = Math.max(0, start) + i;
    lines.push(renderRunRow(row, absIndex === sel, inner, theme, now));
  }
  lines.push(renderBlankRow(inner, theme));
  lines.push(renderBottomBorder(width, theme));
  lines.push(renderHintsRow(width, theme, state));
  return lines;
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

export type SessionPickerAction =
  | { kind: "noop" }
  | { kind: "close" }
  | { kind: "connect"; runId: string }
  | { kind: "kill"; runId: string };

/**
 * Pure key handler — never mutates anything outside `state`. Returns an
 * action describing what the host should do next (mount the GraphView,
 * fire the kill confirmation, etc.).
 *
 * Filter-focused mode keeps printable characters routed to `state.query`;
 * Enter exits the filter back to navigation mode.
 */
export function handleSessionPickerInput(
  data: string,
  state: SessionPickerState,
  rows: readonly PickerRow[],
): SessionPickerAction {
  // Filter mode — typed chars feed the query, Enter/Esc exit.
  if (state.filterFocused) {
    if (data === "\x1b" || data === "\x1b\x1b") {
      state.filterFocused = false;
      return { kind: "noop" };
    }
    if (data === "\r" || data === "\n") {
      state.filterFocused = false;
      return { kind: "noop" };
    }
    if (data === "\x7f" || data === "\b") {
      state.query = state.query.slice(0, -1);
      state.selectedIndex = 0;
      return { kind: "noop" };
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      state.query += data;
      state.selectedIndex = 0;
      return { kind: "noop" };
    }
    return { kind: "noop" };
  }

  // Navigation mode.
  if (data === "/") {
    state.filterFocused = true;
    return { kind: "noop" };
  }
  if (data === "\x1b") return { kind: "close" };
  if (data === "q" || data === "Q") return { kind: "close" };
  if (data === "a" || data === "A") {
    state.includeAll = !state.includeAll;
    state.selectedIndex = 0;
    return { kind: "noop" };
  }

  // Arrows + j/k.
  if (data === "\x1b[B" || data === "j") {
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(0, rows.length - 1));
    return { kind: "noop" };
  }
  if (data === "\x1b[A" || data === "k") {
    if (rows.length > 0 && state.selectedIndex === 0) return { kind: "noop" };
    state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
    return { kind: "noop" };
  }

  if (data === "\r" || data === "\n") {
    const row = rows[state.selectedIndex];
    if (!row) return { kind: "noop" };
    return { kind: "connect", runId: row.run.id };
  }
  // `x` = kill. Avoids collision with vim's `k` = up.
  if (data === "x" || data === "X") {
    const row = rows[state.selectedIndex];
    if (!row) return { kind: "noop" };
    return { kind: "kill", runId: row.run.id };
  }

  return { kind: "noop" };
}
