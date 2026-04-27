/**
 * `atomic workflow status [<id>]` — query the current state of one or
 * all running workflows so an orchestrating agent can decide whether
 * to keep waiting, surface a HIL prompt to the user, or move on.
 *
 * Status sources, in priority order:
 *   1. <sessionDir>/status.json — written by the orchestrator on every
 *      panel-store mutation. Provides per-stage detail and the
 *      derived overall state (in_progress | error | completed |
 *      needs_review).
 *   2. tmux liveness fallback — when status.json is missing or stale
 *      we still report whether the tmux session is alive so
 *      script-driven workflows aren't blind during the brief window
 *      before the orchestrator first writes its snapshot.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { COLORS, createPainter, type PaletteKey } from "../../theme/colors.ts";
import {
  isTmuxInstalled as _isTmuxInstalled,
  listSessions as _listSessions,
  sessionExists as _sessionExists,
} from "../../sdk/runtime/tmux.ts";
import {
  readSnapshot,
  workflowRunIdFromTmuxName,
  type WorkflowOverallStatus,
  type WorkflowStatusSnapshot,
} from "../../sdk/runtime/status-writer.ts";
import type { TmuxSession } from "../../sdk/runtime/tmux.ts";

export type StatusFormat = "json" | "text";

/** A single workflow's resolved status, as returned to the caller. */
export interface WorkflowStatusReport {
  /** Tmux session name (e.g. `atomic-wf-claude-ralph-a1b2c3d4`). */
  id: string;
  /** Workflow run id (the trailing 8-hex segment of the tmux name). */
  workflowRunId: string;
  /** Workflow name pulled from the snapshot. Empty when no snapshot exists. */
  workflowName: string;
  /** Agent backend (claude / copilot / opencode). */
  agent: string;
  overall: WorkflowOverallStatus;
  /** True when the tmux session is currently alive on the atomic socket. */
  alive: boolean;
  /** ISO timestamp of the last snapshot, or null when none exists. */
  updatedAt: string | null;
  /** Sessions/stages, mirrored from the snapshot. Empty when no snapshot exists. */
  sessions: WorkflowStatusSnapshot["sessions"];
  /** Fatal-error message, if any. */
  fatalError: string | null;
}

export interface StatusDeps {
  isTmuxInstalled: () => boolean;
  sessionExists: (name: string) => boolean;
  listSessions: () => TmuxSession[];
  /**
   * Read a snapshot from disk. Defaults to the real reader; tests
   * inject a fake to control the snapshot data without touching the
   * filesystem.
   */
  readSnapshot: typeof readSnapshot;
  /** Base directory for session dirs. Defaults to `~/.atomic/sessions`. */
  sessionsBaseDir: string;
}

const defaultDeps: StatusDeps = {
  isTmuxInstalled: _isTmuxInstalled,
  sessionExists: _sessionExists,
  listSessions: _listSessions,
  readSnapshot,
  sessionsBaseDir: join(homedir(), ".atomic", "sessions"),
};

/**
 * Build a report for a single workflow. When the on-disk snapshot is
 * missing we still emit a minimal report so callers can distinguish
 * "workflow exists but hasn't written a snapshot yet" from "workflow
 * doesn't exist at all" (the latter returns null upstream).
 */
async function buildReport(
  tmuxName: string,
  alive: boolean,
  deps: StatusDeps,
): Promise<WorkflowStatusReport | null> {
  const workflowRunId = workflowRunIdFromTmuxName(tmuxName);
  if (!workflowRunId) return null;

  const sessionDir = join(deps.sessionsBaseDir, workflowRunId);
  const snapshot = await deps.readSnapshot(sessionDir);

  if (!snapshot) {
    return {
      id: tmuxName,
      workflowRunId,
      workflowName: "",
      agent: "",
      // Without a snapshot we can only say it's still running (or
      // already gone) — never that it succeeded or errored.
      overall: alive ? "in_progress" : "error",
      alive,
      updatedAt: null,
      sessions: [],
      fatalError: alive ? null : "orchestrator exited before writing status",
    };
  }

  // If the orchestrator has shut down but the snapshot still says
  // in_progress, downgrade to error — the process died without
  // writing a terminal state.
  const overall: WorkflowOverallStatus =
    !alive && snapshot.overall === "in_progress" ? "error" : snapshot.overall;

  return {
    id: tmuxName,
    workflowRunId,
    workflowName: snapshot.workflowName,
    agent: snapshot.agent,
    overall,
    alive,
    updatedAt: snapshot.updatedAt,
    sessions: snapshot.sessions,
    fatalError:
      overall === "error" && snapshot.fatalError === null && !alive
        ? "orchestrator exited unexpectedly"
        : snapshot.fatalError,
  };
}

export interface WorkflowStatusOptions {
  /** Filter to a specific workflow by tmux session name. */
  id?: string;
  format?: StatusFormat;
}

/**
 * Top-level command. Prints either a single report (when `id` is
 * provided) or the list of all workflow sessions on the atomic
 * socket. Returns 1 when a requested id can't be found, 0 otherwise.
 */
