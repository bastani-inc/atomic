import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { store } from "../shared/store.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { WorkflowToolArgs } from "./public-types.js";
import {
  cloneStage,
  shapeTranscriptResult,
  shouldIncludeSnapshotToolOutput,
  snapshotTranscriptEntries,
  snapshotTranscriptEntryCount,
  summarizeStage,
  transcriptEntryFromMessage,
  type MessageLike,
} from "./workflow-stage-results.js";
import {
  ambiguousRunMessage,
  resolveToolRunTarget,
  resolveToolStageTarget,
} from "./workflow-targets.js";

export function workflowStagesResult(args: WorkflowToolArgs): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No active run to inspect.");
  const filter = args.statusFilter ?? "all";
  if (target.kind === "all") {
    return {
      action: "stages",
      runId: "--all",
      filter,
      stages: [],
      error: "Stage listing requires a single run.",
    };
  }
  if (target.kind === "ambiguous") {
    return {
      action: "stages",
      runId: target.target,
      filter,
      stages: [],
      error: ambiguousRunMessage(target.target, target.matches),
    };
  }
  if (target.kind === "not_found") {
    return {
      action: "stages",
      runId: target.target,
      filter,
      stages: [],
      error: target.message,
    };
  }
  const run = store.runs().find((r) => r.id === target.runId);
  const stages = (run?.stages ?? [])
    .filter((stage) => filter === "all" || stage.status === filter)
    .map(summarizeStage);
  return { action: "stages", runId: target.runId, filter, stages };
}

export function workflowStageResult(args: WorkflowToolArgs): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No active run to inspect.");
  if (target.kind === "all") {
    return { action: "stage", runId: "--all", error: "Stage inspection requires a single run." };
  }
  if (target.kind === "ambiguous") {
    return { action: "stage", runId: target.target, error: ambiguousRunMessage(target.target, target.matches) };
  }
  if (target.kind === "not_found") {
    return { action: "stage", runId: target.target, error: target.message };
  }
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok || stage.stageId === undefined) {
    return {
      action: "stage",
      runId: target.runId,
      error: stage.ok ? "Stage id, prefix, or name is required." : stage.message,
    };
  }
  const stageRunId = stage.runId ?? target.runId;
  const run = store.runs().find((r) => r.id === stageRunId);
  const snapshot = run?.stages.find((s) => s.id === stage.stageId);
  return snapshot
    ? { action: "stage", runId: stageRunId, stage: cloneStage(snapshot) }
    : {
        action: "stage",
        runId: stageRunId,
        error: `Stage not found in run ${stageRunId.slice(0, 8)}: ${stage.stageId}`,
      };
}

export function workflowTranscriptResult(args: WorkflowToolArgs): WorkflowToolResult {
  const target = resolveToolRunTarget(args, "No active run to inspect.");
  if (target.kind === "all") {
    return {
      action: "transcript",
      runId: "--all",
      stageId: "",
      source: "error",
      entries: [],
      truncated: false,
    };
  }
  if (target.kind === "ambiguous") {
    return {
      action: "transcript",
      runId: target.target,
      stageId: "",
      source: "error",
      entries: [{ role: "notice", text: ambiguousRunMessage(target.target, target.matches) }],
      truncated: false,
    };
  }
  if (target.kind === "not_found") {
    return {
      action: "transcript",
      runId: target.target,
      stageId: "",
      source: "error",
      entries: [{ role: "notice", text: target.message }],
      truncated: false,
    };
  }
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok || stage.stageId === undefined) {
    return {
      action: "transcript",
      runId: target.runId,
      stageId: "",
      source: "error",
      entries: [{ role: "notice", text: stage.ok ? "Stage id, prefix, or name is required." : stage.message }],
      truncated: false,
    };
  }
  const stageRunId = stage.runId ?? target.runId;
  const run = store.runs().find((r) => r.id === stageRunId);
  const snapshot = run?.stages.find((s) => s.id === stage.stageId);
  const liveHandle = stageControlRegistry.get(stageRunId, stage.stageId);
  if (liveHandle !== undefined) {
    const sessionFile = liveHandle.sessionFile ?? snapshot?.sessionFile;
    const sessionId = liveHandle.sessionId ?? snapshot?.sessionId;
    return shapeTranscriptResult({
      runId: stageRunId,
      stageId: stage.stageId,
      source: "live",
      entryCount: liveHandle.messages.length,
      buildEntries: () => liveHandle.messages.map((m) => transcriptEntryFromMessage(m as MessageLike)),
      args,
      sessionId,
      sessionFile,
      transcriptPath: sessionFile,
    });
  }
  const snapshotSessionFile = snapshot?.sessionFile;
  const includeSnapshotOutput = shouldIncludeSnapshotToolOutput(args, snapshotSessionFile);
  return shapeTranscriptResult({
    runId: stageRunId,
    stageId: stage.stageId,
    source: "snapshot",
    entryCount: snapshotTranscriptEntryCount(snapshot),
    buildEntries: () => snapshotTranscriptEntries(snapshot, includeSnapshotOutput),
    args,
    sessionId: snapshot?.sessionId,
    sessionFile: snapshotSessionFile,
    transcriptPath: snapshotSessionFile,
  });
}
