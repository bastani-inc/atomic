/**
 * Stage switcher — "/" popup that lists stages for direct keyboard jump.
 *
 * Visual contract (DESIGN.md §5 Picker Rows):
 *  - Rounded box, `borderActive` border, `backgroundPanel` interior.
 *  - Header row: leading "stages" caption (dim) + right-aligned key·label
 *    hint (`↑↓ select · ↵ attach · Esc close`) in dim.
 *  - Default row: `paddingLeft: 1`, `paddingRight: 2`, icon + name, status
 *    glyph coloured.
 *  - Selected row: accent pill (blue bg + surface0 fg + bold) with leading
 *    `▸ ` chevron.
 *  - Empty state: `(no matches)` in dim.
 */
import type { StageSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { statusIcon, statusColor } from "./status-helpers.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";

export interface SwitcherState {
  query: string;
  selectedIndex: number;
}

export interface SwitcherOpts {
  width: number;
  theme: GraphTheme;
}

export function filterStages(
  stages: readonly StageSnapshot[],
  query: string,
): StageSnapshot[] {
  if (!query) return [...stages];
  const q = query.toLowerCase();
  return stages.filter((s) => s.name.toLowerCase().includes(q));
}

const HINT = "↑↓ select · ↵ attach · Esc close";

/** Pad a visible string (no ANSI) to exactly `width` cells. */
function padVisible(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

export function renderSwitcher(
  stages: readonly StageSnapshot[],
  state: SwitcherState,
  opts: SwitcherOpts,
): string[] {
  const { width, theme } = opts;
  const filtered = filterStages(stages, state.query);
  const innerWidth = Math.max(4, width - 2);

  const border = hexToAnsi(theme.borderActive);
  const panelBg = hexBg(theme.backgroundPanel);
  const dim = hexToAnsi(theme.dim);
  const muted = hexToAnsi(theme.textMuted);
  const accent = hexBg(theme.accent);
  const accentFg = hexToAnsi(theme.backgroundElement);

  const lines: string[] = [];

  // Top border
  lines.push(`${border}╭${"─".repeat(innerWidth)}╮${RESET}`);

  // Header row: " stages   …   ↑↓ select · ↵ attach · Esc close "
  const leftLabel = "stages";
  const queryDisplay = state.query ? `  ${state.query}` : "";
  const leftSegment = `${leftLabel}${queryDisplay}`;
  const gap = Math.max(1, innerWidth - 2 - leftSegment.length - HINT.length);
  const header =
    `${panelBg}${dim} ${leftLabel}${RESET}${panelBg}` +
    (queryDisplay ? `${hexToAnsi(theme.text)}${queryDisplay}${RESET}${panelBg}` : "") +
    " ".repeat(gap) +
    `${dim}${HINT}${RESET}${panelBg} `;
  lines.push(`${border}│${RESET}${header}${border}│${RESET}`);

  // Quiet rule under header
  lines.push(`${border}├${"─".repeat(innerWidth)}┤${RESET}`);

  // Stage list — viewport of 8 around selection
  const maxVisible = 8;
  const start = Math.max(0, state.selectedIndex - Math.floor(maxVisible / 2));
  const visible = filtered.slice(start, start + maxVisible);

  if (visible.length === 0) {
    const empty = ` ${dim}(no matches)${RESET}${panelBg}`;
    lines.push(`${border}│${RESET}${panelBg}${padVisible(empty, innerWidth)}${RESET}`);
  }

  for (let i = 0; i < visible.length; i++) {
    const stage = visible[i]!;
    const idx = start + i;
    const isSelected = idx === state.selectedIndex;
    const icon = statusIcon(stage.status);

    if (isSelected) {
      const visibleRow = ` ${icon} ${stage.name}`;
      const padded = padVisible(visibleRow, innerWidth);
      const styled = `${accent}${accentFg}${BOLD}${padded}${RESET}`;
      lines.push(`${border}│${RESET}${styled}${border}│${RESET}`);
    } else {
      const iconColor = hexToAnsi(statusColor(stage.status, theme));
      const indent = "   ";
      const visibleName = stage.name;
      const visibleRow = `${indent}${icon} ${visibleName}`;
      // Compose styled row that pads to innerWidth using visible length.
      const styled =
        `${panelBg} ${RESET}${panelBg}${iconColor}${icon}${RESET}${panelBg} ${muted}${visibleName}${RESET}${panelBg}` +
        " ".repeat(Math.max(0, innerWidth - visibleRow.length - 1));
      lines.push(`${border}│${RESET}${styled}${border}│${RESET}`);
    }
  }

  // Bottom border
  lines.push(`${border}╰${"─".repeat(innerWidth)}╯${RESET}`);

  return lines;
}
