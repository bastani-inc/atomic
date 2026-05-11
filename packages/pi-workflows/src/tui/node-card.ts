/**
 * String-rendering helper for a single DAG node card.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/node-card.tsx
 */
import type { StageSnapshot } from "../store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import { statusIcon, fmtDuration } from "./status-helpers.js";
import { lerpColor, hexToAnsi, RESET } from "./color-utils.js";
import { NODE_W, NODE_H } from "./layout.js";

export interface NodeCardOpts {
  width?: number;
  height?: number;
  focused?: boolean;
  pulsePhase?: number; // 0-1 for pulse animation
  theme: GraphTheme;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function padEnd(s: string, len: number): string {
  const visLen = stripAnsi(s).length;
  const pad = Math.max(0, len - visLen);
  return s + " ".repeat(pad);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render a stage as a multi-line card string.
 * Returns array of `height` lines, each `width` chars wide.
 */
export function renderNodeCard(stage: StageSnapshot, opts: NodeCardOpts): string[] {
  const width = opts.width ?? NODE_W;
  const height = opts.height ?? NODE_H;
  const focused = opts.focused ?? false;
  const pulsePhase = opts.pulsePhase ?? 0;
  const theme = opts.theme;

  // Determine border color based on status + pulse for running
  let borderColor: string;
  switch (stage.status) {
    case "running":
      borderColor = lerpColor(theme.nodeRunningBorder, theme.nodeBorder, Math.abs(Math.sin(pulsePhase * Math.PI)));
      break;
    case "completed":
      borderColor = theme.nodeCompletedBorder;
      break;
    case "failed":
      borderColor = theme.nodeFailedBorder;
      break;
    default:
      borderColor = focused ? theme.focusColor : theme.nodePendingBorder;
  }

  if (focused && stage.status !== "running") {
    borderColor = theme.focusColor;
  }

  const bc = hexToAnsi(borderColor);
  const innerWidth = width - 2; // subtract left+right borders

  // Top border
  const top = `${bc}┌${"─".repeat(innerWidth)}┐${RESET}`;

  // Bottom border
  const bottom = `${bc}└${"─".repeat(innerWidth)}┘${RESET}`;

  // Content lines (height - 2 for top/bottom borders)
  const contentLines: string[] = [];
  const contentHeight = height - 2;

  // Line 0: icon + name
  const icon = statusIcon(stage.status);
  const nameMaxLen = innerWidth - 2; // space for icon + space
  const nameStr = truncate(stage.name, nameMaxLen);
  const line0Content = `${icon} ${nameStr}`;
  const line0 = `${bc}│${RESET}${padEnd(line0Content, innerWidth)}${bc}│${RESET}`;
  contentLines.push(line0);

  // Line 1: status + duration
  if (contentHeight >= 2) {
    let dur: string;
    if (stage.durationMs != null) {
      dur = fmtDuration(stage.durationMs);
    } else if (stage.startedAt != null) {
      dur = fmtDuration(Date.now() - stage.startedAt);
    } else {
      dur = "";
    }
    const statusStr = stage.status;
    const durStr = dur ? ` ${dur}` : "";
    const line1Content = `${statusStr}${durStr}`;
    const line1 = `${bc}│${RESET}${padEnd(truncate(line1Content, innerWidth), innerWidth)}${bc}│${RESET}`;
    contentLines.push(line1);
  }

  // Remaining lines: focused indicator or blank
  for (let i = contentLines.length; i < contentHeight; i++) {
    let inner = " ".repeat(innerWidth);
    if (i === contentHeight - 1 && focused) {
      const focusStr = "[ focused ]";
      inner = padEnd(focusStr, innerWidth);
    }
    contentLines.push(`${bc}│${RESET}${inner}${bc}│${RESET}`);
  }

  const lines = [top, ...contentLines, bottom];
  // Ensure exactly `height` lines
  while (lines.length < height) lines.push(" ".repeat(width));
  return lines.slice(0, height);
}
