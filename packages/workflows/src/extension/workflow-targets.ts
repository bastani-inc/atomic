import { getEnvValue, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import type { RunStatus } from "../shared/store-types.js";
import { store } from "../shared/store.js";
import { expandWorkflowGraph, expandedStageLabel, stageMatchesExpandedIdentifier } from "../shared/expanded-workflow-graph.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { OverlayPiSurface } from "../tui/overlay-adapter.js";
import type { PiExecuteContext } from "./public-types.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { PiUISurface } from "./wiring.js";

export function formatAlreadyEndedRetainedMessage(runId: string): string {
  return `Run ${runId.slice(0, 8)} already ended; retained for inspection.`;
}

export function stageFailureMessage(
  runId: string,
  resultReason: string,
  action: "pause" | "interrupt",
): string {
  switch (resultReason) {
    case "not_found":
      return `Run not found: ${runId}`;
    case "already_ended":
      return `Run already ended: ${runId}`;
    case "stage_not_found":
      return `Stage not found for run: ${runId}`;
    default:
      return `No active stages to ${action} for run: ${runId}`;
  }
}

export function inFlightRunCount(): number {
  return topLevelWorkflowRuns(store.runs()).filter((run) => run.endedAt === undefined).length;
}

export function topLevelExpandedSnapshots() {
  const snapshot = store.snapshot();
  return topLevelWorkflowRuns(snapshot.runs).map((run) => {
    const graph = expandWorkflowGraph(snapshot, run.id);
    return {
      ...structuredClone(run),
      stages: graph.stages.map((stage) => structuredClone(stage)),
      toolNodes: graph.tools.map((tool) => structuredClone(tool)),
    };
  });
}


export function allStageConflictMessage(action: "pause" | "interrupt" | "quit"): string {
  return `Cannot ${action} --all with a stageId; omit stageId or target a single run.`;
}


export function reloadFailureMessage(error: unknown): string {
  return `Reload failed: ${error instanceof Error ? error.message : String(error)}`;
}

function hasWorkflowStageSubagentGuardEnv(): boolean {
  return getEnvValue(WORKFLOW_STAGE_SUBAGENT_GUARD_ENV) === "1";
}

export function isWorkflowStageToolContext(ctx: PiExecuteContext): boolean {
  return hasWorkflowStageSubagentGuardEnv() || ctx.orchestrationContext?.kind === "workflow-stage";
}

export function isRunStatus(value: string): value is RunStatus {
  switch (value) {
    case "pending":
    case "running":
    case "paused":
    case "completed":
    case "skipped":
    case "cancelled":
    case "blocked":
    case "failed":
    case "killed":
      return true;
    default:
      return false;
  }
}

export type RunIdResolution =
  | { kind: "exact"; runId: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not_found" };

export function resolveRunIdPrefix(target: string): RunIdResolution {
  const runs = store.runs();
  const exact = runs.find((r) => r.id === target);
  if (exact) return { kind: "exact", runId: exact.id };
  const prefixed = runs.filter((r) => r.id.startsWith(target));
  if (prefixed.length === 0) return { kind: "not_found" };
  if (prefixed.length === 1) return { kind: "exact", runId: prefixed[0]!.id };
  return { kind: "ambiguous", matches: prefixed.map((r) => r.id) };
}

export type ToolRunTarget =
  | { kind: "all" }
  | { kind: "run"; runId: string }
  | { kind: "ambiguous"; target: string; matches: string[] }
  | { kind: "not_found"; target: string; message: string };

export function resolveToolRunTarget(
  args: WorkflowToolArgs,
  emptyMessage: string,
): ToolRunTarget {
  const rawTarget = args.runId?.trim() ?? "";
  if (args.all === true || rawTarget === "--all") return { kind: "all" };
  const target = rawTarget || store.activeRunId() || "";
  if (!target) return { kind: "not_found", target: rawTarget, message: emptyMessage };
  const resolved = resolveRunIdPrefix(target);
  if (resolved.kind === "exact") return { kind: "run", runId: resolved.runId };
  if (resolved.kind === "ambiguous") return { kind: "ambiguous", target, matches: resolved.matches };
  return { kind: "not_found", target, message: `Run not found: ${target}` };
}

export type ToolStageTarget =
  | { ok: true; runId?: string; stageId?: string }
  | { ok: false; message: string };

export function resolveStageTarget(runId: string, stageTarget?: string): ToolStageTarget {
  const target = stageTarget?.trim();
  if (!target) return { ok: true, runId };
  const graph = expandWorkflowGraph(store.snapshot(), runId);
  const exactId = graph.stages.find(
    (stage) => stage.id === target || stage.workflowGraphTarget.stageId === target,
  );
  if (exactId !== undefined) {
    return {
      ok: true,
      runId: exactId.workflowGraphTarget.runId,
      stageId: exactId.workflowGraphTarget.stageId,
    };
  }
  const exactNames = graph.stages.filter((stage) => stage.name === target);
  if (exactNames.length === 1) {
    const stage = exactNames[0]!;
    return {
      ok: true,
      runId: stage.workflowGraphTarget.runId,
      stageId: stage.workflowGraphTarget.stageId,
    };
  }
  if (exactNames.length > 1) {
    return { ok: false, message: `Ambiguous stage identifier "${target}" matches: ${exactNames.map(expandedStageLabel).join(", ")}` };
  }
  const matches = graph.stages.filter((stage) => stageMatchesExpandedIdentifier(stage, target));
  if (matches.length === 0) return { ok: false, message: `Stage not found in run ${runId.slice(0, 8)}: ${target}` };
  if (matches.length > 1) {
    return { ok: false, message: `Ambiguous stage identifier "${target}" matches: ${matches.map(expandedStageLabel).join(", ")}` };
  }
  const stage = matches[0]!;
  return {
    ok: true,
    runId: stage.workflowGraphTarget.runId,
    stageId: stage.workflowGraphTarget.stageId,
  };
}

export function resolveToolStageTarget(runId: string, stageTarget?: string): ToolStageTarget {
  return resolveStageTarget(runId, stageTarget);
}

export function ambiguousRunMessage(target: string, matches: readonly string[]): string {
  return `Ambiguous run prefix "${target}" matches: ${matches
    .map((id) => id.slice(0, 12))
    .join(", ")}`;
}

export function overlaySurfaceFromContext(ctx?: {
  ui?: PiUISurface;
}): OverlayPiSurface | undefined {
  return typeof ctx?.ui?.custom === "function" ? { ui: ctx.ui } : undefined;
}
