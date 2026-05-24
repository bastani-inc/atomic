/**
 * Interactive argument picker for `/workflow <name>` invocations.
 *
 * Opens when the user types `/workflow <name>` in the TUI without enough
 * key=value tokens to satisfy the declared schema. Mirrors the
 * `ask_user_question` dialog shape: a top rule, a compact field tab bar,
 * one page of ask-style question rows, and dim footer hints. The workflow is
 * already chosen, so there is no fuzzy-list pane.
 *
 *   ───────────────────────────────────────────
 *    ←  ■ prompt   ■ focus   ✓ Submit  →
 *
 *   The high-level task to plan and execute.
 *
 *   ❯ 1. Build me a TUI for…
 *
 *   ───────────────────────────────────────────
 *   Enter to select · ↑/↓ to navigate · Tab to switch input fields · Esc to cancel
 *
 * Field-type renderers:
 *   - string / number : single-row ask-style input with blinking cursor
 *   - text            : 3-row scrolling ask-style textarea
 *   - boolean         : vertical on/off choice list (space flips)
 *   - select          : vertical choice list, ←/→ cycles choices
 *
 * cross-ref:
 *   - flora131/atomic research/designs/workflow-picker-tui.tsx (PROMPT phase)
 *   - flora131/atomic packages/atomic-sdk/src/components/workflow-picker-panel.tsx
 *   - src/tui/session-picker.ts (sibling overlay; same chrome + key style)
 *   - DESIGN.md §5 Section Labels
 */

