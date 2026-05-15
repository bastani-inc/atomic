/**
 * Renderer for the inline chat-history workflow form.
 *
 * Identity mirrors the orchestrator panel:
 *   - 3-row mantle chrome band with an outlined accent pill on the left,
 *     workflow name beside it, and a `<i> / <n>` counter on the right.
 *   - One bordered "node card" per field with the field name centred inside
 *     the top border (matches the DAG node-card title slot in node-card.ts).
 *   - Caption row beneath each field card: `<type>  ·  <required|optional>
 *     ·  <description>` in dim.
 *   - 3-row mantle chrome footer with the `EDIT` mode pill and hints
 *     anchored at the bottom of the widget.
 *
 *   ╭ WORKFLOW ╮  ralph                                          1 / 4
 *   │ WORKFLOW │
 *   ╰──────────╯
 *
 *   ╭───── prompt ─────────────────────────────────────────────────────╮
 *   │ build me a TUI for arg-pickers                                    │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *     text  ·  required  ·  task prompt
 *
 *   ╭───── iters ──────────────────────────────────────────────────────╮
 *   │ 5                                                                 │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *     integer  ·  optional  ·  loop count
 *
 *   ╭ EDIT ╮  tab next  ·  shift+tab prev  ·  ctrl+s run  ·  esc cancel
 *   │ EDIT │
 *   ╰──────╯
 *
 * Frozen states drop all chrome — submitted and cancelled forms are
 * single-line ledger entries in the scrollback.
 *
 * The card never owns keystrokes — keystrokes are routed by the editor.
 * `renderInlineCard` is a pure function of `state + theme + width`.
 *
 * cross-ref:
 *  - src/tui/header.ts (renderOutlinePill — shared pill primitive)
 *  - src/tui/node-card.ts (centred title-in-border pattern)
 *  - src/tui/graph-view.ts (statusline + chrome band composition)
 */

import type { InlineFormState } from "./inline-form-store.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import { invalidForField } from "./inputs-picker.js";
import { renderOutlinePill } from "./header.js";
import { BOLD, RESET, hexBg, hexToAnsi, paint } from "./color-utils.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

export interface InlineCardOpts {
  width: number;
  state: InlineFormState;
  theme: GraphTheme;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

export function renderInlineCard(opts: InlineCardOpts): string[] {
  const { state, theme, width } = opts;
  if (state.status === "submitted") return [fitLine(renderSubmittedLine(state, theme), width)];
  if (state.status === "cancelled") return [fitLine(renderCancelledLine(state, theme), width)];
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

  for (let i = 0; i < state.fields.length; i++) {
    const f = state.fields[i]!;
    const raw = state.rawText[f.name] ?? "";
    const focused = i === state.focusedIdx;
    // Don't paint a focused field as invalid — the caret is already on it,
    // the user is fixing it now.
    const invalid = focused ? null : invalidForField(f, raw, i);
    lines.push(...renderFieldCard(f, raw, focused, invalid, theme, width, focused ? state.caret : undefined));
    lines.push("");
  }

  lines.push(...renderFooterBand(theme, width));
  return lines;
}

// ---------------------------------------------------------------------------
// Header / footer chrome bands
// ---------------------------------------------------------------------------

const HEADER_PILL_LABEL = "WORKFLOW";
const FOOTER_PILL_LABEL = "EDIT";

function renderHeaderBand(state: InlineFormState, theme: GraphTheme, width: number): string[] {
  const chromeBg = hexBg(theme.backgroundPanel);
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);

  const { top, mid, bot, visibleWidth: pillW } = renderOutlinePill(
    HEADER_PILL_LABEL,
    theme.accent,
    chromeBg,
  );

  const nameVisible = `  ${state.workflowName}`;
  const counter = `${state.focusedIdx + 1} / ${state.fields.length}`;
  const counterVisible = counter;

  const leftEdgePad = 1;
  const rightEdgePad = 2;
  const fillerVisible = Math.max(
    1,
    width - leftEdgePad - pillW - nameVisible.length - counterVisible.length - rightEdgePad,
  );
  const blankAcross = " ".repeat(nameVisible.length + fillerVisible + counterVisible.length + rightEdgePad);

