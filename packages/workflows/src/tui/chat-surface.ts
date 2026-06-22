/**
 * Static chat-surface primitives — bands, stripe cards, hint rows, and
 * progress strips for the post-dispatch confirmation, `/workflow status`
 * list, and `/workflow list` catalogue.
 *
 * Visual contract (ui/mockups.html · DESIGN.md §5):
 *  - **Flat band**: one full-width line with a `surface0` fill, a bold
 *    label in the accent / status colour, a muted subtitle, and
 *    right-aligned status badges.
 *  - **Tagged card**: a 1-cell coloured stripe (status family) on the
 *    left, a `surface0` tag carrying the runId / workflow name, a
 *    bolded title beside it, and one optional second row indented past
 *    the stripe.
 *  - **Progress strip**: bracketed status cells such as `[✓]`, `[●]`,
 *    `[○]`, `[✗]`, and `[❚❚]`, coloured by stage status. Cells are
 *    measured by visible width per rendered glyph rather than assumed to
 *    be a fixed 3 columns, and the strip truncates with a trailing `…`
 *    when the rendered cells exceed the available budget.
 *  - **Hint rows**: a single grammar — `▸ /slash command  verb-phrase
 *    hint`.
 *
 * Plain mode (theme omitted) drops ANSI and degrades the stripe to a
 * single `│` character so the same shape carries through to logs and
 * tests.
 *
 * cross-ref:
 *  - ui/mockups.html (§1 dispatched, §2 status, §3 list, §4 truncation)
 *  - src/tui/header.ts renderBandHeader (3-row outline pill — kept for the
 *    above-editor widget, distinct surface)
 */

import type { StageStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";
import { visibleWidth, truncateToWidth } from "./text-helpers.js";

/** Unicode end-of-line truncation marker. Mocks use it verbatim. */
export const ELLIPSIS = "…";

/** Default chat-surface width when `process.stdout.columns` is unavailable. */
export const DEFAULT_WIDTH = 80;

/**
 * Cells of horizontal chrome pi's `customMessage` surface wraps around our
 * rendered output. `notify(msg, "info")` (and the equivalent sendMessage
 * path used by `registerMessageRenderer`) construct a `Text` component with
 * `paddingX = 1` on each side, which subtracts two cells from the
 * available content width before pi-tui's word-wrap kicks in. Sizing our
 * bands and cards to `process.stdout.columns` directly produces a line
 * that's two cells too long; pi-tui then wraps the trailing badge onto a
 * second visual row. We pre-shrink the fallback width by the same amount
 * so a band rendered without an explicit width fits the chat surface
 * exactly.
 *
 * Explicit widths passed by callers (tests, narrow-terminal mocks) are
 * honoured verbatim — they're already framed for the surface they target.
 */
const CHAT_HOST_PADDING_X = 2;

const MIN_WIDTH = 32;

/**
 * Resolve the render width for a chat-surface primitive. Callers may pass
 * an explicit width (tests, overlays); otherwise we infer from
 * `process.stdout.columns`, pre-shrunk by the host's wrap margin.
 */
export function chatWidth(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return Math.max(MIN_WIDTH, explicit);
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) {
    return Math.max(MIN_WIDTH, cols - CHAT_HOST_PADDING_X);
  }
  return DEFAULT_WIDTH;
}

// ---------------------------------------------------------------------------
// Flat band — full-width surface0 strip with a label, subtitle, and badges
// ---------------------------------------------------------------------------

export interface FlatBandBadge {
  /** Glyph + count or status word, e.g. `"● running"`, `"✓ 2"`. */
  text: string;
  /** Role hex colour (theme.success / warning / error / dim / accent). */
  fg?: string;
}

export interface RenderRoundedBoxOpts {
  /** Title embedded in the top border. Keep it short; it is truncated to fit. */
  title?: string;
  /** Body lines. ANSI is preserved and each line is width-clamped. */
  bodyLines: readonly string[];
  /** Full box width in visible cells. */
  width?: number;
  /** Optional theme for ANSI border/text chrome. */
  theme?: GraphTheme;
  /** Border/title colour. Defaults to theme.border or plain output. */
  accent?: string;
}

/**
 * Render a width-stable rounded box (`╭╮╰╯`) around arbitrary body lines.
 * This is the shared workflow-tool output container: panels, cards, and
 * compact notices all use the same border vocabulary.
 */
