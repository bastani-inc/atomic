/** Durable workflow backend seam for DBOS and explicit in-memory tests. */

import type { WorkflowSerializableValue } from "../shared/types.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import { inactivePromptReservationToken, PromptReservationState, type PromptReservationToken } from "./prompt-reservation-state.js";
import { withCurrentStageTopology } from "./dbos-envelope.js";
import type {
  DurableCheckpoint,
  DurableWorkflowMetadata,
  DurableToolCheckpoint,
  DurableUiCheckpoint,
  DurableStageCheckpoint,
  DurableWorkflowHandle,
  DurableWorkflowStatus,
  ResumableWorkflowEntry,
} from "./types.js";
export interface DurableWorkflowCatalogEntries {
  readonly resumable: readonly ResumableWorkflowEntry[];
  readonly completed: readonly ResumableWorkflowEntry[];
  readonly completedAll?: readonly ResumableWorkflowEntry[];
}
export { durableHash } from "./durable-hash.js";

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Input for registering/updating a workflow in the durable backend.
 * Optional fields default to existing values or zero.
 */
export type WorkflowRegistrationInput =
  Omit<DurableWorkflowHandle, "completedCheckpoints" | "pendingPrompts" | "updatedAt">
  & Partial<Pick<DurableWorkflowHandle, "completedCheckpoints" | "pendingPrompts" | "updatedAt">>;

export type DurableInactiveDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "running" };

/** DBOS is the sole persistent implementation. In-memory is a test seam and the non-durable last-resort fallback. */
export interface DurableWorkflowBackend {
  /** Whether state survives the current process. */
  readonly persistent: boolean;
  /** Register or update a workflow's top-level metadata. */
  registerWorkflow(handle: WorkflowRegistrationInput): void;

  /** Record a completed checkpoint. Idempotent: same (kind, checkpointId) is a no-op. */
  recordCheckpoint(checkpoint: DurableCheckpoint): void;

  /** Persist a checkpoint before exposing its side effect. */
  recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void>;

  /** Wait for all serialized writes to settle. */
  flush(): Promise<void>;

  /**
   * Look up a cached tool output by content hash. Returns `undefined` if the
   * tool has not completed. This is how `ctx.tool` avoids re-executing side
   * effects on resume.
   */
  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined;

  /**
   * Look up a cached UI response by prompt hash. Returns `undefined` if the
   * prompt has not been answered. This is how `ctx.ui.*` resumes at pending
   * prompts instead of re-asking completed ones.
   */
  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined;

  /** Look up a cached stage output by replay key. */
  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined;

  /** Look up the latest resumable stage session and accumulated active timing. */
  getStageSession(workflowId: string, replayKey: string): {
    sessionId?: string;
    sessionFile?: string;
    startedAt?: number;
    durationMs?: number;
  } | undefined;

  /** List all checkpoints for a workflow (in completion order). */
  listCheckpoints(workflowId: string): readonly DurableCheckpoint[];

  /** Get the top-level workflow handle, or `undefined` if not registered. */
  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined;
  /**
   * Return one authoritative loadable handle snapshot. Persistent backends use
   * this narrow seam to refresh once and classify from that same generation.
   */
  getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined;

  /** Update workflow status (running/paused/completed/failed/cancelled/blocked). */
  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void;
  /** Atomically update status only when the authoritative status is expected. */
  transitionWorkflowStatus(
    workflowId: string,
    expectedStatuses: readonly DurableWorkflowStatus[],
    status: DurableWorkflowStatus,
    pendingPrompts?: number,
    resumable?: boolean,
  ): Promise<boolean>;
  /** Atomically adjust unresolved UI prompt count, clamped at zero. */
  adjustPendingPrompts(workflowId: string, delta: number): void;

  /**
   * List resumable root workflows: running/paused runs with progress and
   * failed/blocked runs unless explicitly marked non-resumable.
   */
  listResumableWorkflows(): readonly ResumableWorkflowEntry[];
  /** List successful completed root workflows with durable checkpoint progress. */
  listCompletedWorkflows(): readonly ResumableWorkflowEntry[];
  /** Current DBOS-backed resumable and completed catalog. */
  prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries>;

  /** Shape the current DBOS metadata payload. */
  toMetadata(workflowId: string): Omit<DurableWorkflowMetadata, "promptReservationEpoch"> | undefined;

  /** Permanently remove one root workflow and its durable checkpoints. */
  deleteWorkflow(workflowId: string): Promise<void>;
  /** Atomically delete only when authoritative state is not currently running. */
  deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult>;

