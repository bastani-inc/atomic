import {
  interruptAllRuns,
  interruptRun,
  killAllRuns,
  killRun,
  pauseAllRuns,
  pauseRun,
  resumeRun,
} from "../runs/background/status.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { store } from "../shared/store.js";
import type { WorkflowExecutionPolicy, WorkflowPersistencePort } from "../shared/types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { WorkflowToolArgs } from "./public-types.js";
import {
  allStageConflictMessage,
  ambiguousRunMessage,
  formatAlreadyEndedRetainedMessage,
  inFlightRunCount,
  reloadBlockedMessage,
  reloadFailureMessage,
  resolveToolRunTarget,
  resolveToolStageTarget,
  stageFailureMessage,
} from "./workflow-targets.js";

export interface WorkflowControlActionDeps {
  getPersistence: () => WorkflowPersistencePort | undefined;
  reloadWorkflowResources: () => Promise<void> | void;
  runtime: ExtensionRuntime;
  policy: WorkflowExecutionPolicy;
}

export function workflowPauseAction(args: WorkflowToolArgs): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No in-flight runs to pause.");
  const action = "pause";
  if (target.kind === "all") {
    if (args.stageId !== undefined && args.stageId.length > 0) {
      return { action, runId: "--all", status: "noop", message: allStageConflictMessage("pause") };
    }
    const results = pauseAllRuns();
    const paused = results.filter((r) => r.ok).length;
    return {
      action,
      runId: "--all",
      status: paused > 0 ? "paused" : "noop",
      message: paused > 0 ? `Paused ${paused} run(s).` : "No in-flight runs to pause.",
    };
  }
  if (target.kind === "ambiguous") return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
  if (target.kind === "not_found") return { action, runId: target.target, status: "noop", message: target.message };
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message };
  const stageRunId = stage.runId ?? target.runId;
  const result = pauseRun(stageRunId, { stageId: stage.stageId });
  return result.ok
    ? { action, runId: result.runId, status: "paused", message: `Paused ${result.paused.length} stage(s) on run ${result.runId.slice(0, 8)}.` }
    : {
        action,
        runId: stageRunId,
        status: "noop",
        message: stageFailureMessage(stageRunId, result.reason, "pause"),
      };
}

export async function workflowReloadAction(
  args: WorkflowToolArgs,
  deps: Pick<WorkflowControlActionDeps, "reloadWorkflowResources">,
): Promise<WorkflowToolResult> {
  const activeRuns = inFlightRunCount();
  if (activeRuns > 0) {
    return { action: "reload", status: "noop", message: reloadBlockedMessage(activeRuns) };
  }
  try {
    await deps.reloadWorkflowResources();
  } catch (error) {
    return { action: "reload", status: "noop", message: reloadFailureMessage(error) };
  }
  return {
    action: "reload",
    status: "ok",
    message: args.reason?.trim()
      ? `Reloaded workflow resources (${args.reason.trim()}).`
      : "Reloaded workflow resources.",
  };
}

export function workflowKillAction(
  args: WorkflowToolArgs,
  deps: Pick<WorkflowControlActionDeps, "getPersistence">,
): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No in-flight runs to kill.");
  const action = "kill";
  if (target.kind === "all") {
    if (args.stageId !== undefined && args.stageId.length > 0) {
      return { action, runId: "--all", status: "noop", message: allStageConflictMessage("kill") };
    }
    const results = killAllRuns({ cancellation: cancellationRegistry, persistence: deps.getPersistence() });
    const killed = results.filter((r) => r.ok).length;
    return {
      action,
      runId: "--all",
      status: killed > 0 ? "killed" : "noop",
      message: killed > 0 ? `Killed and retained ${killed} run(s) for inspection.` : "No in-flight runs to kill.",
    };
  }
  if (target.kind === "ambiguous") return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
  if (target.kind === "not_found") return { action, runId: target.target, status: "noop", message: target.message };
  const result = killRun(target.runId, { cancellation: cancellationRegistry, persistence: deps.getPersistence() });
  if (result.ok) {
    return {
      action,
      runId: result.runId,
      status: "killed",
      message: `Run ${result.runId} killed and retained for inspection (was ${result.previousStatus}).`,
    };
  }
  return {
    action,
    runId: target.runId,
    status: "noop",
    message: result.reason === "already_ended"
      ? formatAlreadyEndedRetainedMessage(target.runId)
      : `Run not found: ${target.runId}`,
  };
}

