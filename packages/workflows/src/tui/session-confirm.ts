/**
 * Workflow kill-confirmation overlay — clack-style confirmation dialog with
 * two side-by-side buttons (Cancel default, Kill destructive). Mounted via
 * pi.ui.custom() the same way as the picker.
 *
 * Visual contract:
 *  - Rounded `╭─ Title ─╮` chrome in `border` colour, title in `error`
 *    (destructive action signal, per DESIGN.md "Status-Is-Truth").
 *  - Warning glyph + run name + runId in body.
 *  - Two buttons: focused button uses `picker-row-selected` (accent bg + bold);
 *    the destructive button uses `error` bg when focused.
 *  - Footer: `y kill · n cancel · ↵ confirm focused · esc` in dim.
 *
 * Pure render. Keyboard handling lives in `handleKillConfirmInput`.
 *
 * cross-ref:
 *  - src/tui/session-picker.ts (chrome conventions)
 *  - DESIGN.md §5 Components — destructive button
 */

import { keyText } from "@bastani/atomic";
import { Key } from "@earendil-works/pi-tui";
import type { RunSnapshot, RunStatus } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";
import { matchesKey, truncateToWidth, visibleWidth } from "./text-helpers.js";

export interface KillConfirmState {
  /** 0 = Cancel (focused by default), 1 = Kill. */
  focusedButton: 0 | 1;
}

export function createKillConfirmState(): KillConfirmState {
  return { focusedButton: 0 };
}

export interface KillConfirmRenderOpts {
  width: number;
  theme: GraphTheme;
  run: RunSnapshot;
  state: KillConfirmState;
  now?: number;
}

const TITLE = "Kill workflow run?";

function padTo(s: string, width: number): string {
  const vis = visibleWidth(s);
  if (vis >= width) return s;
  return s + " ".repeat(width - vis);
}

function renderHeader(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  const error = hexToAnsi(theme.error);
  const padded = ` ${TITLE} `;
  const padLen = Math.max(0, inner - visibleWidth(padded));
  const left = Math.min(2, padLen);
  const right = padLen - left;
  return `${border}╭${"─".repeat(left)}${RESET}${error}${BOLD}${padded}${RESET}${border}${"─".repeat(right)}╮${RESET}`;
}

function renderFooter(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  const dim = hexToAnsi(theme.dim);
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);
  const sep = `${dim} \u00b7 ${RESET}`;
  const hint = (key: string, label: string) => `${text}${key}${RESET} ${muted}${label}${RESET}`;
  const line = [
    hint("y", "Kill"),
    hint("n", "Cancel"),
    hint(keyText("tui.select.confirm"), "Confirm"),
    hint(keyText("tui.select.cancel"), "Cancel"),
  ].join(sep);
  const leftRule = "\u2500\u2500 ";
  const lineBudget = Math.max(1, inner - visibleWidth(leftRule) - 1);
  const clippedLine = truncateToWidth(line, lineBudget, "…");
  const padLen = Math.max(1, inner - visibleWidth(leftRule) - visibleWidth(clippedLine) - 1);
  const innerContent = `${border}${leftRule}${RESET}${clippedLine}${border}${" ".repeat(padLen)}${RESET}`;
  return `${border}\u2570${RESET}${padTo(innerContent, inner)}${border}\u256f${RESET}`;
}

function renderBlankRow(inner: number, theme: GraphTheme): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  return `${border}│${RESET}${panelBg}${" ".repeat(inner)}${RESET}${border}│${RESET}`;
}

function renderTextRow(
  inner: number,
  theme: GraphTheme,
  content: string,
): string {
  const border = hexToAnsi(theme.border);
  const panelBg = hexBg(theme.bg);
  return `${border}│${RESET}${panelBg}${padTo(content, inner)}${RESET}${border}│${RESET}`;
}

