/**
 * Renderer for the inline chat-history workflow form.
 *
 * Identity mirrors the multi ask_user_question dialog:
 *   - Top/bottom dynamic border rules wrap the live form.
 *   - A compact tab row shows each input (`■` valid / `□` missing) plus Run,
 *     matching the multi-question tab bar affordance.
 *   - The workflow name reads as the dialog heading with the `<i> / <n>`
 *     counter on the right.
 *   - One bordered "node card" per field with the field name centred inside
 *     the top border (matches the DAG node-card title slot in node-card.ts).
 *   - Caption row beneath each field card: `<type>  ·  <required|optional>
 *     ·  <description>` in dim.
 *   - Footer hints sit below the bottom rule, like ask_user_question hints.
 *
 *   ───────────────────────────────────────────────────────────────────
 *    ←  □ prompt   ■ iters   ✓ Run  →
 *
 *   ralph                                                     1 / 4
 *
 *   ╭───── prompt ─────────────────────────────────────────────────────╮
 *   │ build me a TUI for arg-pickers                                    │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *     text  ·  required  ·  task prompt
 *
 *   ───────────────────────────────────────────────────────────────────
 *   tab Next  ·  shift+tab Prev  ·  ctrl+x Run  ·  esc Cancel
 *
 * Submitted forms become a single-line ledger entry in scrollback. Cancelled
 * forms render no rows so cancellation leaves no chat artefact.
 *
 * The card never owns keystrokes — keystrokes are routed by the editor.
 * `renderInlineCard` is a pure function of `state + theme + width`.
 *
 * cross-ref:
 *  - packages/coding-agent/src/core/tools/ask-user-question/view/dialog-builder.ts
 *  - src/tui/node-card.ts (centred title-in-border pattern)
 *  - src/tui/graph-view.ts (statusline + chrome band composition)
 */

import type { InlineFormState } from "./inline-form-store.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import { invalidForField } from "./inputs-picker.js";
import { RESET, hexBg, hexToAnsi, paint } from "./color-utils.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

export interface InlineCardOpts {
  width: number;
  state: InlineFormState;
  theme: GraphTheme;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

function clampGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  if (c === text.length) return c;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index === c) return c;
    if (s.index > c) break;
  }
  let prev = 0;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index >= c) break;
    prev = s.index;
  }
  return prev;
}

function headToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const w = visibleWidth(g);
    if (used + w > width) break;
    out += g;
    used += w;
  }
  return out;
}

function tailToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  const gs = graphemes(text);
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i]!;
    const w = visibleWidth(g);
    if (used + w > width) break;
    out = g + out;
    used += w;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

export function renderInlineCard(opts: InlineCardOpts): string[] {
  const { state, theme, width } = opts;
  if (state.status === "submitted") return [fitLine(renderSubmittedLine(state, theme), width)];
  if (state.status === "cancelled") return [];
  return renderEditingCard(opts).map((line) => fitLine(line, width));
}

function renderEditingCard(opts: InlineCardOpts): string[] {
  const { state, theme, width } = opts;
  const lines: string[] = [];

  lines.push(...renderHeaderBand(state, theme, width));
  if (state.description) {
    lines.push("  " + paint(state.description, theme.textMuted));
  }
  lines.push("");

  const activeField = state.fields[state.focusedIdx];
  if (activeField) {
    const raw = state.rawText[activeField.name] ?? "";
    lines.push(...renderActiveField(activeField, raw, state.focusedIdx, state.caret, theme, width));
    lines.push("");
  }

  lines.push(...renderFooterBand(theme, width));
  return lines;
}

// ---------------------------------------------------------------------------
// Header / footer chrome bands
// ---------------------------------------------------------------------------

function renderHeaderBand(state: InlineFormState, theme: GraphTheme, width: number): string[] {
  const focusTargetCount = state.fields.length;
  const counter = `${Math.min(state.focusedIdx + 1, focusTargetCount)} / ${focusTargetCount}`;
  return [
    renderDialogRule(theme, width),
    renderInputTabBar(state, theme, width),
    "",
    renderWorkflowHeading(state.workflowName, counter, theme, width),
  ];
}

function renderFooterBand(theme: GraphTheme, width: number): string[] {
  return [renderDialogRule(theme, width), renderFooterHints(theme, width)];
}

function renderDialogRule(theme: GraphTheme, width: number): string {
  return paint("─".repeat(Math.max(1, width)), theme.accent);
}

function renderInputTabBar(state: InlineFormState, theme: GraphTheme, width: number): string {
  const pieces: string[] = [" ← "];
  for (let i = 0; i < state.fields.length; i++) {
    const field = state.fields[i]!;
    const raw = state.rawText[field.name] ?? "";
    const valid = invalidForField(field, raw, i) === null;
    const box = valid ? "■" : "□";
    const rawSeg = ` ${box} ${field.name} `;
    const styled = i === state.focusedIdx
      ? hexBg(theme.selection) + hexToAnsi(theme.text) + rawSeg + RESET
      : paint(rawSeg, valid ? theme.success : theme.textMuted);
    pieces.push(styled, " ");
  }
  const allValid = state.fields.every((field, i) => invalidForField(field, state.rawText[field.name] ?? "", i) === null);
  pieces.push(paint(" ✓ Run ", allValid ? theme.success : theme.dim), " →");
  return truncateToWidth(pieces.join(""), width, "", true);
}