export function renderRoundedBox(opts: RenderRoundedBoxOpts): string {
  const width = chatWidth(opts.width);
  return renderRoundedBoxLines({ ...opts, width }).join("\n");
}

/** Render a rounded box as individual width-stable lines. */
export function renderRoundedBoxLines(opts: RenderRoundedBoxOpts & { width: number }): string[] {
  const width = Math.max(MIN_WIDTH, opts.width);
  const inner = Math.max(2, width - 2);
  const theme = opts.theme;
  const border = theme ? hexToAnsi(opts.accent ?? theme.border) : "";
  const reset = theme ? RESET : "";

  const titleBudget = Math.max(0, inner - 2);
  const titleText = opts.title && opts.title.length > 0
    ? ` ${truncateToWidth(opts.title, titleBudget, ELLIPSIS)} `
    : "";
  const topFill = Math.max(0, inner - visibleWidth(titleText));
  // `titleText` may contain its own ANSI runs (for status-coloured badges).
  // Re-prime the border colour after it so RESETs inside the title do not
  // leave the trailing rule/corner on the terminal default colour.
  const top = `${border}╭${titleText}${border}${"─".repeat(topFill)}╮${reset}`;

  const body = opts.bodyLines.length > 0 ? opts.bodyLines : [""];
  const rows = body.map((line) => {
    const clipped = truncateToWidth(line, inner, ELLIPSIS, theme !== undefined);
    const pad = Math.max(0, inner - visibleWidth(clipped));
    return `${border}│${reset}${clipped}${" ".repeat(pad)}${border}│${reset}`;
  });

  const bottom = `${border}╰${"─".repeat(inner)}╯${reset}`;
  return [top, ...rows, bottom];
}

export interface RenderFlatBandOpts {
  /** Pill label, e.g. `"BACKGROUND"`, `"DISPATCHED"`, `"WORKFLOWS"`. */
  label: string;
  /** Subtitle in `textMuted` after the label. May be empty. */
  subtitle?: string;
  /** Right-aligned status badges. Empty array renders no right column. */
  badges?: readonly FlatBandBadge[];
  /** Override label colour. Defaults to `theme.accent`. */
  accent?: string;
  /** Render width (cells). Defaults to `process.stdout.columns`. */
  width?: number;
  /** Provide for themed Catppuccin chrome; omit for plain ASCII. */
  theme?: GraphTheme;
}

/**
 * Render one full-width band. Themed mode paints the line with the
 * `surface0` background and styles the label, subtitle, and badges with
 * ANSI colours. Plain mode emits an indented `LABEL  subtitle    badge`
 * shape so the layout carries through to logs.
 */
export function renderFlatBand(opts: RenderFlatBandOpts): string {
  const width = chatWidth(opts.width);
  const subtitle = opts.subtitle ?? "";
  const badges = opts.badges ?? [];

  // Pre-truncate the subtitle so the band never wraps. The badges and
  // label are sized first because they carry semantic weight; the
  // subtitle is the relegated text.
  const labelText = `[ ${opts.label} ]`;
  const badgeText = badges.map((b) => b.text).join("  ");
  const padding = 2; // 1ch left + 1ch right
  const fixed = visibleWidth(labelText) + (badgeText.length > 0 ? visibleWidth(badgeText) + 2 : 0) + padding;
  const subtitleBudget = Math.max(0, width - fixed - 4);
  const truncatedSubtitle = truncateToWidth(subtitle, subtitleBudget, ELLIPSIS);

  if (opts.theme === undefined) {
    return renderFlatBandPlain(opts.label, truncatedSubtitle, badges, width);
  }
  return renderFlatBandThemed(
    opts.label,
    truncatedSubtitle,
    badges,
    opts.accent ?? opts.theme.accent,
    opts.theme,
    width,
  );
}