import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import { paint } from "./color-utils.js";
import {
  decodePrintableKey,
  graphemes,
  graphemeSegments,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "./text-helpers.js";
import { renderCompactBandHeader } from "./header.js";
import {
  renderAskChoiceRows,
  renderSubmitControls,
} from "./submit-pane.js";
import {
  type KeybindingsLike,
  TUI_ACTION,
  deleteRange,
  lineEnd,
  lineStart,
  matchesAction,
  wordLeft,
  wordRight,
} from "./keybindings-adapter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Mutable picker state. The renderer is pure — state mutation happens in
 * `handleInputsPickerInput`, which returns one of these discriminated
 * actions so the host adapter (`inputs-overlay.ts`) knows when to resolve
 * the wrapping Promise.
 */
export interface InputsPickerState {
  /** Index of the currently-focused field. */
  focusedIdx: number;
  /**
   * Raw string the user has typed/selected for each field, keyed by name.
   * Booleans store `"true"` / `"false"`; numbers store their text form;
   * selects store the chosen choice; text/string store the literal value.
   * `coerceValues()` converts these into typed objects at submit time.
   */
  rawText: Record<string, string>;
  /** Reserved for older form snapshots; Submit is now a single final action. */
  submitChoiceIdx: number;
  /**
   * Set of field indices that failed validation on the most recent submit
   * attempt. Used to dim the run hint and to highlight a field if the user
   * retries with required fields still empty.
   */
  invalidIndices: readonly number[];
  /** Cursor offset within the focused single-line text field. */
  caret: number;
}

/** Discriminated action returned by the key handler. */
export type InputsPickerAction =
  | { kind: "noop" }
  | { kind: "cancel" }
  | { kind: "run"; values: Record<string, unknown> };

export interface InputsPickerRenderOpts {
  width: number;
  theme: GraphTheme;
  workflowName: string;
  fields: readonly WorkflowInputEntry[];
  state: InputsPickerState;
  /** True when the blinking cursor is in its visible half-period. */
  cursorOn: boolean;
}

// ---------------------------------------------------------------------------
// State construction + value coercion
// ---------------------------------------------------------------------------

/**
 * Seed `rawText` from declared defaults plus any values the user already
 * passed as key=value tokens. Enums/selects fall back to their first choice
 * (matching atomic's seeding rule), booleans default to `false`, and
 * numbers/text default to empty unless the schema declared a default.
 */
export function createInputsPickerState(
  fields: readonly WorkflowInputEntry[],
  prefilled: Record<string, unknown> = {},
): InputsPickerState {
  const rawText: Record<string, string> = {};
  for (const f of fields) {
    if (prefilled[f.name] !== undefined) {
      rawText[f.name] = String(prefilled[f.name]);
      continue;
    }
    if (f.default !== undefined) {
      rawText[f.name] = String(f.default);
      continue;
    }
    if (f.type === "select" && f.choices && f.choices.length > 0) {
      rawText[f.name] = f.choices[0]!;
      continue;
    }
    if (f.type === "boolean") {
      rawText[f.name] = "false";
      continue;
    }
    rawText[f.name] = "";
  }
  // Focus the first invalid field if any; otherwise field 0. This keeps the
  // cursor on the first thing the user actually needs to fill in.
  const firstInvalid = fields.findIndex((f, i) =>
    invalidForField(f, rawText[f.name] ?? "", i) !== null,
  );
  const focusedIdx = firstInvalid >= 0 ? firstInvalid : 0;
  return {
    focusedIdx,
    rawText,
    submitChoiceIdx: 0,
    invalidIndices: [],
    caret: (rawText[fields[focusedIdx]?.name ?? ""] ?? "").length,
  };
}

/**
 * Coerce the rawText map into typed values matching the declared schema.
 * Mirrors the `parseWorkflowArgs` JSON-tolerant logic for text/string
 * fields (so users can paste `["a","b"]` into a text box and have it land
 * as an array), and enforces numeric / boolean parsing for typed fields.
 *
 * Throws on hard parse failure for required fields; lenient on optional.
 * The picker only calls `coerceValues` after `validate` succeeds, so the
 * thrown branch is a defensive guard, not an expected path.
 */
export function coerceValues(
  fields: readonly WorkflowInputEntry[],
  raw: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.name] ?? "";
    if (v === "" && !f.required) continue; // skip empty optionals
    switch (f.type) {
      case "number":
      case "integer": {
        const n = Number(v);
        if (Number.isFinite(n)) out[f.name] = n;
        break;
      }
      case "boolean": {
        out[f.name] = v === "true" || v === "1";
        break;
      }
      case "select":
        out[f.name] = v;
        break;
      case "text":
      case "string":
      default: {
        // Try JSON for power users pasting structured data; otherwise treat
        // as a literal string. Mirrors parseWorkflowArgs.
        if (
          (v.startsWith("{") && v.endsWith("}")) ||
          (v.startsWith("[") && v.endsWith("]"))
        ) {
          try {
            out[f.name] = JSON.parse(v) as unknown;
            break;
          } catch {
            // fall through
          }
        }
        out[f.name] = v;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Return the reason why `field` is invalid for `value`, or `null` if valid.
 * Used both to flag fields on submit and to drive the dim state of the run
 * key hint.
 */
export function invalidForField(
  field: WorkflowInputEntry,
  value: string,
  _idx: number,
): string | null {
  if (field.required && value.trim() === "") return "required";
  if (
    field.type === "select" &&
    field.choices &&
    value !== "" &&
    !field.choices.includes(value)
  ) {
    return "not in choices";
  }
  if (
    (field.type === "number" || field.type === "integer") &&
    value !== "" &&
    !Number.isFinite(Number(value))
  ) {
    return "must be a number";
  }
  return null;
}

export function computeInvalid(
  fields: readonly WorkflowInputEntry[],
  raw: Record<string, string>,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (invalidForField(f, raw[f.name] ?? "", i) !== null) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function previousGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  let prev = 0;
  for (const s of graphemeSegments(text)) {
    if (s.index >= c) break;
    prev = s.index;
  }
  return prev;
}

function nextGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  for (const s of graphemeSegments(text)) {
    if (s.index >= c) return Math.min(text.length, s.index + s.segment.length);
    if (s.index + s.segment.length > c) return s.index + s.segment.length;
  }
  return text.length;
}

function clampGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  if (c === text.length) return c;
  for (const s of graphemeSegments(text)) {
    if (s.index === c) return c;
    if (s.index > c) break;
  }
  return previousGraphemeOffset(text, c);
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

function isPrintableGrapheme(data: string): boolean {
  if (data.length === 0 || data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return graphemes(data).length === 1;
}

interface TextLayoutLine {
  text: string;
  start: number;
  end: number;
}

function layoutEditableText(raw: string, usable: number): TextLayoutLine[] {
  const width = Math.max(1, Math.floor(usable));
  const lines: TextLayoutLine[] = [];
  let line = "";
  let lineStart = 0;
  let lineWidth = 0;
  for (const s of graphemeSegments(raw)) {
    const offset = s.index;
    const g = s.segment;
    if (g === "\n") {
      lines.push({ text: line, start: lineStart, end: offset });
      line = "";
      lineStart = offset + g.length;
      lineWidth = 0;
      continue;
    }
    const w = visibleWidth(g);
    if (line !== "" && lineWidth + w > width) {
      lines.push({ text: line, start: lineStart, end: offset });
      line = "";
      lineStart = offset;
      lineWidth = 0;
    }
    line += g;
    lineWidth += w;
    if (lineWidth >= width) {
      lines.push({ text: line, start: lineStart, end: offset + g.length });
      line = "";
      lineStart = offset + g.length;
      lineWidth = 0;
    }
  }
  lines.push({ text: line, start: lineStart, end: raw.length });
  return lines;
}

function visualColumnAt(text: string, caret: number): number {
  return visibleWidth(text.slice(0, clampGraphemeOffset(text, caret)));
}

function offsetAtVisualColumn(text: string, targetCol: number): number {
  let col = 0;
  for (const s of graphemeSegments(text)) {
    const w = visibleWidth(s.segment);
    if (col + w > targetCol) return s.index;
    col += w;
  }
  return text.length;
}

function caretLineUp(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const lineStartOffset = raw.lastIndexOf("\n", safe - 1) + 1;
  if (lineStartOffset === 0) return null;
  const prevLineEnd = lineStartOffset - 1;
  const prevLineStart = raw.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const col = visualColumnAt(raw.slice(lineStartOffset, safe), raw.slice(lineStartOffset, safe).length);
  const prevLine = raw.slice(prevLineStart, prevLineEnd);
  return prevLineStart + offsetAtVisualColumn(prevLine, col);
}

function caretLineDown(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const nextNl = raw.indexOf("\n", safe);
  if (nextNl === -1) return null;
  const lineStartOffset = raw.lastIndexOf("\n", safe - 1) + 1;
  const col = visualColumnAt(raw.slice(lineStartOffset, safe), raw.slice(lineStartOffset, safe).length);
  const nextLineStart = nextNl + 1;
  const nextNlAfter = raw.indexOf("\n", nextLineStart);
  const nextLineEnd = nextNlAfter === -1 ? raw.length : nextNlAfter;
  const nextLine = raw.slice(nextLineStart, nextLineEnd);
  return nextLineStart + offsetAtVisualColumn(nextLine, col);
}

/**
 * Render a single field's three-row block: top border with title, content
 * row (variable per type), bottom border, then the caption row underneath.
 * Returns one ANSI string per terminal line; the caller joins with `\n`.
 *
 * Exported so the chat-history mirror (inline-form-card) renders fields
 * identically to this overlay — single source of truth for the field shape.
 */
/**
 * Render a single editable line. When `value` is empty and the field is
 * focused, paint a dim placeholder with the cursor sitting on its first
 * character — the readline-style "type to replace" affordance.
 */
function renderInlineText(
  value: string,
  focused: boolean,
  cursorOn: boolean,
  usable: number,
  theme: GraphTheme,
  placeholder: string | undefined,
  isEmpty: boolean,
  caret?: number,
): string {
  const showCursor = focused && cursorOn;
  if (isEmpty) {
    const ph = placeholder ?? "";
    if (ph === "") {
      return padLine(showCursor ? paint("▋", theme.accent) : " ", usable);
    }
    const [first = "", ...rest] = graphemes(ph);
    const head = showCursor
      ? paint(first, theme.bg, { bg: theme.accent })
      : paint(first, theme.dim);
    return padLine(head + paint(rest.join(""), theme.dim), usable);
  }
  const safe = clampGraphemeOffset(value, caret ?? value.length);
  const beforeFull = value.slice(0, safe);
  const afterFull = value.slice(safe);
  const [at = ""] = graphemes(afterFull);
  const afterRest = at === "" ? "" : afterFull.slice(at.length);
  const cursorPlain = showCursor ? (at !== "" ? at : "▋") : at;
  const cursorWidth = Math.max(1, visibleWidth(cursorPlain));
  const totalWidth = visibleWidth(beforeFull) + cursorWidth + visibleWidth(showCursor ? afterRest : afterFull.slice(at.length));
  let before = beforeFull;
  let after = showCursor ? afterRest : afterFull.slice(at.length);
  if (totalWidth > usable) {
    before = tailToWidth(beforeFull, Math.max(0, usable - cursorWidth));
    after = headToWidth(showCursor ? afterRest : afterFull.slice(at.length), Math.max(0, usable - visibleWidth(before) - cursorWidth));
  }
  const cursorCell = showCursor
    ? at !== ""
      ? paint(at, theme.bg, { bg: theme.accent })
      : paint("▋", theme.accent)
    : paint(at, theme.text);
  return padLine(paint(before, theme.text) + cursorCell + paint(after, theme.text), usable);
}

function padLine(s: string, usable: number): string {
  // The caller appends `│` immediately after this string, so the row must
  // fill exactly `usable` cells of visible width — otherwise the right
  // border slides leftward and the field card looks broken-narrow under a
  // full-width top/bottom border. Pad short content; clip overflow with `…`.
  // visibleWidth/truncateToWidth are width-correct for CJK/emoji glyphs.
  const len = visibleWidth(s);
  if (len === usable) return s;
  if (len < usable) return s + " ".repeat(usable - len);
  return truncateToWidth(s, usable, "…", true);
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), "…", true);
}

function renderWorkflowHeader(
  workflowName: string,
  fieldCount: number,
  focusedIdx: number,
  theme: GraphTheme,
  width: number,
): string[] {
  const current = Math.min(fieldCount, Math.max(1, focusedIdx + 1));
  return renderCompactBandHeader({
    label: "WORKFLOW",
    subtitle: workflowName,
    badges: fieldCount > 0 ? [{ text: `${current} / ${fieldCount}`, fg: theme.dim }] : [],
    width,
    theme,
  });
}

function renderInputField(
  field: WorkflowInputEntry,
  raw: string,
  caret: number,
  cursorOn: boolean,
  invalid: string | null,
  focused: boolean,
  theme: GraphTheme,
  width: number,
): string[] {
  const boxWidth = Math.max(4, width);
  const contentWidth = Math.max(1, boxWidth - 2);
  const borderColor = focused ? theme.accent : theme.borderDim;
  const rows = renderAskStyleInputBody(field, raw, focused ? caret : raw.length, cursorOn, focused, theme, contentWidth);
  const lines = [
    renderFieldTop(field.name, boxWidth, borderColor, focused, theme),
    ...rows.map((row) => renderFieldRow(row, contentWidth, borderColor, theme)),
    renderFieldBottom(boxWidth, borderColor),
    ...renderFieldMeta(field, invalid, theme, width),
  ];
  return lines;
}

function renderAskStyleInputBody(
  field: WorkflowInputEntry,
  raw: string,
  caret: number,
  cursorOn: boolean,
  focused: boolean,
  theme: GraphTheme,
  width: number,
): string[] {
  if (field.type === "select" && field.choices && field.choices.length > 0) {
    const selected = Math.max(0, field.choices.indexOf(raw));
    return field.choices.flatMap((choice, i) =>
      renderAskChoiceRows(i + 1, focused || i !== selected ? choice : `✓ ${choice}`, focused && i === selected, theme, width),
    );
  }

  if (field.type === "boolean") {
    const normalized = raw.trim().toLowerCase();
    const hasValue = normalized.length > 0;
    const on = normalized === "true" || normalized === "1";
    return [
      ...renderAskChoiceRows(1, focused || !hasValue || !on ? "on" : "✓ on", focused && hasValue && on, theme, width),
      ...renderAskChoiceRows(2, focused || !hasValue || on ? "off" : "✓ off", focused && hasValue && !on, theme, width),
    ];
  }

  return renderAskInputRows(field, raw, caret, cursorOn, focused, theme, width);
}

function renderAskInputRows(
  field: WorkflowInputEntry,
  raw: string,
  caret: number,
  cursorOn: boolean,
  focused: boolean,
  theme: GraphTheme,
  width: number,
): string[] {
  const usable = Math.max(1, width);

  if (field.type !== "text") {
    return [renderInlineText(raw, focused, cursorOn, usable, theme, field.placeholder, raw === "", caret)];
  }

  const ROWS = 3;
  if (raw === "") {
    return [
      renderInlineText("", focused, cursorOn, usable, theme, field.placeholder, true),
      ...Array.from({ length: ROWS - 1 }, () => padLine("", usable)),
    ];
  }

  const layout = layoutEditableText(raw, usable);
  const safeCaret = clampGraphemeOffset(raw, caret);
  let cursorRow = layout.length - 1;
  for (let i = 0; i < layout.length; i++) {
    const line = layout[i]!;
    const next = layout[i + 1];
    if (safeCaret >= line.start && safeCaret < line.end) {
      cursorRow = i;
      break;
    }
    if (safeCaret === line.end) {
      cursorRow = next?.start === safeCaret ? i + 1 : i;
    }
  }
  cursorRow = Math.max(0, Math.min(cursorRow, layout.length - 1));
  const start = Math.max(0, Math.min(cursorRow - ROWS + 1, layout.length - ROWS));
  const rows: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    const rowIdx = start + i;
    const line = layout[rowIdx];
    if (!line) {
      rows.push(padLine("", usable));
      continue;
    }
    const lineCaret = safeCaret >= line.start && safeCaret <= line.end
      ? safeCaret - line.start
      : line.text.length;
    rows.push(
      renderInlineText(
        line.text,
        focused && rowIdx === cursorRow,
        cursorOn,
        usable,
        theme,
        field.placeholder,
        false,
        lineCaret,
      ),
    );
  }
  return rows;
}