  /** Whether a workflow id may be exposed or resumed from live/restored metadata. */
  isWorkflowLoadable(workflowId: string): boolean;

  /** Clear all state (for tests). */
  reset(): void;

  /** Hydrate one workflow from persistent storage. */
  hydrateWorkflow(workflowId: string): Promise<void>;
  /** Hydrate all catalog candidates from persistent storage. */
  hydrateResumableWorkflows(): Promise<void>;
  promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string };
  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined;
  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken;
  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void;
}




// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

interface InMemoryWorkflowRecord {
  handle: DurableWorkflowHandle;
  checkpoints: Map<string, DurableCheckpoint>;
  toolByHash: Map<string, DurableToolCheckpoint>;
  uiByHash: Map<string, DurableUiCheckpoint>;
  stageOutputByReplayKey: Map<string, DurableStageCheckpoint>;
  stageSessionByReplayKey: Map<string, DurableStageCheckpoint>;
}

function checkpointKey(c: DurableCheckpoint): string {
  return `${c.kind}:${c.checkpointId}`;
}

/** Process-local backend: explicit test injection and the loud non-durable fallback when DBOS cannot be provisioned. */
export class InMemoryDurableBackend implements DurableWorkflowBackend {
  public readonly persistent: boolean = false;
  private readonly workflows = new Map<string, InMemoryWorkflowRecord>();
  private readonly promptReservations = new Map<string, PromptReservationState>();
  private readonly deletedWorkflowIds = new Set<string>();