function renderFlatBandThemed(
  label: string,
  subtitle: string,
  badges: readonly FlatBandBadge[],
  accentHex: string,
  theme: GraphTheme,
  width: number,
): string {
  const accent = hexToAnsi(accentHex);
  const muted = hexToAnsi(theme.textMuted);
  const fillBg = hexBg(theme.backgroundPanel);

  const labelText = `[ ${label} ]`;
  const labelW = visibleWidth(labelText);
  const subtitleW = subtitle.length > 0 ? visibleWidth(subtitle) + 2 : 0;
  const badgeW = badges.length > 0
    ? badges.reduce((a, b) => a + visibleWidth(b.text), 0) + (badges.length - 1) * 2
    : 0;

  const leftPad = 1;
  const rightPad = 1;
  const filler = Math.max(
    1,
    width - leftPad - labelW - subtitleW - badgeW - rightPad,
  );

  const subtitleStyled = subtitle.length > 0 ? `  ${muted}${subtitle}${RESET}${fillBg}` : "";
  const badgeStyled = badges
    .map((b) => `${b.fg ? hexToAnsi(b.fg) : muted}${b.text}${RESET}${fillBg}`)
    .join(`${fillBg}  `);
  const badgeSeg = badges.length > 0 ? `${badgeStyled}` : "";

  return (
    `${fillBg}` +
    " " +
    `${accent}${BOLD}${labelText}${RESET}${fillBg}` +
    subtitleStyled +
    " ".repeat(filler) +
    badgeSeg +
    " " +
    RESET
  );
}

function renderFlatBandPlain(
  label: string,
  subtitle: string,
  badges: readonly FlatBandBadge[],
  width: number,
): string {
  const labelText = `[ ${label} ]`;
  const labelW = visibleWidth(labelText);
  const subtitleSeg = subtitle.length > 0 ? `  ${subtitle}` : "";
  const badgeSeg = badges.map((b) => b.text).join("  ");
  // Plain-mode band sits 1 cell from the chat content edge, matching the
  // themed band's leftPad and the card/hint left edges. Single-column
  // alignment for the band, card, and hint arrow.
  const leftMarker = "   ";
  const leftW = visibleWidth(leftMarker);
  const subtitleW = visibleWidth(subtitleSeg);
  const badgeW = visibleWidth(badgeSeg);

  const filler = Math.max(2, width - leftW - labelW - subtitleW - badgeW - 1);
  const right = badges.length > 0 ? `${" ".repeat(filler)}${badgeSeg}` : "";

  return `${leftMarker}${labelText}${subtitleSeg}${right}`;
}

// ---------------------------------------------------------------------------
// Tagged card — coloured stripe + surface0 tag + body rows
// ---------------------------------------------------------------------------

export interface RenderTaggedCardOpts {
  /** Text rendered inside the surface0 tag, e.g. a short runId or wf name. */
  tag: string;
  /** Optional muted suffix right after the tag (e.g. `"run id"`). */
  tagSubtitle?: string;
  /** Title rendered bold beside the tag on row 1. Long values are end-truncated. */
  title?: string;
  /**
   * Optional pre-styled inline content rendered after the title on row 1,
   * separated from the title by a 2-cell gap. The caller is responsible
   * for ANSI styling inside the string; `titleSuffixWidth` MUST report the
   * visible width (excluding ANSI escapes) so the renderer can budget the
   * title's truncation and the trailing gap correctly. Caller is also
   * responsible for fitting the suffix to the available row-1 budget —
   * the renderer never truncates a pre-styled string.
   */
  titleSuffix?: string;
  /** Visible width of `titleSuffix`, in cells. Ignored when suffix is absent. */
  titleSuffixWidth?: number;
  /** Right-aligned badge on row 1 (state badge). */
  trailing?: { text: string; fg?: string };
  /**
   * Pre-rendered body rows. Each entry already includes its own indentation
   * past the stripe column. Callers are responsible for ANSI styling inside
   * each entry, but the renderer prepends the stripe glyph and a single
   * cell of breathing room.
   */
  bodyRows?: readonly string[];
  /** Stripe + tag accent colour (status family or catalogue mauve). */
  accent: string;
  /** Render width. Defaults to `process.stdout.columns`. */
  width?: number;
  /** Provide for themed chrome; omit for plain ASCII. */
  theme?: GraphTheme;
}

const STRIPE_CHAR_THEMED = " ";
const STRIPE_CHAR_PLAIN = "│";

/**
 * Render a single status / catalogue card. Always emits the row-1
 * header (tag + title + trailing badge); body rows are emitted in
 * order, each prepended with the stripe glyph and an indent.
 *
 * Returns one styled string with embedded `\n` separators.
 */
export function renderTaggedCard(opts: RenderTaggedCardOpts): string {
  const width = chatWidth(opts.width);
  if (opts.theme === undefined) return renderTaggedCardPlain(opts, width);
  return renderTaggedCardThemed(opts, opts.theme, width);
}