export function renderInputsPicker(opts: InputsPickerRenderOpts): string[] {
  const { theme, workflowName, fields, state, width, cursorOn } = opts;
  const lines: string[] = [];

  lines.push(...renderWorkflowHeader(workflowName, fields.length, state.focusedIdx, theme, width));
  lines.push("");

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    const raw = state.rawText[field.name] ?? "";
    const invalid = state.invalidIndices.includes(i)
      ? invalidForField(field, raw, i)
      : null;
    lines.push(...renderInputField(field, raw, state.caret, cursorOn, invalid, state.focusedIdx === i, theme, width));
    lines.push("");
  }

  lines.push(...renderPickerSubmitControls(fields, state, theme, width));

  return lines.map((line) => fitLine(line, width));
}

function renderFieldTop(
  title: string,
  width: number,
  borderColor: string,
  focused: boolean,
  theme: GraphTheme,
): string {
  const label = ` ${title} `;
  const labelText = paint(label, focused ? theme.accent : theme.textMuted, { bold: focused });
  const fill = Math.max(0, width - visibleWidth(label) - 2);
  return paint("╭", borderColor) + labelText + paint("─".repeat(fill) + "╮", borderColor);
}

function renderFieldRow(row: string, contentWidth: number, borderColor: string, _theme: GraphTheme): string {
  const clipped = truncateToWidth(row, contentWidth, "", true);
  const padded = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
  return paint("│", borderColor) + padded + paint("│", borderColor);
}

