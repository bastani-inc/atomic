/**
 * Workflow session picker — a centred overlay listing runs the user can
 * connect to (open the orchestrator pane).
 *
 * Visual contract (DESIGN.md §5 Picker Rows + pi-subagents/src/tui/render-helpers.ts):
 *  - Rounded `╭─ Title ─╮` chrome in `border` colour with title in `accent`.
 *  - Section header rows use a simple two-space label indent (matches GraphView).
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
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import { keyText } from "@bastani/atomic";
import { fmtDuration, statusIcon, statusColor } from "./status-helpers.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "./text-helpers.js";

const ESCAPE_CODE = 0x1b;
const DOUBLE_ESCAPE_SEQUENCE = String.fromCharCode(ESCAPE_CODE, ESCAPE_CODE);

// ---------------------------------------------------------------------------
// State + filtering
// ---------------------------------------------------------------------------

export interface SessionPickerState {
  /** Free-text filter applied to name + runId prefix. */
  query: string;
  /** 0-based index into the filtered/visible list. */
  selectedIndex: number;
  /** Toggle for terminal run visibility. Default true so retained terminal runs stay inspectable. */
  includeAll: boolean;
  /** True when the filter input has focus (typing routes to query). */
  filterFocused: boolean;
}

export function createSessionPickerState(): SessionPickerState {
  return { query: "", selectedIndex: 0, includeAll: true, filterFocused: false };
}

/** A run plus a derived bucket — keeps the renderer monomorphic. */
export interface PickerRow {
  readonly run: RunSnapshot;
  readonly bucket: "active" | "terminal";
}

const RECENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Slice runs into picker rows. Active = `endedAt === undefined`. Terminal =
 * retained terminal runs. With `includeAll` false, terminal rows are limited
 * to the legacy recent-ended one-hour window.
 *
 * Sort: active first (newest start last in the list = bottom-of-pane),
 * then terminal newest-end first.
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
  const terminal: PickerRow[] = [];
  for (const r of runs) {
    if (!isTopLevelWorkflowRun(r)) continue;
    if (!matches(r)) continue;

    const endedAt = r.endedAt;
    if (endedAt === undefined) {
      active.push({ run: r, bucket: "active" });
      continue;
    }

    if (includeAll || now - endedAt <= RECENT_WINDOW_MS) {
      terminal.push({ run: r, bucket: "terminal" });
    }
  }
  active.sort((a, b) => a.run.startedAt - b.run.startedAt);
  terminal.sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0));
  return [...active, ...terminal];
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
  const hint = (key: string, label: string) => `${text}${key}${RESET} ${muted}${label}${RESET}`;

  const parts: string[] = state.filterFocused
    ? [
        hint(keyText("tui.select.confirm"), "Submit"),
        hint(keyText("tui.select.cancel"), "Exit Filter"),
      ]
    : [
        hint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "Navigate"),
        hint(keyText("tui.select.confirm"), "Connect"),
        hint("a", state.includeAll ? "Active Only" : "All"),
        hint("/", "Filter"),
        hint(keyText("tui.select.cancel"), "Close"),
      ];

  // Two-space indent matches `renderEmptyState` and the section-row
  // chrome, keeping the hint glyphs aligned with the panel interior
  // even though they live outside the box border.
  const line = "  " + parts.join(sep);
  // Keep test-time render() output width-safe even before the overlay host
  // gets a chance to composite/truncate it.
  const clipped = truncateToWidth(line, width, "…");
  const lineWidth = visibleWidth(clipped);
  if (lineWidth >= width) return clipped;
  return clipped + " ".repeat(width - lineWidth);
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
  const content = ` ${mauve} ${RESET}${panelBg} ${muted}${BOLD}${label}${RESET}`;
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
  const prefixPlain = "   filter  ";
  const valueBudget = Math.max(1, inner - visibleWidth(prefixPlain) - (state.filterFocused ? 1 : 0));
  const rawValue = state.query || "(type to filter by name or id)";
  const shownValue = truncateToWidth(rawValue, valueBudget, "…");
  const value = state.query
    ? `${text}${shownValue}${RESET}${panelBg}`
    : `${muted}${shownValue}${RESET}${panelBg}`;
  const content = ` ${mauve} ${RESET}${panelBg} ${label}${RESET}${panelBg}  ${value}${cursor}`;
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

function fmtElapsed(run: RunSnapshot, now: number): string {
  return fmtDuration(elapsedRunMs(run, now));
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

  // Layout columns: glyph(1) idShort(8) name(flex) elapsed(R) progress(R).
  // Name budgeting is done by visible cell width so wide workflow names
  // cannot push the elapsed/progress columns through the right border.
  const elapsedCol = elapsed.padStart(8, " ");
  const progressCol = progress.padStart(10, " ");
  const rightPlain = `${elapsedCol}   ${progressCol} `;
  const namePrefixW = visibleWidth(` ${icon} ${idShort}  `);
  const nameBudget = Math.max(1, inner - namePrefixW - visibleWidth(rightPlain) - 1);
  const name = truncateToWidth(run.name, nameBudget, "…");

  if (isSelected) {
    const pillBg = hexBg(theme.accent);
    const pillFg = hexToAnsi(theme.backgroundElement);
    const left = ` ${icon} ${idShort}  ${name}`;
    const right = rightPlain;
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
    ` ${iconColor}${icon}${RESET}${panelBg} ${dim}${idShort}${RESET}${panelBg}  ${text}${name}${RESET}${panelBg}`;
  const right = `${muted}${elapsedCol}${RESET}${panelBg}   ${dim}${progressCol}${RESET}${panelBg} `;
  const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
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
      lines.push(renderSectionRow(row.bucket === "active" ? "ACTIVE" : "TERMINAL", inner, theme));
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
  | { kind: "connect"; runId: string };

/**
 * Pure key handler — never mutates anything outside `state`. Returns an
 * action describing what the host should do next (for example, mount the GraphView).
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
    if (matchesKey(data, Key.escape) || data === DOUBLE_ESCAPE_SEQUENCE) {
      state.filterFocused = false;
      return { kind: "noop" };
    }
    if (matchesKey(data, Key.enter)) {
      state.filterFocused = false;
      return { kind: "noop" };
    }
    if (matchesKey(data, Key.backspace)) {
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
  if (matchesKey(data, "/")) {
    state.filterFocused = true;
    return { kind: "noop" };
  }
  if (matchesKey(data, Key.escape)) return { kind: "close" };
  if (matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) return { kind: "close" };
  if (matchesKey(data, "a") || matchesKey(data, Key.shift("a"))) {
    state.includeAll = !state.includeAll;
    state.selectedIndex = 0;
    return { kind: "noop" };
  }

  // Arrows + j/k.
  if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(0, rows.length - 1));
    return { kind: "noop" };
  }
  if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
    if (rows.length > 0 && state.selectedIndex === 0) return { kind: "noop" };
    state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
    return { kind: "noop" };
  }

  if (matchesKey(data, Key.enter)) {
    const row = rows[state.selectedIndex];
    if (!row) return { kind: "noop" };
    return { kind: "connect", runId: row.run.id };
  }

  return { kind: "noop" };
}