function renderTaggedCardThemed(
  opts: RenderTaggedCardOpts,
  theme: GraphTheme,
  width: number,
): string {
  const stripe = hexToAnsi(opts.accent);
  const muted = hexToAnsi(theme.textMuted);
  const tagBg = hexBg(theme.backgroundPanel);
  const tagFg = hexToAnsi(opts.accent);
  const text = hexToAnsi(theme.text);

  // Row 1:   [tag]  title …            ● running
  const tagSeg = `${tagBg}${tagFg}${BOLD} ${opts.tag} ${RESET}`;
  const tagW = opts.tag.length + 2;
  const tagSubtitleSeg = opts.tagSubtitle
    ? `  ${muted}${opts.tagSubtitle}${RESET}`
    : "";
  const tagSubtitleW = opts.tagSubtitle ? visibleWidth(opts.tagSubtitle) + 2 : 0;

  const trailingText = opts.trailing?.text ?? "";
  const trailingW = trailingText.length > 0 ? visibleWidth(trailingText) : 0;
  const trailingSeg = opts.trailing
    ? `${opts.trailing.fg ? hexToAnsi(opts.trailing.fg) : muted}${opts.trailing.text}${RESET}`
    : "";

  // Row 1 sits one cell tighter against the stripe than the body rows
  // (`  [tag] title …`) so that the tag pill's interior text starts at
  // exactly the same column as every body row's leading character —
  // `  ` (2 cells) + bg-pill leading pad (1 cell) lands tag text at col 4,
  // and `   ` (3 cells) + body content also lands at col 4. The +1
  // hanging indent on the body is what the mockup's §1 / §2 cards show
  // (ui/mockups.html · `  [tag] title` over `   body`).
  const row1StripePrefixW = 2; // "  "
  const bodyStripePrefixW = 3; // "   "
  const trailingPad = 2;
  const titleSuffixW = opts.titleSuffix ? Math.max(0, opts.titleSuffixWidth ?? 0) : 0;
  const titleSuffixGap = opts.titleSuffix ? 2 : 0;
  const titleBudget = Math.max(
    8,
    width - row1StripePrefixW - tagW - tagSubtitleW - titleSuffixGap - titleSuffixW - trailingW - trailingPad - 2,
  );

  const titleVisible = truncateToWidth(opts.title ?? "", titleBudget, ELLIPSIS);
  const titleW = visibleWidth(titleVisible);
  const titleSeg = titleVisible
    ? `  ${text}${BOLD}${titleVisible}${RESET}`
    : "";
  const titleSegW = titleVisible ? titleW + 2 : 0;

  // `titleSuffix` rides row 1 after the bold title. Caller pre-styles
  // and pre-sizes the segment — the renderer simply prepends a 2-cell
  // gap. Used by `renderDispatchConfirm` to inline a `k=v · k=v` input
  // summary when it fits beside the workflow name.
  const suffixSeg = opts.titleSuffix ? `  ${opts.titleSuffix}` : "";
  const suffixSegW = opts.titleSuffix ? titleSuffixGap + titleSuffixW : 0;

  const gap = Math.max(
    1,
    width - row1StripePrefixW - tagW - titleSegW - suffixSegW - tagSubtitleW - trailingW - 1,
  );
  const row1 =
    ` ${stripe}${STRIPE_CHAR_THEMED}${RESET} ` +
    tagSeg +
    titleSeg +
    suffixSeg +
    tagSubtitleSeg +
    (opts.trailing ? " ".repeat(gap) + trailingSeg : "");
  const bodyPrefix = ` ${stripe}${STRIPE_CHAR_THEMED}${RESET}${" ".repeat(bodyStripePrefixW - 1)}`;
  const rows: string[] = [row1];
  for (const body of opts.bodyRows ?? []) {
    rows.push(`${bodyPrefix}${body}`);
  }
  return rows.join("\n");
}
function renderTaggedCardPlain(opts: RenderTaggedCardOpts, width: number): string {
  const row1StripePrefixW = 2; // "│ "
  const bodyStripePrefixW = 3; // "│  "
  const tagSeg = `[${opts.tag}]`;
  const tagW = visibleWidth(tagSeg);
  const tagSubtitleSeg = opts.tagSubtitle ? `  ${opts.tagSubtitle}` : "";
  const tagSubtitleW = visibleWidth(tagSubtitleSeg);
  const trailing = opts.trailing?.text ?? "";
  const trailingW = visibleWidth(trailing);
  const trailingPad = 2;
  const titleSuffixW = opts.titleSuffix ? Math.max(0, opts.titleSuffixWidth ?? 0) : 0;
  const titleSuffixGap = opts.titleSuffix ? 2 : 0;
  const titleBudget = Math.max(
    8,
    width - row1StripePrefixW - tagW - tagSubtitleW - titleSuffixGap - titleSuffixW - trailingW - trailingPad - 2,
  );
  const titleVisible = truncateToWidth(opts.title ?? "", titleBudget, ELLIPSIS);
  const titleSeg = titleVisible ? `  ${titleVisible}` : "";
  const titleW = visibleWidth(titleSeg);
  const suffixSeg = opts.titleSuffix ? `  ${opts.titleSuffix}` : "";
  const suffixSegW = opts.titleSuffix ? titleSuffixGap + titleSuffixW : 0;
  const gap = Math.max(
    1,
    width - row1StripePrefixW - tagW - titleW - suffixSegW - tagSubtitleW - trailingW - 1,
  );
  const row1Trailing = opts.trailing ? `${" ".repeat(gap)}${trailing}` : "";
  const row1 = ` ${STRIPE_CHAR_PLAIN} ${tagSeg}${titleSeg}${suffixSeg}${tagSubtitleSeg}${row1Trailing}`;
  const bodyPrefix = ` ${STRIPE_CHAR_PLAIN}${" ".repeat(bodyStripePrefixW - 1)}`;
  const rows: string[] = [row1];
  for (const body of opts.bodyRows ?? []) {
    rows.push(`${bodyPrefix}${body}`);
  }
  return rows.join("\n");
}
export interface ProgressCell {
  status: StageStatus;
}
export function progressStrip(
  cells: readonly ProgressCell[],
  budget: number,
  theme?: GraphTheme,
): string {
  const usable = Math.max(0, Math.floor(budget));
  if (usable < 3 || cells.length === 0) return "";
  const ellipsisWidth = visibleWidth(ELLIPSIS);
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < cells.length; i++) {
    const rendered = theme ? renderCellThemed(cells[i]!.status, theme) : renderCellPlain(cells[i]!.status);
    const renderedWidth = visibleWidth(rendered);
    const isLast = i === cells.length - 1;
    const reserved = isLast ? 0 : ellipsisWidth;
    if (used + renderedWidth + reserved > usable) break;
    out.push(rendered);
    used += renderedWidth;
    if (isLast) return out.join("");
  }
  if (out.length === 0 && ellipsisWidth > usable) return "";
  const suffix = theme ? `${hexToAnsi(theme.dim)}${ELLIPSIS}${RESET}` : ELLIPSIS;
  return `${out.join("")}${suffix}`;
}
function renderCellThemed(status: StageStatus, theme: GraphTheme): string {
  const dim = hexToAnsi(theme.dim);
  const glyph = stageGlyph(status);
  const fg = stageColor(status, theme);
  return `${dim}[${RESET}${fg}${glyph}${RESET}${dim}]${RESET}`;
}
function renderCellPlain(status: StageStatus): string {
  return `[${stageGlyph(status)}]`;
}
function stageGlyph(status: StageStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "running":   return "●";
    case "paused":    return "❚❚";
    case "failed":    return "✗";
    case "awaiting_input": return "？";
    case "skipped":   return "⊘";
    case "pending":
    default:          return "○";
  }
}
function stageColor(status: StageStatus, theme: GraphTheme): string {
  switch (status) {
    case "completed": return hexToAnsi(theme.success);
    case "running":   return hexToAnsi(theme.warning);
    case "paused":    return hexToAnsi(theme.warning);
    case "failed":    return hexToAnsi(theme.error);
    case "awaiting_input": return hexToAnsi(theme.info);
    case "skipped":   return hexToAnsi(theme.dim);
    case "pending":
    default:          return hexToAnsi(theme.dim);
  }
}
export interface HintRow {
  command: string;
  hint: string;
}
export function renderHintRows(rows: readonly HintRow[], theme?: GraphTheme): string {
  if (rows.length === 0) return "";
  const indent = " ";
  if (!theme) {
    return rows
      .map((r) => `${indent}▸ ${r.command}  ${r.hint}`)
      .join("\n");
  }
  const dim = hexToAnsi(theme.dim);
  const accent = hexToAnsi(theme.accent);
  return rows
    .map(
      (r) =>
        `${indent}${dim}▸${RESET} ${accent}${r.command}${RESET}  ${dim}${r.hint}${RESET}`,
    )
    .join("\n");
}
