import { renderRoundedBoxLines } from "./chat-surface.js";
import { BOLD, RESET, hexToAnsi } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

export type WorkflowNoticeTone = "info" | "success" | "warning" | "error" | "mauve";

export interface WorkflowNoticeCardField {
  readonly label: string;
  readonly value: string | undefined;
  readonly tone?: WorkflowNoticeTone | "text" | "muted";
}

export interface WorkflowNoticeCardOpts {
  readonly title: string;
  readonly glyph: string;
  readonly headline: string;
  readonly tone: WorkflowNoticeTone;
  readonly fields?: readonly WorkflowNoticeCardField[];
  readonly hints?: readonly string[];
  readonly footer?: string;
  readonly fallbackText: string;
  readonly width: number;
  readonly theme?: GraphTheme;
}

const MIN_CARD_WIDTH = 32;
const FIELD_LABEL_WIDTH = 9;

export function renderWorkflowNoticeCard(opts: WorkflowNoticeCardOpts): string[] {
  const width = Math.max(1, Math.floor(opts.width));
  if (width < MIN_CARD_WIDTH) return wrapPlainText(opts.fallbackText, width);

  const theme = opts.theme;
  const accent = theme ? toneColor(theme, opts.tone) : undefined;
  const innerWidth = Math.max(2, width - 2);
  const bodyLines: string[] = [];

  appendHeadline(bodyLines, opts, innerWidth);

  for (const field of opts.fields ?? []) {
    if (field.value === undefined || field.value.length === 0) continue;
    appendField(bodyLines, field, innerWidth, theme);
  }

  for (const hint of opts.hints ?? []) {
    if (hint.length === 0) continue;
    appendHint(bodyLines, hint, innerWidth, theme);
  }

  if (opts.footer && opts.footer.length > 0) {
    appendFreeText(bodyLines, opts.footer, innerWidth, theme, "muted");
  }

  return renderRoundedBoxLines({
    title: opts.title,
    bodyLines,
    width,
    ...(theme ? { theme, accent } : {}),
  });
}

function appendHeadline(
  rows: string[],
  opts: WorkflowNoticeCardOpts,
  innerWidth: number,
): void {
  const prefix = `${opts.glyph} `;
  const continuationPrefix = `${" ".repeat(visibleWidth(opts.glyph))} `;
  const budget = Math.max(1, innerWidth - 1 - visibleWidth(prefix));
  const lines = wrapPlainText(opts.headline, budget);
  const theme = opts.theme;
  const tone = theme ? toneColor(theme, opts.tone) : undefined;

  for (let i = 0; i < lines.length; i++) {
    const rawPrefix = i === 0 ? prefix : continuationPrefix;
    const styledPrefix = i === 0
      ? style(rawPrefix, theme, tone, true)
      : " ".repeat(visibleWidth(rawPrefix));
    const line = ` ${styledPrefix}${style(lines[i] ?? "", theme, theme?.text, true)}`;
    rows.push(fit(line, innerWidth));
  }
}

function appendField(
  rows: string[],
  field: WorkflowNoticeCardField,
  innerWidth: number,
  theme: GraphTheme | undefined,
): void {
  const label = truncateToWidth(field.label, FIELD_LABEL_WIDTH, "…").padEnd(FIELD_LABEL_WIDTH, " ");
  const firstPrefixWidth = 1 + FIELD_LABEL_WIDTH + 1;
  const firstBudget = Math.max(1, innerWidth - firstPrefixWidth);
  const value = field.value ?? "";
  const valueTone = field.tone ?? "text";

  if (visibleWidth(value) <= firstBudget && !value.includes("\n")) {
    rows.push(
      fit(
        ` ${style(label, theme, theme?.dim, true)} ${style(value, theme, colorForField(theme, valueTone))}`,
        innerWidth,
      ),
    );
    return;
  }

  rows.push(fit(` ${style(field.label, theme, theme?.dim, true)}`, innerWidth));
  if (visibleWidth(value) <= innerWidth - 1 && !value.includes("\n")) {
    rows.push(fit(` ${style(value, theme, colorForField(theme, valueTone))}`, innerWidth));
    return;
  }
  const continuationPrefix = "   ";
  const continuationBudget = Math.max(1, innerWidth - visibleWidth(continuationPrefix));
  for (const line of wrapPlainText(value, continuationBudget)) {
    rows.push(fit(`${continuationPrefix}${style(line, theme, colorForField(theme, valueTone))}`, innerWidth));
  }
}

function appendHint(
  rows: string[],
  hint: string,
  innerWidth: number,
  theme: GraphTheme | undefined,
): void {
  const prefix = "▸ ";
  const continuationPrefix = "  ";
  const budget = Math.max(1, innerWidth - 1 - visibleWidth(prefix));
  const lines = wrapPlainText(hint, budget);
  for (let i = 0; i < lines.length; i++) {
    const rawPrefix = i === 0 ? prefix : continuationPrefix;
    const styledPrefix = i === 0
      ? style(rawPrefix, theme, theme?.accent, true)
      : " ".repeat(visibleWidth(rawPrefix));
    rows.push(fit(` ${styledPrefix}${style(lines[i] ?? "", theme, theme?.textMuted)}`, innerWidth));
  }
}

function appendFreeText(
  rows: string[],
  text: string,
  innerWidth: number,
  theme: GraphTheme | undefined,
  tone: WorkflowNoticeCardField["tone"],
): void {
  const budget = Math.max(1, innerWidth - 1);
  for (const line of wrapPlainText(text, budget)) {
    rows.push(fit(` ${style(line, theme, colorForField(theme, tone ?? "text"))}`, innerWidth));
  }
}

function colorForField(
  theme: GraphTheme | undefined,
  tone: WorkflowNoticeCardField["tone"],
): string | undefined {
  if (!theme) return undefined;
  if (tone === "text") return theme.text;
  if (tone === "muted") return theme.textMuted;
  return toneColor(theme, tone ?? "info");
}

function toneColor(theme: GraphTheme, tone: WorkflowNoticeTone): string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "mauve":
      return theme.mauve;
    case "info":
    default:
      return theme.info;
  }
}

function style(text: string, theme: GraphTheme | undefined, color: string | undefined, bold = false): string {
  if (!theme || !color || text.length === 0) return text;
  return `${hexToAnsi(color)}${bold ? BOLD : ""}${text}${RESET}`;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, width, "…", true);
}
