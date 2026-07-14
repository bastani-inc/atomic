import { readFileSync, statSync } from "node:fs";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowInputValues } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type {
  DurableCheckpoint,
  DurableStageCheckpoint,
  ResumableWorkflowEntry,
} from "./types.js";
import { resolveDurableEntry } from "./resume-runtime.js";

export type CompletedWorkflowResolution =
  | { readonly kind: "found"; readonly entry: ResumableWorkflowEntry; readonly snapshot: RunSnapshot }
  | { readonly kind: "ambiguous"; readonly matches: readonly ResumableWorkflowEntry[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale"; readonly entry: ResumableWorkflowEntry };

interface SessionTranscriptEntry {
  readonly type?: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | object;
  };
}

interface StageDraft {
  readonly replayKey: string;
  readonly name: string;
  readonly firstCompletedAt: number;
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
    return snapshot === undefined
      ? { kind: "stale", entry: resolved }
      : { kind: "found", entry: resolved, snapshot };
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
  const handle = backend.getWorkflow(entry.workflowId);
  if (handle === undefined || handle.status !== "completed") return undefined;
  const checkpoints = backend.listCheckpoints(entry.workflowId);
  if (checkpoints.length === 0) return undefined;
  const stages = stageSnapshotsFromCheckpoints(checkpoints, handle.updatedAt).map(validatedStageTranscript);
  if (!stages.some((stage) => stage.sessionFile !== undefined)) return undefined;

  return {
    id: handle.workflowId,
    name: handle.name,
    inputs: { ...handle.inputs } as WorkflowInputValues,
    status: "completed",
    stages,
    startedAt: handle.createdAt,
    endedAt: handle.updatedAt,
    durationMs: Math.max(0, handle.updatedAt - handle.createdAt),
    resumable: false,
  };
}

function validatedStageTranscript(stage: StageSnapshot): StageSnapshot {
  if (stage.sessionFile === undefined || isReopenableSessionTranscript(stage.sessionFile)) return stage;
  const { sessionFile, ...withoutSessionFile } = stage;
  void sessionFile;
  return withoutSessionFile;
}

function isReopenableSessionTranscript(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0) return false;
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) return false;
    const entries: SessionTranscriptEntry[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as object;
      if (typeof parsed !== "object" || parsed === null) return false;
      entries.push(parsed as SessionTranscriptEntry);
    }
    const header = entries[0];
    return header?.type === "session" && typeof header.id === "string" && entries.some(isUsableContextMessage);
  } catch {
    return false;
  }
}

function isUsableContextMessage(entry: SessionTranscriptEntry): boolean {
  return entry.type === "message"
    && typeof entry.id === "string"
    && typeof entry.timestamp === "string"
    && typeof entry.message?.role === "string"
    && hasUsableMessageContent(entry.message.content);
}

function hasUsableMessageContent(content: string | object | undefined): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some(hasUsableContentBlock);
}

function hasUsableContentBlock(block: object): boolean {
  if (typeof block !== "object" || block === null) return false;
  const contentBlock = block as {
    readonly text?: string;
    readonly thinking?: string;
    readonly data?: string;
    readonly name?: string;
  };
  return [contentBlock.text, contentBlock.thinking, contentBlock.data, contentBlock.name]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

function stageSnapshotsFromCheckpoints(
  checkpoints: readonly DurableCheckpoint[],
  fallbackCompletedAt: number,
): StageSnapshot[] {
  const drafts = new Map<string, StageDraft>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "stage") continue;
    const existing = drafts.get(checkpoint.replayKey);
    drafts.set(checkpoint.replayKey, mergeStageDraft(existing, checkpoint));
  }
  const ordered = [...drafts.values()].sort((a, b) => a.firstCompletedAt - b.firstCompletedAt);
  if (ordered.length === 0) return [syntheticCheckpointStage(checkpoints.length, fallbackCompletedAt)];
  return ordered.map(stageSnapshotFromDraft);
}

function mergeStageDraft(
  existing: StageDraft | undefined,
  checkpoint: DurableStageCheckpoint,
): StageDraft {
  return {
    replayKey: checkpoint.replayKey,
    name: existing?.name ?? checkpoint.name,
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
  };
}

function valueOrExisting<
  K extends keyof Omit<StageDraft, "replayKey" | "name" | "firstCompletedAt">
>(key: K, checkpoint: DurableStageCheckpoint, existing: StageDraft | undefined): Pick<StageDraft, K> | object {
  const checkpointValue = checkpoint[key];
  if (checkpointValue !== undefined) return { [key]: checkpointValue } as Pick<StageDraft, K>;
  const existingValue = existing?.[key];
  return existingValue === undefined ? {} : { [key]: existingValue } as Pick<StageDraft, K>;
}

function stageSnapshotFromDraft(draft: StageDraft, index: number): StageSnapshot {
  const startedAt = draft.startedAt ?? draft.firstCompletedAt;
  const endedAt = draft.endedAt ?? draft.firstCompletedAt;
  return {
    id: `completed-stage-${index + 1}`,
    name: draft.name,
    status: "completed",
    parentIds: [],
    startedAt,
    endedAt,
    durationMs: draft.durationMs ?? Math.max(0, endedAt - startedAt),
    ...(stageResult(draft) !== undefined ? { result: stageResult(draft) } : {}),
    replayKey: draft.replayKey,
    toolEvents: [],
    attachable: false,
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
