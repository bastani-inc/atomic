import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import type { WorkflowChildResult, WorkflowInputValues, WorkflowOutputValues, WorkflowSerializableValue } from "../shared/types.js";
import { isReopenableSessionTranscript } from "../shared/session-transcript.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
  DURABLE_STAGE_TOPOLOGY_VERSION,
  type DurableCheckpoint,
  type DurableStageCheckpoint,
  type DurableToolCheckpoint,
  type ResumableWorkflowEntry,
} from "./types.js";
import { resolveDurableEntry } from "./resume-runtime.js";
import { priorRunElapsedMs, RUN_TIMING_CHECKPOINT_NAME } from "./run-timing.js";

export type CompletedWorkflowResolution =
  | { readonly kind: "found"; readonly entry: ResumableWorkflowEntry; readonly snapshot: RunSnapshot }
  | { readonly kind: "ambiguous"; readonly matches: readonly ResumableWorkflowEntry[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly entry: ResumableWorkflowEntry };


interface StageDraft {
  readonly replayKey: string;
  readonly name: string;
  readonly firstCompletedAt: number;
  /** Every persisted identity observed for this replay key across continuations. */
  readonly sourceIds: readonly string[];
  readonly output?: DurableStageCheckpoint["output"];
  readonly result?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: DurableStageCheckpoint["modelAttempts"];
  readonly topology?: DurableStageCheckpoint["topology"];
}

/** Authoritative completed rows. This path is deliberately separate from resumability. */
export function listCompletedFromBackend(
  backend: DurableWorkflowBackend,
): readonly ResumableWorkflowEntry[] {
  return backend.listCompletedWorkflows();
}

/** Completed rows whose authoritative checkpoints and referenced transcripts still exist. */
export function listOpenableCompletedWorkflows(
  backend: DurableWorkflowBackend,
): readonly ResumableWorkflowEntry[] {
  return listCompletedFromBackend(backend)
    .filter((entry) => completedWorkflowSnapshot(backend, entry) !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resolveCompletedWorkflow(
  workflowIdOrPrefix: string,
  backend: DurableWorkflowBackend,
  openableCatalog: readonly ResumableWorkflowEntry[] = listOpenableCompletedWorkflows(backend),
): CompletedWorkflowResolution {
  const resolved = resolveDurableEntry(workflowIdOrPrefix, openableCatalog);
  if (resolved !== undefined) {
    if ("kind" in resolved) return { kind: "ambiguous", matches: resolved.matches };
    const snapshot = completedWorkflowSnapshot(backend, resolved);
    if (snapshot === undefined) {
      return { kind: "stale", entry: resolved };
    }
    return { kind: "found", entry: resolved, snapshot };
  }

  const authoritative = resolveDurableEntry(workflowIdOrPrefix, listCompletedFromBackend(backend));
  if (authoritative === undefined) return { kind: "not_found" };
  if ("kind" in authoritative) return { kind: "ambiguous", matches: authoritative.matches };
  return { kind: "stale", entry: authoritative };
}

export function completedWorkflowSnapshot(
  backend: DurableWorkflowBackend,
  entry: ResumableWorkflowEntry,
): RunSnapshot | undefined {
  const runs = completedWorkflowRunSnapshots(backend, entry);
  const root = runs.find((run) => run.id === entry.workflowId);
  if (root === undefined || (!runs.some((run) => (run.toolNodes?.length ?? 0) > 0) && !runs.some((run) => run.stages.some((stage) => stage.sessionFile !== undefined)))) return undefined;
  return root;
}

/** Rebuild the root plus every nested child run required by graph expansion. */
export function completedWorkflowRunSnapshots(
  backend: DurableWorkflowBackend,
  entry: ResumableWorkflowEntry,
): readonly RunSnapshot[] {
  const handle = backend.getWorkflow(entry.workflowId);
  if (handle === undefined || handle.status !== "completed") return [];
  const checkpoints = backend.listCheckpoints(entry.workflowId);
  if (checkpoints.length === 0) return [];
  const runs = runSnapshotsFromCheckpoints(checkpoints, handle.workflowId, handle.name, handle.updatedAt)
    .map((run) => ({ ...run, stages: run.stages.map(validatedStageTranscript) }));
  const rootIndex = runs.findIndex((run) => run.id === handle.workflowId);
  if (rootIndex < 0) return [];
  const rootDuration = priorRunElapsedMs(backend, handle.workflowId)
    ?? Math.max(0, handle.updatedAt - handle.createdAt);
  const root: RunSnapshot = {
    ...runs[rootIndex]!,
    inputs: { ...handle.inputs } as WorkflowInputValues,
    startedAt: handle.createdAt,
    endedAt: handle.updatedAt,
    durationMs: rootDuration,
    resumable: false,
  };
  return [root, ...runs.filter((_, index) => index !== rootIndex)];
}

/** Rebuild completed nested runs while a paused root is replaying cached boundaries. */
export function durableNestedRunSnapshots(
  backend: DurableWorkflowBackend,
  rootWorkflowId: string,
): readonly RunSnapshot[] {
  const handle = backend.getWorkflow(rootWorkflowId);
  if (handle === undefined) return [];
  return runSnapshotsFromCheckpoints(
    backend.listCheckpoints(rootWorkflowId),
    rootWorkflowId,
    handle.name,
    handle.updatedAt,
    false,
  ).filter((run) => run.id !== rootWorkflowId);
}

function validatedStageTranscript(stage: StageSnapshot): StageSnapshot {
  if (stage.sessionFile === undefined || isReopenableSessionTranscript(stage.sessionFile)) return stage;
  const { sessionFile, ...withoutSessionFile } = stage;
  void sessionFile;
  return withoutSessionFile;
}

function graphToolCheckpoints(checkpoints: readonly DurableCheckpoint[]): DurableToolCheckpoint[] {
  const byHash = new Map<string, DurableToolCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "tool" || checkpoint.name === RUN_TIMING_CHECKPOINT_NAME) continue;
    const existing = byHash.get(checkpoint.argsHash);
    if (existing === undefined || checkpoint.completedAt >= existing.completedAt) {
      byHash.set(checkpoint.argsHash, checkpoint);
    }
  }
  return [...byHash.values()];
}

function completedToolNodes(
  checkpoints: readonly DurableToolCheckpoint[],
  runId: string,
  rootRunId: string,
  sourceIds: ReadonlyMap<string, string>,
): ToolNodeSnapshot[] {
  return checkpoints.flatMap((checkpoint, index) => {
    const topologyRunId = checkpoint.topology?.run?.runId ?? rootRunId;
    if (topologyRunId !== runId) return [];
    const topology = checkpoint.topology;
    return [{
      kind: "tool" as const,
      id: topology?.nodeId ?? checkpoint.checkpointId,
      name: checkpoint.name,
      argsHash: checkpoint.argsHash,
      ordinal: topology?.ordinal ?? index + 1,
      parentIds: Object.freeze([...(topology?.parentIds ?? [])].map((parentId) => sourceIds.get(parentId) ?? parentId)),
      replayed: true,
      ...(topology === undefined ? { topologyState: "unavailable" as const } : {}),
      status: "cached" as const,
      executionOrder: topology?.order ?? index + 1,
      ...(topology?.startedAt !== undefined ? { startedAt: topology.startedAt } : {}),
      endedAt: topology?.endedAt ?? checkpoint.completedAt,
      resultSummary: summarizeCompletedToolResult(checkpoint.output),
      attachable: false as const,
    }];
  });
}

function summarizeCompletedToolResult(value: WorkflowSerializableValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value).slice(0, 240);
  return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`;
}


function runSnapshotsFromCheckpoints(
  checkpoints: readonly DurableCheckpoint[],
  rootRunId: string,
  rootRunName: string,
  fallbackCompletedAt: number,
  strict = true,
): RunSnapshot[] {
  const drafts = new Map<string, StageDraft>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "stage") continue;
    const existing = drafts.get(checkpoint.replayKey);
    drafts.set(checkpoint.replayKey, mergeStageDraft(existing, checkpoint));
  }
  const toolCheckpoints = graphToolCheckpoints(checkpoints);
  const ordered = [...drafts.values()]
    .filter((draft) => !strict || draft.topology?.run === undefined || draft.endedAt !== undefined || draft.output !== undefined)
    .sort((a, b) => a.firstCompletedAt - b.firstCompletedAt);
  if (ordered.length === 0 && toolCheckpoints.length === 0) {
    return [syntheticRun(rootRunId, rootRunName, checkpoints.length, fallbackCompletedAt)];
  }

  const grouped = new Map<string, StageDraft[]>();
  for (const draft of ordered) {
    if (draft.topology?.version !== DURABLE_STAGE_TOPOLOGY_VERSION) {
      if (strict) return [];
      continue;
    }
    const runId = draft.topology.run?.runId ?? rootRunId;
    const group = grouped.get(runId) ?? [];
    group.push(draft);
    grouped.set(runId, group);
  }
  for (const checkpoint of toolCheckpoints) {
    const runId = checkpoint.topology?.run?.runId ?? rootRunId;
    if (!grouped.has(runId)) grouped.set(runId, []);
  }
  retainReachableRunGroups(grouped, rootRunId);
  const idMaps = new Map<string, Map<string, string>>();
  for (const [runId, runDrafts] of grouped) {
    const ids = new Map<string, string>();
    let hasIdentityConflict = false;
    runDrafts.forEach((draft, index) => {
      const completedId = `completed-stage-${index + 1}`;
      for (const sourceId of draft.sourceIds) {
        const existing = ids.get(sourceId);
        if (existing !== undefined && existing !== completedId) hasIdentityConflict = true;
        else ids.set(sourceId, completedId);
      }
    });
    if (hasIdentityConflict) {
      if (strict) return [];
      grouped.delete(runId);
      continue;
    }
    for (const checkpoint of toolCheckpoints) {
      const ownerRunId = checkpoint.topology?.run?.runId ?? rootRunId;
      const sourceId = checkpoint.topology?.nodeId ?? checkpoint.checkpointId;
      if (ownerRunId === runId) ids.set(sourceId, sourceId);
    }
    idMaps.set(runId, ids);
  }

  const runs: RunSnapshot[] = [];
  for (const [runId, runDrafts] of grouped) {
    const ids = idMaps.get(runId)!;
    const ownedTools = toolCheckpoints.filter((checkpoint) =>
      (checkpoint.topology?.run?.runId ?? rootRunId) === runId
    );
    const hasUnknownParents = runDrafts.some((draft) =>
      draft.topology!.parentIds.some((parentId) => !ids.has(parentId))
    ) || ownedTools.some((checkpoint) =>
      checkpoint.topology?.parentIds.some((parentId) => !ids.has(parentId)) === true
    );
    if (hasUnknownParents) {
      if (strict) return [];
      continue;
    }
    const stages = runDrafts.map((draft) => stageSnapshotFromDraft(
      draft,
      ids.get(draft.topology!.stageId)!,
      draft.topology!.parentIds.map((parentId) => ids.get(parentId)!),
    ));
    const toolNodes = completedToolNodes(toolCheckpoints, runId, rootRunId, ids);
    const run = runDrafts.find((draft) => draft.topology?.run !== undefined)?.topology?.run
      ?? ownedTools.find((checkpoint) => checkpoint.topology?.run !== undefined)?.topology?.run;
    const startedAt = Math.min(
      ...stages.map((stage) => stage.startedAt ?? fallbackCompletedAt),
      ...toolNodes.map((tool) => tool.startedAt ?? tool.endedAt ?? fallbackCompletedAt),
    );
    const endedAt = Math.max(
      ...stages.map((stage) => stage.endedAt ?? fallbackCompletedAt),
      ...toolNodes.map((tool) => tool.endedAt ?? fallbackCompletedAt),
    );
    const parentRunId = run?.parentRunId ?? rootRunId;
    const boundarySourceId = grouped.get(parentRunId)?.find((draft) =>
      workflowChildFromOutput(draft.output)?.runId === runId
    )?.topology?.stageId;
    const declaredParentStageId = run?.parentStageId === undefined
      ? undefined
      : idMaps.get(parentRunId)?.get(run.parentStageId);
    const parentStageId = declaredParentStageId
      ?? (boundarySourceId === undefined ? undefined : idMaps.get(parentRunId)?.get(boundarySourceId));
    runs.push({
      id: runId,
      name: run?.runName ?? rootRunName,
      inputs: {},
      status: "completed",
      stages,
      toolNodes,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ...(run?.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
      ...(parentStageId !== undefined ? { parentStageId } : {}),
      ...(run?.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
      resumable: false,
    });
  }
  return runs;
}

function retainReachableRunGroups(grouped: Map<string, StageDraft[]>, rootRunId: string): void {
  const reachable = new Set([rootRunId]);
  const pending = [rootRunId];
  while (pending.length > 0) {
    const drafts = grouped.get(pending.pop()!);
    if (drafts === undefined) continue;
    for (const draft of drafts) {
      const childRunId = workflowChildFromOutput(draft.output)?.runId;
      if (childRunId === undefined || reachable.has(childRunId) || !grouped.has(childRunId)) continue;
      reachable.add(childRunId);
      pending.push(childRunId);
    }
  }
  for (const runId of grouped.keys()) {
    if (!reachable.has(runId)) grouped.delete(runId);
  }
}

function mergeStageDraft(
  existing: StageDraft | undefined,
  checkpoint: DurableStageCheckpoint,
): StageDraft {
  return {
    replayKey: checkpoint.replayKey,
    name: existing?.name ?? checkpoint.name,
    sourceIds: [...new Set([
      ...(existing?.sourceIds ?? []),
      ...(checkpoint.topology?.stageId !== undefined ? [checkpoint.topology.stageId] : []),
    ])],
    firstCompletedAt: Math.min(existing?.firstCompletedAt ?? checkpoint.completedAt, checkpoint.completedAt),
    ...valueOrExisting("output", checkpoint, existing),
    ...valueOrExisting("result", checkpoint, existing),
    ...valueOrExisting("sessionId", checkpoint, existing),
    ...valueOrExisting("sessionFile", checkpoint, existing),
    ...valueOrExisting("startedAt", checkpoint, existing),
    ...valueOrExisting("endedAt", checkpoint, existing),
    ...valueOrExisting("durationMs", checkpoint, existing),
    ...valueOrExisting("model", checkpoint, existing),
    ...valueOrExisting("fastMode", checkpoint, existing),
    ...valueOrExisting("attemptedModels", checkpoint, existing),
    ...valueOrExisting("modelAttempts", checkpoint, existing),
    ...preferredTopology(checkpoint, existing),
  };
}

function preferredTopology(
  checkpoint: DurableStageCheckpoint,
  existing: StageDraft | undefined,
): Pick<StageDraft, "topology"> | object {
  const current = checkpoint.topology;
  const prior = existing?.topology;
  if (current?.run !== undefined) return { topology: current };
  if (prior?.run !== undefined) return { topology: prior };
  return current !== undefined ? { topology: current } : prior !== undefined ? { topology: prior } : {};
}

function valueOrExisting<
  K extends keyof Omit<StageDraft, "replayKey" | "name" | "firstCompletedAt" | "sourceIds">
>(key: K, checkpoint: DurableStageCheckpoint, existing: StageDraft | undefined): Pick<StageDraft, K> | object {
  const checkpointValue = checkpoint[key];
  if (checkpointValue !== undefined) return { [key]: checkpointValue } as Pick<StageDraft, K>;
  const existingValue = existing?.[key];
  return existingValue === undefined ? {} : { [key]: existingValue } as Pick<StageDraft, K>;
}

function workflowChildFromOutput(output: WorkflowSerializableValue | undefined): StageSnapshot["workflowChild"] | undefined {
  if (!isWorkflowChildResult(output)) return undefined;
  return {
    alias: output.workflow,
    workflow: output.workflow,
    runId: output.runId,
    status: output.status,
    ...(output.exited !== undefined ? { exited: output.exited } : {}),
    outputs: output.outputs,
    ...(typeof output.exitReason === "string" ? { exitReason: output.exitReason } : {}),
  };
}

function isWorkflowChildResult(value: WorkflowSerializableValue | undefined): value is WorkflowChildResult<WorkflowOutputValues> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, WorkflowSerializableValue | undefined>;
  return typeof item["workflow"] === "string" && typeof item["runId"] === "string"
    && typeof item["status"] === "string" && typeof item["outputs"] === "object"
    && item["outputs"] !== null && !Array.isArray(item["outputs"]);
}

function stageSnapshotFromDraft(
  draft: StageDraft,
  id: string,
  parentIds: readonly string[],
): StageSnapshot {
  const startedAt = draft.startedAt ?? draft.firstCompletedAt;
  const endedAt = draft.endedAt ?? draft.firstCompletedAt;
  return {
    id,
    name: draft.name,
    status: "completed",
    parentIds,
    ...(draft.topology?.order !== undefined ? { executionOrder: draft.topology.order } : {}),
    startedAt,
    endedAt,
    durationMs: draft.durationMs ?? Math.max(0, endedAt - startedAt),
    ...(stageResult(draft) !== undefined ? { result: stageResult(draft) } : {}),
    replayKey: draft.replayKey,
    toolEvents: [],
    attachable: false,
    ...(workflowChildFromOutput(draft.output) !== undefined ? { workflowChild: workflowChildFromOutput(draft.output) } : {}),
    ...(draft.sessionId !== undefined ? { sessionId: draft.sessionId } : {}),
    ...(draft.sessionFile !== undefined ? { sessionFile: draft.sessionFile } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
    ...(draft.attemptedModels !== undefined ? { attemptedModels: draft.attemptedModels } : {}),
    ...(draft.modelAttempts !== undefined ? { modelAttempts: draft.modelAttempts } : {}),
  };
}

function stageResult(draft: StageDraft): string | undefined {
  if (draft.result !== undefined) return draft.result;
  if (draft.output === undefined) return undefined;
  return typeof draft.output === "string" ? draft.output : JSON.stringify(draft.output);
}

function syntheticRun(runId: string, runName: string, checkpointCount: number, completedAt: number): RunSnapshot {
  return {
    id: runId,
    name: runName,
    inputs: {},
    status: "completed",
    stages: [syntheticCheckpointStage(checkpointCount, completedAt)],
    startedAt: completedAt,
    endedAt: completedAt,
    durationMs: 0,
    resumable: false,
  };
}

function syntheticCheckpointStage(checkpointCount: number, completedAt: number): StageSnapshot {
  return {
    id: "completed-checkpoints",
    name: "durable checkpoints",
    status: "completed",
    parentIds: [],
    startedAt: completedAt,
    endedAt: completedAt,
    durationMs: 0,
    result: `${checkpointCount} durable checkpoint${checkpointCount === 1 ? "" : "s"}`,
    toolEvents: [],
    attachable: false,
  };
}