function renderButton(label: string, focused: boolean, destructive: boolean, theme: GraphTheme): string {
  const inner = ` ${label} `;
  if (focused) {
    const bg = destructive ? hexBg(theme.error) : hexBg(theme.accent);
    const fg = hexToAnsi(theme.backgroundElement);
    return `${bg}${fg}${BOLD}${inner}${RESET}`;
  }
  const fg = destructive ? hexToAnsi(theme.error) : hexToAnsi(theme.textMuted);
  const bg = hexBg(theme.surface);
  return `${bg}${fg}${inner}${RESET}`;
}

export function renderKillConfirm(opts: KillConfirmRenderOpts): string[] {
  const { width, theme, run, state } = opts;
  const now = opts.now ?? Date.now();
  const inner = Math.max(50, width - 2);

  const idShort = run.id.slice(0, 8);
  const elapsed = fmtDuration(elapsedRunMs(run, now));
  const stagesRunning = run.stages.filter((s) => s.status === "running").length;
  const stagesTotal = run.stages.length;

  const warning = hexToAnsi(theme.warning);
  const text = hexToAnsi(theme.text);
  const dim = hexToAnsi(theme.dim);
  const muted = hexToAnsi(theme.textMuted);
  const panelBg = hexBg(theme.bg);

  const lines: string[] = [];
  lines.push(renderHeader(width, theme));
  lines.push(renderBlankRow(inner, theme));

  // Identity row: ⚠  <name>  ·  <idShort>. Keep the destructive dialog
  // width-safe even for wide workflow names.
  const identityPrefixW = visibleWidth("   ⚠  ");
  const identitySuffixW = visibleWidth(`  ·  ${idShort}`);
  const nameBudget = Math.max(1, inner - identityPrefixW - identitySuffixW);
  const name = truncateToWidth(run.name, nameBudget, "…");
  const identity =
    `   ${warning}\u26a0${RESET}${panelBg}  ${text}${BOLD}${name}${RESET}${panelBg}  ${dim}\u00b7${RESET}${panelBg}  ${muted}${idShort}${RESET}`;
  lines.push(renderTextRow(inner, theme, identity));

  // Status sub-line.
  const statusLine = run.endedAt === undefined
    ? `      ${muted}in-flight ${elapsed}, ${stagesRunning}/${stagesTotal} stages running${RESET}`
    : `      ${muted}${run.status} after ${elapsed}, ${stagesTotal} stages${RESET}`;
  lines.push(renderTextRow(inner, theme, statusLine));
  lines.push(renderBlankRow(inner, theme));

  // Body copy.
  lines.push(renderTextRow(
    inner,
    theme,
    `      ${muted}Aborts the active stage and discards partial work.${RESET}`,
  ));
  lines.push(renderTextRow(
    inner,
    theme,
    `      ${muted}Removes the run from live history/status.${RESET}`,
  ));
  lines.push(renderBlankRow(inner, theme));

  // Buttons row, centered.
  const cancelBtn = renderButton("Cancel", state.focusedButton === 0, false, theme);
  const killBtn = renderButton("\u25c6 Kill run", state.focusedButton === 1, true, theme);
  const buttonsVis = visibleWidth(" Cancel ") + 3 + visibleWidth(" \u25c6 Kill run ");
  const leftPad = Math.max(2, Math.floor((inner - buttonsVis) / 2));
  const rightPad = Math.max(0, inner - leftPad - buttonsVis);
  const buttonsRow =
    `${" ".repeat(leftPad)}${cancelBtn}${panelBg}   ${RESET}${killBtn}${panelBg}${" ".repeat(rightPad)}${RESET}`;
  const border = hexToAnsi(theme.border);
  lines.push(`${border}│${RESET}${panelBg}${padTo(buttonsRow, inner)}${RESET}${border}│${RESET}`);
  lines.push(renderBlankRow(inner, theme));

  lines.push(renderFooter(width, theme));
  return lines;
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

export type KillConfirmAction =
  | { kind: "noop" }
  | { kind: "cancel" }
  | { kind: "confirm" };

export function handleKillConfirmInput(
  data: string,
  state: KillConfirmState,
): KillConfirmAction {
  // Direct shortcuts bypass focus.
  if (data === "y" || data === "Y") return { kind: "confirm" };
  if (data === "n" || data === "N") return { kind: "cancel" };
  if (matchesKey(data, Key.escape)) return { kind: "cancel" };

  // Tab / arrows toggle focus.
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.left) || data === "h" || data === "l") {
    state.focusedButton = state.focusedButton === 0 ? 1 : 0;
    return { kind: "noop" };
  }
  if (matchesKey(data, Key.enter)) {
    return state.focusedButton === 1 ? { kind: "confirm" } : { kind: "cancel" };
  }
  return { kind: "noop" };
}