function renderWorkflowHeading(
  workflowName: string,
  counter: string,
  theme: GraphTheme,
  width: number,
): string {
  const prefix = " ";
  const counterWidth = visibleWidth(counter);
  if (width <= prefix.length) return "";
  if (counterWidth + prefix.length + 1 > width) {
    return prefix + paint(truncateToWidth(counter, width - prefix.length, "…"), theme.dim);
  }
  const nameBudget = Math.max(0, width - prefix.length - counterWidth - 1);
  const name = truncateToWidth(workflowName, nameBudget, "…");
  const filler = Math.max(1, width - prefix.length - visibleWidth(name) - counterWidth);
  return prefix + paint(name, theme.text, { bold: true }) + " ".repeat(filler) + paint(counter, theme.dim);
}

function renderFooterHints(theme: GraphTheme, width: number): string {
  const hint = "tab Next  ·  shift+tab Prev  ·  ctrl+x Run  ·  esc Cancel";
  return paint(truncateToWidth(hint, width, "…"), theme.dim);
}

// ---------------------------------------------------------------------------
// Active field body (ask_user_question-style list/input rows)
// ---------------------------------------------------------------------------

function renderActiveField(
  field: WorkflowInputEntry,
  raw: string,
  index: number,
  caret: number,
  theme: GraphTheme,
  width: number,
): string[] {
  const invalid = invalidForField(field, raw, index);
  return [
    " " + paint(field.name, theme.text, { bold: true }),
    renderCaption(field, invalid, theme),
    "",
    ...renderAskStyleFieldBody(field, raw, caret, theme, width),
  ];
}

function renderCaption(
  field: WorkflowInputEntry,
  invalid: string | null,
  theme: GraphTheme,
): string {
  const sep = paint("  ·  ", theme.dim);
  const tagColor = invalid
    ? theme.error
    : field.required
      ? theme.warning
      : theme.dim;
  const tagLabel = invalid ?? (field.required ? "required" : "optional");
  const desc = field.description
    ? sep + paint(field.description, theme.dim)
    : "";
  return (
    "  " +
    paint(field.type, theme.dim) +
    sep +
    paint(tagLabel, tagColor) +
    desc
  );
}

function renderAskStyleFieldBody(
  field: WorkflowInputEntry,
  raw: string,
  caret: number,
  theme: GraphTheme,
  width: number,
): string[] {
  if (field.type === "select" && field.choices && field.choices.length > 0) {
    const selected = Math.max(0, field.choices.indexOf(raw));
    return field.choices.map((choice, i) => renderAskRow(i + 1, choice, i === selected, theme, width));
  }

  if (field.type === "boolean") {
    const on = raw === "true";
    return [
      renderAskRow(1, "on", on, theme, width),
      renderAskRow(2, "off", !on, theme, width),
    ];
  }

  return renderAskInputRows(raw, caret, field.placeholder, theme, width);
}

function renderAskRow(index: number, label: string, active: boolean, theme: GraphTheme, width: number): string {
  const pointer = active ? "❯ " : "  ";
  const prefix = `${pointer}${index}. `;
  const plain = prefix + label;
  const clipped = truncateToWidth(plain, width, "…");
  if (!active) return paint(clipped, theme.textMuted);
  return hexBg(theme.selection) + hexToAnsi(theme.text) + clipped + RESET;
}

function renderAskInputRows(
  raw: string,
  caret: number,
  placeholder: string | undefined,
  theme: GraphTheme,
  width: number,
): string[] {
  const prefix = "❯ 1. ";
  const continuationPrefix = " ".repeat(visibleWidth(prefix));
  const usable = Math.max(1, width - visibleWidth(prefix));
  if (raw === "") {
    const value = placeholder && placeholder.length > 0
      ? paint(placeholder, theme.dim) + cursorBlock()
      : cursorBlock();
    return [paint(prefix, theme.accent) + truncateToWidth(value, usable, "…", true)];
  }

  const layout = layoutTextField(raw, usable, caret);
  return layout.lines.map((line, row) => {
    const linePrefix = row === 0 ? prefix : continuationPrefix;
    const content = row === layout.cursorRow
      ? renderCaretLine(line, layout.cursorOffset ?? line.length, usable, theme, theme.text)
      : truncateToWidth(paint(line, theme.text), usable, "…", true);
    return paint(linePrefix, row === 0 ? theme.accent : theme.dim) + content;
  });
}