export async function workflowStatusCommand(
  options: WorkflowStatusOptions,
  deps: StatusDeps = defaultDeps,
): Promise<number> {
  const format: StatusFormat = options.format ?? "json";

  if (!deps.isTmuxInstalled()) {
    return emit(format, { workflows: [] }, "no sessions running (tmux is not installed)");
  }

  const allSessions = deps.listSessions();
  const workflowSessions = allSessions.filter((s) => s.type === "workflow");

  // ── Single-workflow query ────────────────────────────────────────
  if (options.id !== undefined) {
    const target = workflowSessions.find((s) => s.name === options.id);
    // Honour the requested id even when the tmux session is gone but
    // the on-disk snapshot might still be readable (best-effort
    // post-mortem). When neither exists we report not found.
    if (!target) {
      const fallbackRunId = workflowRunIdFromTmuxName(options.id);
      if (fallbackRunId) {
        const report = await buildReport(options.id, false, deps);
        if (report && report.workflowName !== "") {
          return emitReport(format, report);
        }
      }
      return reportError(
        format,
        `Workflow '${options.id}' not found.`,
      );
    }
    const report = await buildReport(target.name, true, deps);
    if (!report) {
      return reportError(format, `Could not parse workflow id '${options.id}'.`);
    }
    return emitReport(format, report);
  }

  // ── All-workflow listing ─────────────────────────────────────────
  const reports: WorkflowStatusReport[] = [];
  for (const s of workflowSessions) {
    const r = await buildReport(s.name, true, deps);
    if (r) reports.push(r);
  }

  return emit(
    format,
    { workflows: reports },
    "no workflows running",
    reports,
  );
}

// ─── Output helpers ─────────────────────────────────────────────────

function emit(
  format: StatusFormat,
  jsonPayload: { workflows: WorkflowStatusReport[] },
  emptyMessage: string,
  reports?: WorkflowStatusReport[],
): number {
  if (format === "json") {
    process.stdout.write(JSON.stringify(jsonPayload, null, 2) + "\n");
    return 0;
  }
  const list = reports ?? jsonPayload.workflows;
  if (list.length === 0) {
    const paint = createPainter();
    process.stdout.write(
      "\n  " + paint("text", emptyMessage, { bold: true }) + "\n\n",
    );
    return 0;
  }
  process.stdout.write(renderListText(list));
  return 0;
}

function emitReport(format: StatusFormat, report: WorkflowStatusReport): number {
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderReportText(report));
  }
  return 0;
}

function reportError(format: StatusFormat, message: string): number {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + "\n");
  } else {
    process.stderr.write(`${COLORS.red}Error: ${message}${COLORS.reset}\n`);
  }
  return 1;
}

const OVERALL_COLORS: Record<WorkflowOverallStatus, PaletteKey> = {
  in_progress: "accent",
  needs_review: "warning",
  completed: "success",
  error: "error",
};

const OVERALL_INDICATOR: Record<WorkflowOverallStatus, string> = {
  in_progress: "●",
  needs_review: "!",
  completed: "✓",
  error: "✗",
};

function renderListText(reports: WorkflowStatusReport[]): string {
  const paint = createPainter();
  const lines: string[] = [];
  const noun = reports.length === 1 ? "workflow" : "workflows";
  lines.push("");
  lines.push(
    "  " +
      paint("text", String(reports.length), { bold: true }) +
      " " +
      paint("dim", noun),
  );
  lines.push("");
  for (const r of reports) {
    const color = OVERALL_COLORS[r.overall];
    const indicator = OVERALL_INDICATOR[r.overall];
    const label =
      r.workflowName !== "" ? r.workflowName : "(no snapshot)";
    lines.push(
      "  " +
        paint(color, indicator) +
        " " +
        paint("text", r.id, { bold: true }) +
        "  " +
        paint(color, r.overall) +
        "  " +
        paint("dim", label),
    );
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

function renderReportText(report: WorkflowStatusReport): string {
  const paint = createPainter();
  const color = OVERALL_COLORS[report.overall];
  const lines: string[] = [];
  lines.push("");
  lines.push(
    "  " +
      paint(color, OVERALL_INDICATOR[report.overall]) +
      " " +
      paint("text", report.id, { bold: true }) +
      "  " +
      paint(color, report.overall),
  );
  if (report.workflowName !== "") {
    lines.push(
      "  " +
        paint("dim", "workflow: ") +
        paint("text", report.workflowName) +
        paint("dim", " · ") +
        paint("accent", report.agent),
    );
  }
  if (report.fatalError) {
    lines.push("  " + paint("error", `error: ${report.fatalError}`));
  }
  if (report.sessions.length > 0) {
    lines.push("");
    lines.push("  " + paint("dim", "stages:"));
    for (const s of report.sessions) {
      lines.push(
        "    " +
          paint("text", s.name) +
          "  " +
          paint("dim", s.status) +
          (s.error ? "  " + paint("error", s.error) : ""),
      );
    }
  }
  if (report.updatedAt) {
    lines.push("");
    lines.push("  " + paint("dim", `updated: ${report.updatedAt}`));
  }
  lines.push("");
  return lines.join("\n") + "\n";
}