  registerWorkflow(handle: WorkflowRegistrationInput): void {
    this.deletedWorkflowIds.delete(handle.workflowId);
    const existing = this.workflows.get(handle.workflowId);
    const completedCheckpoints = handle.completedCheckpoints ?? existing?.handle.completedCheckpoints ?? 0;
    const pendingPrompts = handle.pendingPrompts ?? existing?.handle.pendingPrompts ?? 0;
    const updatedAt = handle.updatedAt ?? Date.now();
    const full: DurableWorkflowHandle = {
      workflowId: handle.workflowId,
      name: handle.name,
      inputs: handle.inputs,
      createdAt: handle.createdAt,
      status: handle.status,
      ...(handle.invocationCwd !== undefined ? { invocationCwd: handle.invocationCwd } : existing?.handle.invocationCwd !== undefined ? { invocationCwd: existing.handle.invocationCwd } : {}),
      ...(handle.workflowCwd !== undefined ? { workflowCwd: handle.workflowCwd } : existing?.handle.workflowCwd !== undefined ? { workflowCwd: existing.handle.workflowCwd } : {}),
      ...(handle.repositoryRoot !== undefined ? { repositoryRoot: handle.repositoryRoot } : existing?.handle.repositoryRoot !== undefined ? { repositoryRoot: existing.handle.repositoryRoot } : {}),
      ...(handle.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: handle.gitWorktreeRoot } : existing?.handle.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: existing.handle.gitWorktreeRoot } : {}),
      ...(handle.sessionFile !== undefined ? { sessionFile: handle.sessionFile } : {}),
      completedCheckpoints,
      pendingPrompts,
      updatedAt,
      ...(handle.label !== undefined ? { label: handle.label } : {}),
      ...(handle.rootWorkflowId !== undefined ? { rootWorkflowId: handle.rootWorkflowId } : {}),
      ...(handle.resumable !== undefined ? { resumable: handle.resumable } : {}),
      ...(handle.ownerExecutorId !== undefined ? { ownerExecutorId: handle.ownerExecutorId } : existing?.handle.ownerExecutorId !== undefined ? { ownerExecutorId: existing.handle.ownerExecutorId } : {}),
    };
    if (existing) existing.handle = full;
    else this.workflows.set(handle.workflowId, { handle: full, checkpoints: new Map(), toolByHash: new Map(), uiByHash: new Map(), stageOutputByReplayKey: new Map(), stageSessionByReplayKey: new Map() });
    if (handle.pendingPrompts !== undefined) this.promptReservations.delete(handle.workflowId);
  }
  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    const currentCheckpoint = withCurrentStageTopology(checkpoint);
    const rec = this.workflows.get(currentCheckpoint.workflowId);
    if (!rec) return;
    const key = checkpointKey(currentCheckpoint);
    if (rec.checkpoints.has(key)) return;
    rec.checkpoints.set(key, currentCheckpoint);
    if (currentCheckpoint.kind === "tool") rec.toolByHash.set(currentCheckpoint.argsHash, currentCheckpoint);
    else if (currentCheckpoint.kind === "ui") rec.uiByHash.set(currentCheckpoint.promptHash, currentCheckpoint);
    else {
      if ("output" in currentCheckpoint) rec.stageOutputByReplayKey.set(currentCheckpoint.replayKey, currentCheckpoint);
      if (currentCheckpoint.sessionId !== undefined || currentCheckpoint.sessionFile !== undefined) {
        const existing = rec.stageSessionByReplayKey.get(currentCheckpoint.replayKey);
        if (existing === undefined || currentCheckpoint.completedAt >= existing.completedAt) {
          rec.stageSessionByReplayKey.set(currentCheckpoint.replayKey, currentCheckpoint);
        }
      }
    }
    rec.handle = { ...rec.handle, completedCheckpoints: rec.checkpoints.size, updatedAt: currentCheckpoint.completedAt };
  }

  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    this.recordCheckpoint(checkpoint);
  }

  async flush(): Promise<void> {}

  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
    return this.workflows.get(workflowId)?.toolByHash.get(argsHash)?.output;
  }

  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
    return this.workflows.get(workflowId)?.uiByHash.get(promptHash)?.response;
  }

  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
    const checkpoint = this.workflows.get(workflowId)?.stageOutputByReplayKey.get(replayKey);
    return checkpoint !== undefined && "output" in checkpoint ? checkpoint.output : undefined;
  }

  getStageSession(workflowId: string, replayKey: string): {
    sessionId?: string;
    sessionFile?: string;
    startedAt?: number;
    durationMs?: number;
  } | undefined {
    const checkpoint = this.workflows.get(workflowId)?.stageSessionByReplayKey.get(replayKey);
    if (checkpoint?.sessionId === undefined && checkpoint?.sessionFile === undefined) return undefined;
    return {
      ...(checkpoint.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : {}),
      ...(checkpoint.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : {}),
      ...(checkpoint.startedAt !== undefined ? { startedAt: checkpoint.startedAt } : {}),
      ...(checkpoint.durationMs !== undefined ? { durationMs: checkpoint.durationMs } : {}),
    };
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    const rec = this.workflows.get(workflowId);
    if (!rec) return [];
    return [...rec.checkpoints.values()].sort((a, b) => a.completedAt - b.completedAt);
  }

  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
    return this.workflows.get(workflowId)?.handle;
  }
  getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
    return this.getWorkflow(workflowId);
  }

  async hydrateWorkflow(_workflowId: string): Promise<void> {}

  async hydrateResumableWorkflows(): Promise<void> {}

  async prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
    return { resumable: this.listResumableWorkflows(), completed: this.listCompletedWorkflows() };
  }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    const rec = this.workflows.get(workflowId);
    if (!rec) return;
    rec.handle = { ...rec.handle, status, updatedAt: Date.now(), ...(pendingPrompts !== undefined ? { pendingPrompts } : {}), ...(resumable !== undefined ? { resumable } : {}) };
    if (pendingPrompts !== undefined) this.promptReservations.delete(workflowId);
  }

  async transitionWorkflowStatus(workflowId: string, expected: readonly DurableWorkflowStatus[], status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): Promise<boolean> {
    const current = this.workflows.get(workflowId)?.handle.status;
    if (current === undefined || !expected.includes(current)) return false;
    this.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    return true;
  }

  adjustPendingPrompts(workflowId: string, delta: number): void {
    const state = this.promptState(workflowId);
    if (state === undefined) return;
    state.adjust(delta);
    this.setPromptCount(workflowId, state.pendingPrompts);
  }

  promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string } {
    return { rootWorkflowId: workflowId, scope: "root" };
  }

  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined {
    const state = this.promptState(workflowId);
    const token = state?.claim(reservationId);
    if (state !== undefined && token !== undefined) this.setPromptCount(workflowId, state.pendingPrompts);
    return token;
  }

  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken {
    const state = this.promptState(workflowId);
    if (state === undefined) return inactivePromptReservationToken(reservationId);
    const token = state.reserve(reservationId);
    this.setPromptCount(workflowId, state.pendingPrompts);
    return token;
  }

  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    const state = this.promptState(workflowId);
    if (state === undefined) return;
    state.release(reservationId, token);
    this.setPromptCount(workflowId, state.pendingPrompts);
  }

  private promptState(workflowId: string): PromptReservationState | undefined {
    const rec = this.workflows.get(workflowId);
    if (rec === undefined) return undefined;
    let state = this.promptReservations.get(workflowId);
    if (state === undefined) {
      state = new PromptReservationState(rec.handle.pendingPrompts);
      this.promptReservations.set(workflowId, state);
    }
    return state;
  }

  private setPromptCount(workflowId: string, pendingPrompts: number): void {
    const rec = this.workflows.get(workflowId);
    if (rec !== undefined) rec.handle = { ...rec.handle, pendingPrompts, updatedAt: Date.now() };
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
    return [...this.workflows.values()]
      .filter((rec) => isDurableWorkflowResumable(rec.handle))
      .map((rec) => toResumableEntry(rec.handle));
  }

  listCompletedWorkflows(): readonly ResumableWorkflowEntry[] {
    return [...this.workflows.values()]
      .filter((rec) => isRootWorkflow(rec.handle) && isCompletedHandle(rec.handle))
      .map((rec) => toResumableEntry(rec.handle));
  }


  /** Shape the current DBOS metadata payload. */
  toMetadata(workflowId: string): Omit<DurableWorkflowMetadata, "promptReservationEpoch"> | undefined {
    const rec = this.workflows.get(workflowId);
    if (!rec) return undefined;
    const h = rec.handle;
    return {
      workflowId: h.workflowId,
      name: h.name,
      inputs: h.inputs,
      status: h.status,
      createdAt: h.createdAt,
      completedCheckpoints: h.completedCheckpoints,
      pendingPrompts: h.pendingPrompts,
      ...(h.ownerExecutorId !== undefined ? { ownerExecutorId: h.ownerExecutorId } : {}),
      ...(h.sessionFile !== undefined ? { sessionFile: h.sessionFile } : {}),
      ...(h.label !== undefined ? { label: h.label } : {}),
      ...(h.rootWorkflowId !== undefined ? { rootWorkflowId: h.rootWorkflowId } : {}),
      ...(h.resumable !== undefined ? { resumable: h.resumable } : {}),
      ...(h.invocationCwd !== undefined ? { invocationCwd: h.invocationCwd } : {}),
      ...(h.workflowCwd !== undefined ? { workflowCwd: h.workflowCwd } : {}),
      ...(h.repositoryRoot !== undefined ? { repositoryRoot: h.repositoryRoot } : {}),
      ...(h.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: h.gitWorktreeRoot } : {}),
      updatedAt: h.updatedAt,
    };
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    this.workflows.delete(workflowId);
    this.promptReservations.delete(workflowId);
    this.deletedWorkflowIds.add(workflowId);
  }

  async deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult> {
    const handle = this.workflows.get(workflowId)?.handle;
    if (handle === undefined) return { ok: false, reason: "not_found" };
    if (handle.status === "running") return { ok: false, reason: "running" };
    await this.deleteWorkflow(workflowId);
    return { ok: true };
  }

  isWorkflowLoadable(workflowId: string): boolean {
    return !this.deletedWorkflowIds.has(workflowId);
  }

  reset(): void {
    this.workflows.clear();
    this.promptReservations.clear();
    this.deletedWorkflowIds.clear();
  }

}

