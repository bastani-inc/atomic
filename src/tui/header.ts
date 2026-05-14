/**
 * Outline-pill band header — 3 rows of chrome with an outlined accent
 * pill on the left, a muted subtitle, and right-aligned status badges.
 *
 * Visual contract (target screenshot · DESIGN.md §5 Mode Pills):
 *  - 3 rows tall, `backgroundPanel` (mantle) chrome — quieter than
 *    surface0 so the pill outline reads as the focal element.
 *  - The mode pill is *outlined*, not filled: rounded border in
 *    `accent`, label in `accent` bold, interior matches the chrome.
 *    Pill height = 3 rows so the chrome band and the pill share the
 *    same vertical span.
 *  - Subtitle sits beside the pill in `textMuted`.
 *  - Counts on the right: `✓ <n>`, `● <n>`, `○ <n>`, `✗ <n>` in their
 *    status colours, separated by `2ch` of chrome.
 *
 * Two entry points share the same chrome:
 *   - {@link renderHeader}      run-specific (carries `RunSnapshot`)
 *   - {@link renderBandHeader}  generic (label + subtitle + badges)
 *
 * Returns exactly 3 styled lines, each `width` cells wide.
 */
import type { RunSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";

export interface HeaderOpts {
  width: number;
  theme: GraphTheme;
}

export interface BandBadge {
  /** Visible glyph + count, e.g. `"✓ 2"`. */
  text: string;
  /** Hex foreground colour (status-mapped). */
  fg: string;
}

export interface BandHeaderOpts {
  /** Pill label, e.g. `"ORCHESTRATOR"`, `"BACKGROUND"`, `"RUN abc123"`. */
  label: string;
  /** Subtitle in `textMuted` beside the pill. May be empty. */
  subtitle?: string;
  /** Right-aligned status badges. Empty array renders no right column. */
  badges?: BandBadge[];
  /** Border + label colour for the pill (defaults to `theme.accent`). */
  accent?: string;
  width: number;
  theme: GraphTheme;
}

interface PillStyle {
  border: string;
  label: string;
}

function pillFor(run: RunSnapshot, theme: GraphTheme): PillStyle {
  if (run.status === "failed") return { border: theme.error, label: "ORCHESTRATOR" };
  if (run.status === "completed") return { border: theme.success, label: "ORCHESTRATOR" };
  if (run.status === "killed") return { border: theme.dim, label: "ORCHESTRATOR" };
  return { border: theme.accent, label: "ORCHESTRATOR" };
}

/**
 * Render a 3-row outlined pill. The interior (centre row) shows
 * `label` in bold, in the pill's border colour. Returned as three
 * parallel slices ready for chrome composition.
 */
export function renderOutlinePill(
  label: string,
  borderHex: string,
  chromeBg: string,
): { top: string; mid: string; bot: string; visibleWidth: number } {
  const bc = hexToAnsi(borderHex);
  const padded = ` ${label} `;
  const inner = "─".repeat(padded.length);
  const top = `${chromeBg}${bc}╭${inner}╮${RESET}`;
  const mid = `${chromeBg}${bc}│${BOLD}${padded}${RESET}${chromeBg}${bc}│${RESET}`;
  const bot = `${chromeBg}${bc}╰${inner}╯${RESET}`;
  return { top, mid, bot, visibleWidth: padded.length + 2 };
}

/**
 * Generic 3-row band header. Used by the background widget, the
 * status-list text output, and the per-run detail block.
 *
 * Always returns exactly 3 lines. When `badges` is empty the right
 * column is whitespace only.
 */
export function renderBandHeader(opts: BandHeaderOpts): string[] {
  const { label, subtitle = "", badges = [], width, theme } = opts;
  const accentHex = opts.accent ?? theme.accent;
  const chromeHex = theme.backgroundPanel;
  const chromeBg = hexBg(chromeHex);
  const muted = hexToAnsi(theme.textMuted);

  const { top: pillTop, mid: pillMid, bot: pillBot, visibleWidth: pillW } =
    renderOutlinePill(label, accentHex, chromeBg);

  // Subtitle slot — quieter than the pill. Two-space gutter on each
  // side keeps the pill from kissing the subtitle.
  const subtitleVisible = subtitle.length > 0 ? `  ${subtitle}` : "";
  const subtitleStyled =
    subtitle.length > 0
      ? `${chromeBg}  ${muted}${subtitle}${RESET}${chromeBg}`
      : `${chromeBg}`;

  // Right-side count badges. Status colour per badge, 2ch gap between.
  const rightVisible = badges.map((b) => b.text).join("  ");
  const rightStyled = badges
    .map((b) => `${hexToAnsi(b.fg)}${b.text}${RESET}${chromeBg}`)
    .join(`${chromeBg}  `);

  const leftEdgePad = 1;
  const rightEdgePad = 2;
  const fillerTop = Math.max(
    0,
    width - leftEdgePad - pillW - subtitleVisible.length - rightEdgePad,
  );
  const fillerMid = Math.max(
    0,
    width -
      leftEdgePad -
      pillW -
      subtitleVisible.length -
      rightVisible.length -
      rightEdgePad,
  );

  const subtitleBlank = " ".repeat(subtitleVisible.length);
  const top = `${chromeBg} ${RESET}${pillTop}${chromeBg}${subtitleBlank}${" ".repeat(fillerTop)}${" ".repeat(rightEdgePad)}${RESET}`;
  const mid = `${chromeBg} ${RESET}${pillMid}${subtitleStyled}${" ".repeat(fillerMid)}${rightStyled}${chromeBg}${" ".repeat(rightEdgePad)}${RESET}`;
  const bot = `${chromeBg} ${RESET}${pillBot}${chromeBg}${subtitleBlank}${" ".repeat(fillerTop)}${" ".repeat(rightEdgePad)}${RESET}`;

  return [top, mid, bot];
}

/**
 * Run-specific header — derives label, subtitle, and status badges
 * from a `RunSnapshot`. Thin wrapper around {@link renderBandHeader}.
 */
export function renderHeader(run: RunSnapshot, opts: HeaderOpts): string[] {
  const { width, theme } = opts;
  const pill = pillFor(run, theme);

  const counts = {
    pending: 0,
    running: 0,
    awaiting_input: 0,
    paused: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
  };
  for (const s of run.stages) counts[s.status]++;

  const badges: BandBadge[] = [];
  if (counts.completed > 0) badges.push({ text: `✓ ${counts.completed}`, fg: theme.success });
  if (counts.running > 0) badges.push({ text: `● ${counts.running}`, fg: theme.warning });
  if (counts.awaiting_input > 0) badges.push({ text: `↵ ${counts.awaiting_input}`, fg: theme.info });
  if (counts.paused > 0) badges.push({ text: `⏸ ${counts.paused}`, fg: theme.accent });
  if (counts.pending > 0) badges.push({ text: `○ ${counts.pending}`, fg: theme.dim });
  if (counts.failed > 0) badges.push({ text: `✗ ${counts.failed}`, fg: theme.error });

  return renderBandHeader({
    label: pill.label,
    subtitle: run.name,
    badges,
    accent: pill.border,
    width,
    theme,
  });
}
