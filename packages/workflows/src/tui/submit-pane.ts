import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import { BOLD, hexBg, hexToAnsi, paint, RESET } from "./color-utils.js";
import {
  formatReviewValue,
  renderWrappedPrefixedLines,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "./text-helpers.js";

export interface SubmitPaneRenderOpts {
  workflowName: string;
  fields: readonly WorkflowInputEntry[];
  rawText: Record<string, string>;
  theme: GraphTheme;
  width: number;
}

export interface SubmitControlsRenderOpts {
  invalidFieldNames: readonly string[];
  submitFocused: boolean;
  theme: GraphTheme;
  width: number;
}

export function renderWorkflowFormFooterHints(theme: GraphTheme, width: number): string {
  const hints = [
    "Enter to select · ↑/↓ to navigate · Tab through questions to Submit · Esc to cancel",
    "Enter · ↑/↓ · Tab to Submit · Esc",
    "Enter · Tab · Esc",
    "Esc",
  ];
  const selected = hints.find((hint) => visibleWidth(hint) <= width) ?? hints[hints.length - 1]!;
  return paint(truncateToWidth(selected, width, "…"), theme.dim);
}

export function renderAskChoiceRows(
  index: number,
  label: string,
  active: boolean,
  theme: GraphTheme,
  width: number,
): string[] {
  const plainPrefix = `${active ? "❯ " : "  "}${index}. `;
  const firstPrefix = `${active ? paint("❯ ", theme.accent) : "  "}${index}. `;
  return renderWrappedPrefixedLines({
    text: label,
    width,
    plainPrefix,
    firstPrefix,
    styleLine: (line) => active
      ? paint(line, theme.accent, { bold: true })
      : paint(line, theme.textMuted),
  });
}

export function renderSubmitReview(opts: SubmitPaneRenderOpts): string[] {
  const { workflowName, fields, rawText, theme, width } = opts;
  const out: string[] = [paint("Review your inputs", theme.accent, { bold: true }), ""];
  out.push(truncateToWidth(paint("/workflow ", theme.dim) + paint(workflowName, theme.text), width, "…", true));
  for (const field of fields) {
    out.push(truncateToWidth(paint(" ● ", theme.dim) + paint(field.name, theme.textMuted), width, "…", true));
    out.push(...renderReviewValueRows(field, rawText[field.name] ?? "", theme, width));
  }
  return out;
}

export function renderSubmitControls(opts: SubmitControlsRenderOpts): string[] {
  const { invalidFieldNames, submitFocused, theme, width } = opts;
  const invalidCount = invalidFieldNames.length;
  const submitLabel = "SUBMIT";
  const lines: string[] = [];
  if (invalidCount > 0) {
    lines.push(
      ...wrapPlainText(
        `Answer remaining inputs before submitting: ${invalidFieldNames.join(", ")}`,
        width,
      ).map((line) => paint(line, theme.warning)),
      "",
    );
  }
  lines.push(...renderSubmitToolbar(submitLabel, submitFocused, theme, width));
  return lines;
}

function renderSubmitToolbar(
  label: string,
  focused: boolean,
  theme: GraphTheme,
  width: number,
): string[] {
  const chromeBg = hexBg(theme.backgroundPanel);
  const button = renderCompactSubmitButton(label, focused, theme, chromeBg);
  const textFg = hexToAnsi(theme.text);
  const mutedFg = hexToAnsi(theme.textMuted);
  const dimFg = hexToAnsi(theme.dim);
  const hint = (key: string, description: string): string =>
    `${chromeBg}${textFg}${BOLD}${key}${RESET}${chromeBg}${mutedFg} ${description}${RESET}${chromeBg}`;
  const hints = [
    hint("enter", "Submit"),
    hint("tab", "Next"),
    hint("shift+tab", "Prev"),
    hint("esc", "Cancel"),
  ].join(`${chromeBg}${dimFg}  ·  ${RESET}${chromeBg}`);
  const leftPad = 1;
  const gap = 2;
  const rightPad = 1;
  const hintBudget = Math.max(0, width - leftPad - button.visibleWidth - gap - rightPad);
  const fittedHints = truncateToWidth(hints, hintBudget, "…", true);
  const hintWidth = visibleWidth(fittedHints);
  const filler = Math.max(0, width - leftPad - button.visibleWidth - gap - hintWidth - rightPad);
  const line = `${chromeBg} ${button.text}${chromeBg}${" ".repeat(gap)}${fittedHints}${chromeBg}${" ".repeat(filler)} ${RESET}`;
  const clipped = truncateToWidth(line, width, "", true);
  return [`${clipped}${chromeBg}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${RESET}`];
}

function renderCompactSubmitButton(
  label: string,
  focused: boolean,
  theme: GraphTheme,
  chromeBg: string,
): { text: string; visibleWidth: number } {
  const plain = ` ${label} `;
  if (focused) {
    const accentBg = hexBg(theme.accent);
    const fg = hexToAnsi(theme.backgroundPanel);
    return {
      text: `${accentBg}${fg}${BOLD}${plain}${RESET}${chromeBg}`,
      visibleWidth: visibleWidth(plain),
    };
  }
  const labelFg = hexToAnsi(theme.accent);
  return {
    text: `${chromeBg}${labelFg}${BOLD}${plain}${RESET}${chromeBg}`,
    visibleWidth: visibleWidth(plain),
  };
}

function renderReviewValueRows(
  field: WorkflowInputEntry,
  raw: string,
  theme: GraphTheme,
  width: number,
): string[] {
  const plainPrefix = "   → ";
  const firstPrefix = "   " + paint("→ ", theme.dim);
  return renderWrappedPrefixedLines({
    text: formatFieldReviewValue(field, raw),
    width,
    plainPrefix,
    firstPrefix,
    styleLine: (line) => paint(line, theme.text),
  });
}

function formatFieldReviewValue(field: WorkflowInputEntry, raw: string): string {
  if (field.type === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) return formatReviewValue(raw);
    return normalized === "true" || normalized === "1" ? "on" : "off";
  }
  return formatReviewValue(raw);
}