function renderCaretLine(
  raw: string,
  caret: number,
  usable: number,
  theme: GraphTheme,
  color: string,
): string {
  const safe = clampGraphemeOffset(raw, caret);
  const beforeFull = raw.slice(0, safe);
  const afterFull = raw.slice(safe);
  const [at = ""] = graphemes(afterFull);
  const afterRest = at === "" ? "" : afterFull.slice(at.length);
  const cursorPlain = at !== "" ? at : " ";
  const cursorWidth = Math.max(1, visibleWidth(cursorPlain));
  let before = beforeFull;
  let after = afterRest;
  if (visibleWidth(beforeFull) + cursorWidth + visibleWidth(afterRest) > usable) {
    before = tailToWidth(beforeFull, Math.max(0, usable - cursorWidth));
    after = headToWidth(afterRest, Math.max(0, usable - visibleWidth(before) - cursorWidth));
  }
  return clip(paint(before, color) + cursorBlock(cursorPlain) + paint(after, color), usable);
}

// ---------------------------------------------------------------------------
// Frozen states
// ---------------------------------------------------------------------------

function renderSubmittedLine(state: InlineFormState, theme: GraphTheme): string {
  return (
    paint("✓ submitted", theme.success, { bold: true }) +
    paint("  ·  ", theme.dim) +
    paint(composeCommand(state), theme.dim)
  );
}

function composeCommand(state: InlineFormState): string {
  const parts: string[] = [`/workflow ${state.workflowName}`];
  for (const f of state.fields) {
    const v = state.rawText[f.name] ?? "";
    if (v === "" && !f.required) continue;
    const needsQuotes = /\s|=/.test(v);
    parts.push(`${f.name}=${needsQuotes ? `"${v}"` : v}`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function fitLine(ansi: string, width: number): string {
  return truncateToWidth(ansi, Math.max(0, width), "…", true);
}

function clip(ansi: string, budget: number): string {
  return truncateToWidth(ansi, Math.max(0, budget), "…", true);
}

function cursorBlock(text = " "): string {
  return `\x1b[7m${text}\x1b[0m`;
}

/**
 * Lay out a multi-line text field into visual rows while tracking where the
 * caret should appear on screen. Newlines (`\n`) always start a new visual
 * row; logical lines that exceed `usable` cells wrap at the character
 * boundary (a deliberately simple rule — word-wrap would also be fine but
 * adds noise for prompt-style inputs where every character is signal).
 *
 * Caret semantics:
 *   - `caret` is the byte offset into `raw`.
 *   - The returned `cursorRow`/`cursorCol` point to the visual cell where
 *     the cursor glyph should render — the cell currently occupied by the
 *     character AT `caret` (so the cursor visually sits BEFORE that
 *     character). When `caret === raw.length`, the cursor lands at the
 *     end of the last visual row.
 *   - When `caret` falls on a wrap boundary, the cursor lands on the start
 *     of the next visual row, matching how Pi's own editor positions the
 *     caret after the last character that fit.
 *
 * cross-ref: pi-tui dist/components/editor.js `layoutText`/`wordWrapLine`.
 */
export function layoutTextField(
  raw: string,
  usable: number,
  caret: number,
): { lines: string[]; cursorRow: number; cursorCol: number; cursorOffset?: number } {
  const width = Math.max(1, Math.floor(usable));
  const safeCaret = clampGraphemeOffset(raw, caret);
  const visualLines: string[] = [];
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  let curLine = "";
  let curWidth = 0;
  let lineStart = 0;

  const pushLine = (end: number): void => {
    visualLines.push(curLine);
    lineStarts.push(lineStart);
    lineEnds.push(end);
    curLine = "";
    curWidth = 0;
    lineStart = end;
  };

  for (const s of graphemeSegmenter.segment(raw)) {
    const offset = s.index;
    const g = s.segment;
    if (g === "\n") {
      pushLine(offset);
      lineStart = offset + g.length;
      continue;
    }
    const w = visibleWidth(g);
    if (curLine !== "" && curWidth + w > width) {
      pushLine(offset);
    }
    curLine += g;
    curWidth += w;
    if (curWidth >= width) {
      pushLine(offset + g.length);
    }
  }
  visualLines.push(curLine);
  lineStarts.push(lineStart);
  lineEnds.push(raw.length);

  let cursorRow = visualLines.length - 1;
  for (let i = 0; i < visualLines.length; i++) {
    const start = lineStarts[i]!;
    const end = lineEnds[i]!;
    const nextStart = lineStarts[i + 1];
    if (safeCaret >= start && safeCaret < end) {
      cursorRow = i;
      break;
    }
    if (safeCaret === end) {
      cursorRow = nextStart === safeCaret ? i + 1 : i;
    }
  }
  cursorRow = Math.max(0, Math.min(cursorRow, visualLines.length - 1));
  const line = visualLines[cursorRow] ?? "";
  const cursorOffset = Math.max(0, Math.min(safeCaret - (lineStarts[cursorRow] ?? 0), line.length));
  const cursorCol = visibleWidth(line.slice(0, cursorOffset));
  return { lines: visualLines, cursorRow, cursorCol, cursorOffset };
}
