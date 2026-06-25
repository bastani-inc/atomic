import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import { paint } from "./color-utils.js";
import {
  graphemes,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "./text-helpers.js";
import { renderCompactBandHeader } from "./header.js";
import {
  renderAskChoiceRows,
  renderSubmitControls,
} from "./submit-pane.js";
import type { InputsPickerRenderOpts, InputsPickerState } from "./inputs-picker-types.js";
import { computeInvalid, invalidForField } from "./inputs-picker-types.js";
import {
  clampGraphemeOffset,
  headToWidth,
  layoutEditableText,
  tailToWidth,
} from "./inputs-picker-editing.js";

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