function renderFieldBottom(width: number, borderColor: string): string {
  return paint("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", borderColor);
}

function renderFieldMeta(
  field: WorkflowInputEntry,
  invalid: string | null,
  theme: GraphTheme,
  width: number,
): string[] {
  const required = field.required ? "required" : "optional";
  const text = field.description && field.description.length > 0
    ? `${field.type} · ${required} · ${field.description}`
    : `${field.type} · ${required}`;
  const lines = wrapPlainText(text, width).map((line) => paintRequiredMetaLine(line, field.required === true, theme));
  if (invalid) lines.push(...wrapPlainText(invalid, width).map((line) => paint(line, theme.error)));
  return lines;
}

function paintRequiredMetaLine(line: string, required: boolean, theme: GraphTheme): string {
  if (!required) return paint(line, theme.textMuted);
  return line
    .split(/(\brequired\b)/g)
    .map((part) => part === "required" ? paint(part, theme.warning) : paint(part, theme.textMuted))
    .join("");
}

function renderPickerSubmitControls(
  fields: readonly WorkflowInputEntry[],
  state: InputsPickerState,
  theme: GraphTheme,
  width: number,
): string[] {
  const invalid = computeInvalid(fields, state.rawText);
  return renderSubmitControls({
    invalidFieldNames: invalid.map((i) => fields[i]!.name),
    submitFocused: state.focusedIdx === fields.length,
    theme,
    width,
  });
}

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

