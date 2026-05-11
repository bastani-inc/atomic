/**
 * "/" popup list of all stages for direct keyboard jump.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/compact-switcher.tsx
 */
import type { StageSnapshot } from "../store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { statusIcon } from "./status-helpers.js";

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

function hexToAnsi(hex: string): string {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function hexBg(hex: string): string {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * Render the switcher popup.
 * Returns lines (border + filtered list).
 */
export function renderSwitcher(
  stages: readonly StageSnapshot[],
  state: SwitcherState,
  opts: SwitcherOpts,
): string[] {
  const { width, theme } = opts;
  const filtered = filterStages(stages, state.query);
  const fg = hexToAnsi(theme.switcherFg);
  const bg = hexBg(theme.switcherBg);
  const innerWidth = width - 2;
  const lines: string[] = [];

  // Title + query line
  const queryDisplay = `/ ${state.query}█`;
  const title = "Jump to stage";
  const titleLine = `${bg}${fg}${BOLD}┌─ ${title} ${"─".repeat(Math.max(0, innerWidth - title.length - 4))}┐${RESET}`;
  lines.push(titleLine);

  const queryLine = `${bg}${fg}│ ${queryDisplay.padEnd(innerWidth - 1)}│${RESET}`;
  lines.push(queryLine);

  const divider = `${bg}${fg}├${"─".repeat(innerWidth)}┤${RESET}`;
  lines.push(divider);

  // Stage list
  const maxVisible = 8;
  const start = Math.max(0, state.selectedIndex - Math.floor(maxVisible / 2));
  const visible = filtered.slice(start, start + maxVisible);

  for (let i = 0; i < visible.length; i++) {
    const stage = visible[i]!;
    const idx = start + i;
    const isSelected = idx === state.selectedIndex;
    const icon = statusIcon(stage.status);
    const label = `${icon} ${stage.name}`;
    const truncated = label.length > innerWidth - 2 ? label.slice(0, innerWidth - 3) + "…" : label;
    if (isSelected) {
      const selectedBg = hexBg(theme.focusColor ?? "#5c6bc0");
      const row = `${selectedBg}${fg}│ ${truncated.padEnd(innerWidth - 2)} │${RESET}`;
      lines.push(row);
    } else {
      const row = `${bg}${fg}│ ${truncated.padEnd(innerWidth - 2)} │${RESET}`;
      lines.push(row);
    }
  }

  if (visible.length === 0) {
    const emptyLine = `${bg}${fg}│ ${"(no matches)".padEnd(innerWidth - 2)} │${RESET}`;
    lines.push(emptyLine);
  }

  // Footer
  const footer = `${bg}${fg}└${"─".repeat(innerWidth)}┘${RESET}`;
  lines.push(footer);

  return lines;
}