  return [
    `${chromeBg} ${RESET}${top}${chromeBg}${blankAcross}${RESET}`,
    `${chromeBg} ${RESET}${mid}${chromeBg}  ${muted}${state.workflowName}${RESET}${chromeBg}${" ".repeat(fillerVisible)}${dim}${counter}${RESET}${chromeBg}${" ".repeat(rightEdgePad)}${RESET}`,
    `${chromeBg} ${RESET}${bot}${chromeBg}${blankAcross}${RESET}`,
  ];
}

function renderFooterBand(theme: GraphTheme, width: number): string[] {
  const chromeBg = hexBg(theme.backgroundPanel);
  const text = hexToAnsi(theme.text);
  const muted = hexToAnsi(theme.textMuted);
  const dim = hexToAnsi(theme.dim);

  const { top, mid, bot, visibleWidth: pillW } = renderOutlinePill(
    FOOTER_PILL_LABEL,
    theme.accent,
    chromeBg,
  );

  const hints: Array<{ key: string; label: string }> = [
    { key: "tab", label: "next" },
    { key: "shift+tab", label: "prev" },
    { key: "ctrl+s", label: "run" },
    { key: "esc", label: "cancel" },
  ];
  const sep = `${chromeBg}  ${dim}·${RESET}${chromeBg}  `;
  const segments = hints.map(
    ({ key, label }) =>
      `${text}${BOLD}${key}${RESET}${chromeBg} ${muted}${label}${RESET}${chromeBg}`,
  );
  const hintsStyled = segments.join(sep);
  const hintsVisible =
    hints.reduce((sum, h) => sum + h.key.length + 1 + h.label.length, 0) +
    (hints.length - 1) * 5;

  const leftEdgePad = 1;
  const leadGap = 2; // gap between pill and hints, matching graph statusline
  const rightEdgePad = 2;
  const tailFiller = Math.max(
    0,
    width - leftEdgePad - pillW - leadGap - hintsVisible - rightEdgePad,
  );
  const blankAcross = " ".repeat(leadGap + hintsVisible + tailFiller + rightEdgePad);

  return [
    `${chromeBg} ${RESET}${top}${chromeBg}${blankAcross}${RESET}`,
    `${chromeBg} ${RESET}${mid}${chromeBg}${" ".repeat(leadGap)}${hintsStyled}${chromeBg}${" ".repeat(tailFiller + rightEdgePad)}${RESET}`,
    `${chromeBg} ${RESET}${bot}${chromeBg}${blankAcross}${RESET}`,
  ];
}

// ---------------------------------------------------------------------------
// Field card (orchestrator node-card identity: centred title in top border)
// ---------------------------------------------------------------------------