export interface WorkflowKilledNoticeRenderOpts {
  width: number;
  theme: GraphTheme;
  run: RunSnapshot;
  previousStatus: RunStatus;
  wasInFlight: boolean;
}

const KILLED_TITLE = "Workflow killed";

function renderKilledHeader(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  const error = hexToAnsi(theme.error);
  const padded = ` ${KILLED_TITLE} `;
  const padLen = Math.max(0, inner - visibleWidth(padded));
  const left = Math.min(2, padLen);
  const right = padLen - left;
  return `${border}╭${"─".repeat(left)}${RESET}${error}${BOLD}${padded}${RESET}${border}${"─".repeat(right)}╮${RESET}`;
}

function renderKilledFooter(width: number, theme: GraphTheme): string {
  const inner = Math.max(4, width - 2);
  const border = hexToAnsi(theme.border);
  return `${border}╰${"─".repeat(inner)}╯${RESET}`;
}

function renderKilledTextRow(
  inner: number,
  theme: GraphTheme,
  content: string,
): string {
  return renderTextRow(inner, theme, truncateToWidth(content, inner, "…", true));
}

export function renderWorkflowKilledNotice(
  opts: WorkflowKilledNoticeRenderOpts,
): string[] {
  const { width, theme, run, previousStatus, wasInFlight } = opts;
  const inner = Math.max(4, width - 2);
  const idShort = run.id.slice(0, 8);
  const stageCount = run.stages.length;
  const runningStages = run.stages.filter((s) => s.status === "running").length;

  const error = hexToAnsi(theme.error);
  const success = hexToAnsi(theme.success);
  const text = hexToAnsi(theme.text);
  const dim = hexToAnsi(theme.dim);
  const muted = hexToAnsi(theme.textMuted);
  const panelBg = hexBg(theme.bg);

  const lines: string[] = [];
  lines.push(renderKilledHeader(width, theme));
  lines.push(renderBlankRow(inner, theme));

  const identityPrefixW = visibleWidth("   ⊘  ");
  const identitySuffixW = visibleWidth(`  ·  ${idShort}`);
  const nameBudget = Math.max(1, inner - identityPrefixW - identitySuffixW);
  const name = truncateToWidth(run.name, nameBudget, "…");
  const identity =
    `   ${error}⊘${RESET}${panelBg}  ${text}${BOLD}${name}${RESET}${panelBg}  ${dim}·${RESET}${panelBg}  ${muted}${idShort}${RESET}`;
  lines.push(renderKilledTextRow(inner, theme, identity));

  const statusText = `${previousStatus} → killed`;
  lines.push(renderKilledTextRow(
    inner,
    theme,
    `      ${muted}${statusText}, ${runningStages}/${stageCount} stages were active${RESET}`,
  ));
  lines.push(renderBlankRow(inner, theme));

  const action = wasInFlight
    ? "Active stage work was aborted."
    : "The completed run was removed.";
  lines.push(renderKilledTextRow(inner, theme, `      ${success}✓${RESET}${panelBg} ${muted}${action}${RESET}`));
  lines.push(renderKilledTextRow(
    inner,
    theme,
    `      ${success}✓${RESET}${panelBg} ${muted}Run removed from live history and status.${RESET}`,
  ));
  lines.push(renderBlankRow(inner, theme));
  lines.push(renderKilledFooter(width, theme));
  return lines;
}