function isRootWorkflow(handle: DurableWorkflowHandle): boolean {
  return handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId;
}

function hasResumeProgress(handle: DurableWorkflowHandle): boolean {
  return handle.completedCheckpoints > 0 || handle.pendingPrompts > 0;
}

function isCompletedHandle(handle: DurableWorkflowHandle): boolean {
  return handle.status === "completed" && hasResumeProgress(handle);
}

/** Convert a durable workflow handle into a resume-catalog entry. */
export function resumableEntryFromHandle(handle: DurableWorkflowHandle): ResumableWorkflowEntry {
  return toResumableEntry(handle);
}

function toResumableEntry(handle: DurableWorkflowHandle): ResumableWorkflowEntry {
  return {
    workflowId: handle.workflowId,
    name: handle.name,
    inputs: handle.inputs,
    status: handle.status,
    completedCheckpoints: handle.completedCheckpoints,
    pendingPrompts: handle.pendingPrompts,
    ...(handle.sessionFile !== undefined ? { sessionFile: handle.sessionFile } : {}),
    ...(handle.label !== undefined ? { label: handle.label } : {}),
    ...(handle.rootWorkflowId !== undefined ? { rootWorkflowId: handle.rootWorkflowId } : {}),
    ...(handle.resumable !== undefined ? { resumable: handle.resumable } : {}),
    ...(handle.invocationCwd !== undefined ? { invocationCwd: handle.invocationCwd } : {}),
    ...(handle.workflowCwd !== undefined ? { workflowCwd: handle.workflowCwd } : {}),
    ...(handle.repositoryRoot !== undefined ? { repositoryRoot: handle.repositoryRoot } : {}),
    ...(handle.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: handle.gitWorktreeRoot } : {}),
    createdAt: handle.createdAt,
    updatedAt: handle.updatedAt,
  };
}