export function workflowInterruptAction(args: WorkflowToolArgs): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No in-flight runs to interrupt.");
  const action = "interrupt";
  if (target.kind === "all") {
    if (args.stageId !== undefined && args.stageId.length > 0) {
      return { action, runId: "--all", status: "noop", message: allStageConflictMessage("interrupt") };
    }
    const results = interruptAllRuns();
    const interrupted = results.filter((r) => r.ok).length;
    return {
      action,
      runId: "--all",
      status: interrupted > 0 ? "paused" : "noop",
      message: interrupted > 0 ? `Interrupted ${interrupted} run(s).` : "No in-flight runs to interrupt.",
    };
  }
  if (target.kind === "ambiguous") return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
  if (target.kind === "not_found") return { action, runId: target.target, status: "noop", message: target.message };
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message };
  const stageRunId = stage.runId ?? target.runId;
  const result = interruptRun(stageRunId, { stageId: stage.stageId });
  if (result.ok) {
    return {
      action,
      runId: result.runId,
      status: "paused",
      message: stage.stageId
        ? `Stage ${stage.stageId} interrupted on run ${result.runId} and can be resumed.`
        : `Run ${result.runId} interrupted and can be resumed.`,
    };
  }
  return {
    action,
    runId: stageRunId,
    status: "noop",
    message: stageFailureMessage(stageRunId, result.reason, "interrupt"),
  };
}

export function workflowResumeAction(
  args: WorkflowToolArgs,
  deps: Pick<WorkflowControlActionDeps, "runtime" | "policy">,
): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No active run to resume.");
  if (target.kind === "all") return { action: "resume", runId: "--all", status: "noop", message: "Resume does not support --all." };
  if (target.kind === "ambiguous") return { action: "resume", runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
  if (target.kind === "not_found") return { action: "resume", runId: target.target, status: "noop", message: target.message };
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok) return { action: "resume", runId: target.runId, status: "noop", message: stage.message };
  const stageRunId = stage.runId ?? target.runId;
  const run = store.runs().find((r) => r.id === stageRunId);
  const isPaused = run?.status === "paused" || (run?.stages.some((s) => s.status === "paused") ?? false);
  const isResumableContinuation = run !== undefined && !isPaused && (
    (run.status === "failed" && run.endedAt !== undefined && run.resumable !== false) ||
    (run.endedAt === undefined && run.resumable === true && run.failureRecoverability === "recoverable")
  );
  if (isResumableContinuation) {
    const continuation = deps.runtime.resumeFailedRun(stageRunId, stage.stageId, { policy: deps.policy });
    return {
      action: "resume",
      runId: continuation.ok ? continuation.runId : stageRunId,
      status: continuation.ok ? "running" : "noop",
      message: continuation.message,
    };
  }
  const result = resumeRun(stageRunId, { stageId: stage.stageId, message: args.message });
  if (result.ok) {
    const message = result.message ?? (isPaused
      ? result.resumed.length === 0
        ? `No paused stages on run ${result.runId.slice(0, 8)}.`
        : `Resumed ${result.resumed.length} stage(s) on run ${result.runId.slice(0, 8)}${args.message ? ` with message: "${args.message}"` : ""}.`
      : `Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`);
    return { action: "resume", runId: result.runId, status: "ok", message };
  }
  return { action: "resume", runId: stageRunId, status: "noop", message: `Run not found: ${stageRunId}` };
}