/**
 * Drive the picker. The caller (overlay adapter) feeds raw keystrokes here
 * and reacts to the returned action: `noop` keeps the overlay mounted,
 * `cancel` tears it down with no result, `run` tears it down and resolves
 * with the coerced typed value map.
 *
 * Keys (form mode):
 *   tab              — switch input fields, then the final Submit action
 *   shift+tab        — previous input field / final Submit action
 *   left / right     — select: cycle choices; boolean: flip; text: caret
 *   space            — boolean: flip
 *   enter            — text: newline; otherwise: next field
 *   backspace        — delete char left of caret
 *   esc / ctrl+c     — close picker without running
 *
 * Keys (Submit action):
 *   up / down        — move back into the question list
 *   enter            — submit immediately, or focus the first invalid field
 */
export function handleInputsPickerInput(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  keybindings?: KeybindingsLike,
): InputsPickerAction {
  if (fields.length === 0) {
    // Defensive: a workflow with zero declared inputs shouldn't reach the
    // picker (we gate on `fields.length > 0` at the open() site), but if
    // it does, treat any keystroke as a noop and let the host close us.
    if (isCancelKey(key)) return { kind: "cancel" };
    return { kind: "noop" };
  }
  return handleFormKey(key, state, fields, keybindings);
}

function handleFormKey(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  // ── Global navigation (workflow form contract, not Pi actions) ──
  if (isCancelKey(key)) return { kind: "cancel" };
  if (matchesKey(key, Key.tab)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (matchesKey(key, Key.shift("tab"))) {
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (state.focusedIdx === fields.length) return handleSubmitKey(key, state, fields, kb);

  const field = fields[state.focusedIdx]!;
  const name = field.name;
  const cur = state.rawText[name] ?? "";

  // ── Per-type edits ──
  if (field.type === "select") {
    return handleSelectKey(key, field, state, fields, kb);
  }
  if (field.type === "boolean") {
    return handleBooleanKey(key, field, state, fields, kb);
  }

  // string / text / number — text editing semantics. All editor-mode keys
  // (cursor, word jump, line jump, deletions) route through Pi's
  // KeybindingsManager so user-configured bindings work uniformly.
  const caret = Math.max(0, Math.min(state.caret, cur.length));

  if (matchesAction(kb, key, TUI_ACTION.editorCursorUp)) {
    if (field.type === "text") {
      const nextCaret = caretLineUp(cur, caret);
      if (nextCaret !== null) {
        state.caret = nextCaret;
        return { kind: "noop" };
      }
    }
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorDown)) {
    if (field.type === "text") {
      const nextCaret = caretLineDown(cur, caret);
      if (nextCaret !== null) {
        state.caret = nextCaret;
        return { kind: "noop" };
      }
    }
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorWordLeft")) {
    state.caret = wordLeft(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorWordRight")) {
    state.caret = wordRight(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorLineStart")) {
    state.caret = lineStart(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorLineEnd")) {
    state.caret = lineEnd(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorLeft)) {
    state.caret = previousGraphemeOffset(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorRight)) {
    state.caret = nextGraphemeOffset(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteWordBackward")) {
    const start = wordLeft(cur, caret);
    const r = deleteRange(cur, start, caret, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteWordForward")) {
    const end = wordRight(cur, caret);
    const r = deleteRange(cur, caret, end, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteToLineStart")) {
    const start = lineStart(cur, caret);
    const r = deleteRange(cur, start, caret, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteToLineEnd")) {
    const end = lineEnd(cur, caret);
    const r = deleteRange(cur, caret, end, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteCharBackward")) {
    if (caret > 0) {
      const r = deleteRange(cur, previousGraphemeOffset(cur, caret), caret, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
    }
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteCharForward")) {
    if (caret < cur.length) {
      const r = deleteRange(cur, caret, nextGraphemeOffset(cur, caret), caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
    }
    return { kind: "noop" };
  }
  if (
    matchesAction(kb, key, TUI_ACTION.inputSubmit) ||
    matchesAction(kb, key, "tui.input.newLine")
  ) {
    if (field.type === "text") {
      state.rawText[name] = cur.slice(0, caret) + "\n" + cur.slice(caret);
      state.caret = caret + 1;
    } else {
      moveFocus(state, fields, +1);
    }
    return { kind: "noop" };
  }
  // Printable insert. Accept raw graphemes and terminal-encoded printable
  // keys (CSI-u / Kitty). VSCode's integrated terminal can emit printable
  // keys as escape sequences when modifyOtherKeys is active.
  const printable = decodePrintableKey(key) ?? key;
  if (isPrintableGrapheme(printable)) {
    state.rawText[name] = cur.slice(0, caret) + printable + cur.slice(caret);
    state.caret = caret + printable.length;
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleSelectKey(
  key: string,
  field: WorkflowInputEntry,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  const choices = field.choices ?? [];
  if (choices.length === 0) return { kind: "noop" };
  const current = state.rawText[field.name] ?? choices[0]!;
  const idx = Math.max(0, choices.indexOf(current));
  if (matchesAction(kb, key, TUI_ACTION.selectUp) || matchesAction(kb, key, TUI_ACTION.editorCursorLeft)) {
    state.rawText[field.name] = choices[(idx - 1 + choices.length) % choices.length]!;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectDown) || matchesAction(kb, key, TUI_ACTION.editorCursorRight)) {
    state.rawText[field.name] = choices[(idx + 1) % choices.length]!;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectConfirm) || matchesAction(kb, key, TUI_ACTION.inputSubmit)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleBooleanKey(
  key: string,
  field: WorkflowInputEntry,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  if (
    matchesKey(key, Key.space) ||
    matchesAction(kb, key, TUI_ACTION.selectUp) ||
    matchesAction(kb, key, TUI_ACTION.selectDown) ||
    matchesAction(kb, key, TUI_ACTION.editorCursorLeft) ||
    matchesAction(kb, key, TUI_ACTION.editorCursorRight)
  ) {
    state.rawText[field.name] = state.rawText[field.name] === "true" ? "false" : "true";
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectConfirm) || matchesAction(kb, key, TUI_ACTION.inputSubmit)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleSubmitKey(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  if (matchesAction(kb, key, TUI_ACTION.selectUp) || matchesAction(kb, key, TUI_ACTION.editorCursorUp)) {
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectDown) || matchesAction(kb, key, TUI_ACTION.editorCursorDown)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (
    matchesKey(key, Key.enter) ||
    matchesAction(kb, key, TUI_ACTION.selectConfirm) ||
    matchesAction(kb, key, TUI_ACTION.inputSubmit)
  ) {
    return attemptPickerSubmit(state, fields);
  }
  return { kind: "noop" };
}

function isCancelKey(key: string): boolean {
  return matchesKey(key, Key.ctrl("c")) || matchesKey(key, Key.escape);
}

function attemptPickerSubmit(
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
): InputsPickerAction {
  const invalid = computeInvalid(fields, state.rawText);
  if (invalid.length > 0) {
    state.invalidIndices = invalid;
    state.submitChoiceIdx = 0;
    state.focusedIdx = invalid[0]!;
    state.caret = (state.rawText[fields[state.focusedIdx]!.name] ?? "").length;
    return { kind: "noop" };
  }
  state.invalidIndices = [];
  return { kind: "run", values: coerceValues(fields, state.rawText) };
}

function moveFocus(
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  delta: number,
): void {
  const n = fields.length + 1;
  if (n <= 1) return;
  state.focusedIdx = (state.focusedIdx + delta + n) % n;
  if (state.focusedIdx === fields.length) {
    state.caret = 0;
    state.submitChoiceIdx = 0;
    return;
  }
  const next = fields[state.focusedIdx]!;
  state.caret = (state.rawText[next.name] ?? "").length;
}