function renderFieldCard(
  field: WorkflowInputEntry,
  raw: string,
  focused: boolean,
  invalid: string | null,
  theme: GraphTheme,
  width: number,
  caret?: number,
): string[] {
  const borderHex = invalid
    ? theme.error
    : focused
      ? theme.accent
      : theme.borderDim;
  const titleHex = borderHex;
  const bc = hexToAnsi(borderHex);
  const inner = Math.max(20, width - 2); // 1 col border on each side
  const usable = inner - 2; // 1 col content padding on each side

  // Centred title: ╭───── prompt ─────╮. Title text is bold, in border color.
  const titleRaw = ` ${field.name} `;
  const titleStart = Math.max(1, Math.floor((inner - titleRaw.length) / 2));
  const leadDashes = "─".repeat(titleStart);
  const tailDashes = "─".repeat(Math.max(0, inner - titleStart - titleRaw.length));
  const top =
    `${bc}╭${leadDashes}` +
    `${BOLD}${hexToAnsi(titleHex)}${titleRaw}${RESET}${bc}` +
    `${tailDashes}╮${RESET}`;
  const bottom = `${bc}╰${"─".repeat(inner)}╯${RESET}`;

  const contentLines = renderFieldContent(field, raw, focused, usable, theme, caret).map(
    (row) => `${bc}│${RESET} ${row}${" ".repeat(Math.max(0, usable - visibleWidth(row)))} ${bc}│${RESET}`,
  );

  // Caption: type · required|optional · description
  const caption = renderCaption(field, invalid, theme);

  return [top, ...contentLines, bottom, caption];
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

function renderFieldContent(
  field: WorkflowInputEntry,
  raw: string,
  focused: boolean,
  usable: number,
  theme: GraphTheme,
  caret?: number,
): string[] {
  if (field.type === "select" && field.choices && field.choices.length > 0) {
    const cells = field.choices.map((c) => {
      const sel = c === raw;
      const dot = sel
        ? paint("●", focused ? theme.accent : theme.success)
        : paint("○", theme.dim);
      const lbl = sel
        ? paint(c, focused ? theme.text : theme.textMuted)
        : paint(c, theme.dim);
      return dot + " " + lbl;
    });
    return [clip(cells.join("   "), usable)];
  }
  if (field.type === "boolean") {
    const on = raw === "true";
    const onCell =
      paint(on ? "●" : "○", on ? theme.accent : theme.dim) +
      " " +
      paint("on", on ? theme.text : theme.dim);
    const offCell =
      paint(!on ? "●" : "○", !on ? theme.accent : theme.dim) +
      " " +
      paint("off", !on ? theme.text : theme.dim);
    return [clip(onCell + "   " + offCell, usable)];
  }
  // string / number / integer — single-line scalar input.
  if (field.type !== "text") {
    if (raw === "") {
      if (focused) return [paint("▋", theme.accent)];
      return [paint(field.placeholder ?? "", theme.dim)];
    }
    if (focused) {
      const c = Math.max(0, Math.min(caret ?? raw.length, raw.length));
      const before = raw.slice(0, c);
      const after = raw.slice(c);
      return [
        clip(
          paint(before, theme.text) + paint("▋", theme.accent) + paint(after, theme.text),
          usable,
        ),
      ];
    }
    return [clip(paint(raw, theme.textMuted), usable)];
  }
  // text — multi-line prompt-box input. Newlines render as actual visual
  // line breaks (no more `⏎` glyph) and long single lines wrap at the
  // field's usable width. The box height grows to fit every visual row
  // so the user sees their whole prompt; the surrounding card already
  // lives in chat scrollback so vertical space is not at a premium.
  if (raw === "") {
    if (focused) return [paint("▋", theme.accent)];
    return [paint(field.placeholder ?? "", theme.dim)];
  }
  const layout = layoutTextField(raw, usable, focused ? caret ?? raw.length : 0);
  if (!focused) {
    return layout.lines.map((line) => paint(line, theme.textMuted));
  }
  return layout.lines.map((line, row) => {
    if (row !== layout.cursorRow) {
      return paint(line, theme.text);
    }
    const before = line.slice(0, layout.cursorCol);
    const after = line.slice(layout.cursorCol);
    return paint(before, theme.text) + paint("▋", theme.accent) + paint(after, theme.text);
  });
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

function renderCancelledLine(state: InlineFormState, theme: GraphTheme): string {
  return (
    paint("✗ cancelled", theme.dim) +
    paint("  ·  ", theme.dim) +
    paint(state.workflowName, theme.textMuted)
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
): { lines: string[]; cursorRow: number; cursorCol: number } {
  const width = Math.max(1, Math.floor(usable));
  const safeCaret = Math.max(0, Math.min(caret, raw.length));
  const visualLines: string[] = [];
  let curLine = "";
  let cursorRow = 0;
  let cursorCol = 0;
  let cursorRecorded = false;
  const recordCursorIfMatched = (offset: number): void => {
    if (offset === safeCaret && !cursorRecorded) {
      cursorRow = visualLines.length;
      cursorCol = curLine.length;
      cursorRecorded = true;
    }
  };
  for (let i = 0; i < raw.length; i++) {
    recordCursorIfMatched(i);
    const ch = raw[i]!;
    if (ch === "\n") {
      visualLines.push(curLine);
      curLine = "";
      continue;
    }
    curLine += ch;
    if (curLine.length >= width) {
      visualLines.push(curLine);
      curLine = "";
    }
  }
  recordCursorIfMatched(raw.length);
  visualLines.push(curLine);
  if (!cursorRecorded) {
    cursorRow = visualLines.length - 1;
    cursorCol = curLine.length;
  }
  return { lines: visualLines, cursorRow, cursorCol };
}
