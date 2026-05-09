// ─── Status Helpers ───────────────────────────────

import type { GraphTheme } from "./graph-theme.ts";
import type { SessionStatus } from "./orchestrator-panel-types.ts";

interface StatusEntry {
  color: (theme: GraphTheme) => string;
  label: string;
  icon: string;
}

const STATUS_TABLE: Record<SessionStatus, StatusEntry> = {
  running:        { color: (t) => t.warning, label: "running",      icon: "●" },
  complete:       { color: (t) => t.success, label: "done",         icon: "✓" },
  pending:        { color: (t) => t.textDim, label: "waiting",      icon: "○" },
  error:          { color: (t) => t.error,   label: "failed",       icon: "✗" },
  awaiting_input: { color: (t) => t.info,    label: "input needed", icon: "?" },
  offloaded:      { color: (t) => t.textDim, label: "offloaded",    icon: "◌" },
  resuming:       { color: (t) => t.warning, label: "resuming…",    icon: "◐" },
};

function lookup(status: string): StatusEntry | undefined {
  return STATUS_TABLE[status as SessionStatus];
}

export function statusColor(status: string, theme: GraphTheme): string {
  return lookup(status)?.color(theme) ?? theme.textDim;
}

export function statusLabel(status: string): string {
  return lookup(status)?.label ?? status;
}

export function statusIcon(status: string): string {
  return lookup(status)?.icon ?? "○";
}

// ─── Duration ─────────────────────────────────────

export function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}
