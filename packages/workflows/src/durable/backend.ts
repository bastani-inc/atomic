/**
 * Durable workflow backend seam.
 *
 * This interface abstracts durable checkpoint storage so the workflow engine
 * can persist `ctx.*` operation results without coupling to a specific storage
 * backend. The default implementation is the zero-infrastructure
 * per-workflow file backend, rooted under `~/.atomic/workflow-durable`, so
 * cross-session resume works without user setup. {@link InMemoryDurableBackend}
 * remains available for isolated tests and explicit custom overrides. The
 * {@link DbosDurableBackend} adapter (in dbos-backend.ts) wraps the real
 * `@dbos-inc/dbos-sdk` when configured.
 *
 * Design:
 * - Only `ctx.*` blocks write checkpoints (tool, ui, stage).
 * - Checkpoints are keyed by (workflowId, kind, checkpointId) for uniqueness.
 * - Tool/ui checkpoints also key on a content hash so identical calls are
 *   idempotent (completed side effects are not repeated on resume).
 * - The backend is the checkpoint source of truth; session JSONL entries are
 *   a discovery cache.
 *
 * cross-ref: issue #1498 — DBOS integration behind a backend seam.
 */

import type { WorkflowSerializableValue } from "../shared/types.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import { DURABLE_FORMAT_VERSION } from "./format-version.js";
import { inactivePromptReservationToken, PromptReservationState, type PromptReservationToken } from "./prompt-reservation-state.js";
import type {
  DurableCheckpoint,
  DurableCheckpointEntry,
  DurableToolCheckpoint,
  DurableUiCheckpoint,
  DurableStageCheckpoint,
  DurableWorkflowHandle,
  DurableWorkflowStatus,
  ResumableWorkflowEntry,
} from "./types.js";
import type { DurableWorkflowCatalogEntries } from "./file-catalog.js";
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

/**
 * Abstract durable checkpoint store. Implementations:
 * - per-workflow file backend — JSON-file-backed; default cross-process resume.
 * - {@link DbosDurableBackend} — wraps `@dbos-inc/dbos-sdk` + Postgres.
 * - {@link InMemoryDurableBackend} — process-local; explicit test/custom use.
 */
export interface DurableWorkflowBackend {
  /**
   * True when the backend persists across processes (file/DBOS). When false
   * (in-memory), the engine skips session-cache persistence since there is no
   * cross-session state to discover. This keeps in-process test runs from
   * polluting session JSONL with discovery cache entries.
   */
  readonly persistent: boolean;
  /** Register or update a workflow's top-level metadata. */
  registerWorkflow(handle: WorkflowRegistrationInput): void;

  /** Record a completed checkpoint. Idempotent: same (kind, checkpointId) is a no-op. */
  recordCheckpoint(checkpoint: DurableCheckpoint): void;

  /**
   * Optional async checkpoint persistence. DBOS-backed implementations use this
   * so ctx.tool/ctx.ui can await durable writes before returning side-effect
   * results to workflow code.
   */
  recordCheckpointAsync?(checkpoint: DurableCheckpoint): Promise<void>;

  /** Optional: wait for serialized durable writes to settle. */
  flush?(): Promise<void>;

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
  getLoadableWorkflow?(workflowId: string): DurableWorkflowHandle | undefined;

  /** Update workflow status (running/paused/completed/failed/cancelled/blocked). */
  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void;
  /** Atomically update status only when the authoritative status is expected. */
  transitionWorkflowStatus?(
    workflowId: string,
    expectedStatuses: readonly DurableWorkflowStatus[],
    status: DurableWorkflowStatus,
    pendingPrompts?: number,
    resumable?: boolean,
  ): boolean | Promise<boolean>;
  /** Atomically adjust unresolved UI prompt count, clamped at zero. */
  adjustPendingPrompts?(workflowId: string, delta: number): void;

  /**
   * List resumable root workflows: running/paused runs with progress and
   * failed/blocked runs unless explicitly marked non-resumable.
   */
  listResumableWorkflows(): readonly ResumableWorkflowEntry[];
  /** List successful completed root workflows with durable checkpoint progress. */
  listCompletedWorkflows(): readonly ResumableWorkflowEntry[];
  /** Prepare one shared advisory catalog for resumable and completed listings. */
  prepareWorkflowCatalog?(): Promise<DurableWorkflowCatalogEntries>;
  /** Revalidate one advisory catalog row from authoritative state. */
  repairWorkflowCatalogEntry?(workflowId: string): void;

  /** Export a session-cache entry for the given workflow (for JSONL persistence). */
  toCacheEntry(workflowId: string): DurableCheckpointEntry | undefined;

  /** Permanently remove one root workflow and its durable checkpoints. */
  deleteWorkflow(workflowId: string): Promise<void>;
  /** Atomically delete only when authoritative state is not currently running. */
  deleteWorkflowIfInactive?(workflowId: string): Promise<DurableInactiveDeleteResult>;

  /** Whether a workflow id may be exposed or resumed from live/restored metadata. */
  isWorkflowLoadable(workflowId: string): boolean;

  /** Clear all state (for tests). */
  reset(): void;

  /**
   * Optional: hydrate a single workflow's checkpoints from the persistent
   * store (DBOS) into the in-memory mirror. Implementations that do not need
   * async hydration (in-memory, file) omit this method.
   */
  hydrateWorkflow?(workflowId: string): Promise<void>;

  /**
   * Optional: hydrate all resumable workflows from the persistent store (DBOS)
   * into the in-memory mirror. Called before listing/resuming in a fresh
   * process. Implementations that do not need async hydration omit this.
   */
  hydrateResumableWorkflows?(): Promise<void>;
}

/** Compatibility helper for custom backends predating atomic prompt deltas. */
export function adjustDurablePendingPrompts(
  backend: DurableWorkflowBackend,
  workflowId: string,
  delta: number,
): void {
  if (backend.adjustPendingPrompts !== undefined) {
    backend.adjustPendingPrompts(workflowId, delta);
    return;
  }
  const handle = backend.getWorkflow(workflowId);
  if (handle === undefined) return;
  backend.setWorkflowStatus(
    workflowId,
    handle.status,
    Math.max(0, handle.pendingPrompts + delta),
    handle.resumable,
  );
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

/**
 * Process-local durable backend for tests and explicit custom overrides.
 * Checkpoints live in memory for the lifetime of the process; the production
 * default is the cross-process per-workflow file backend.
 */
export class InMemoryDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = false;
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
    };
    if (existing) existing.handle = full;
    else this.workflows.set(handle.workflowId, { handle: full, checkpoints: new Map(), toolByHash: new Map(), uiByHash: new Map(), stageOutputByReplayKey: new Map(), stageSessionByReplayKey: new Map() });
    if (handle.pendingPrompts !== undefined) this.promptReservations.delete(handle.workflowId);
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    const rec = this.workflows.get(checkpoint.workflowId);
    if (!rec) return;
    const key = checkpointKey(checkpoint);
    if (rec.checkpoints.has(key)) return; // idempotent
    rec.checkpoints.set(key, checkpoint);
    if (checkpoint.kind === "tool") rec.toolByHash.set(checkpoint.argsHash, checkpoint);
    else if (checkpoint.kind === "ui") rec.uiByHash.set(checkpoint.promptHash, checkpoint);
    else {
      if ("output" in checkpoint) rec.stageOutputByReplayKey.set(checkpoint.replayKey, checkpoint);
      if (checkpoint.sessionId !== undefined || checkpoint.sessionFile !== undefined) {
        const existing = rec.stageSessionByReplayKey.get(checkpoint.replayKey);
        if (existing === undefined || checkpoint.completedAt >= existing.completedAt) {
          rec.stageSessionByReplayKey.set(checkpoint.replayKey, checkpoint);
        }
      }
    }
    rec.handle = { ...rec.handle, completedCheckpoints: rec.checkpoints.size, updatedAt: checkpoint.completedAt };
  }

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

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    const rec = this.workflows.get(workflowId);
    if (!rec) return;
    rec.handle = { ...rec.handle, status, updatedAt: Date.now(), ...(pendingPrompts !== undefined ? { pendingPrompts } : {}), ...(resumable !== undefined ? { resumable } : {}) };
    if (pendingPrompts !== undefined) this.promptReservations.delete(workflowId);
  }

  transitionWorkflowStatus(workflowId: string, expected: readonly DurableWorkflowStatus[], status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): boolean {
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

  toCacheEntry(workflowId: string): DurableCheckpointEntry | undefined {
    const rec = this.workflows.get(workflowId);
    if (!rec) return undefined;
    const h = rec.handle;
    return {
      formatVersion: DURABLE_FORMAT_VERSION,
      type: "workflow.durable.checkpoint",
      workflowId: h.workflowId,
      name: h.name,
      inputs: h.inputs,
      status: h.status,
      completedCheckpoints: h.completedCheckpoints,
      pendingPrompts: h.pendingPrompts,
      ...(h.label !== undefined ? { label: h.label } : {}),
      ...(h.rootWorkflowId !== undefined ? { rootWorkflowId: h.rootWorkflowId } : {}),
      ...(h.resumable !== undefined ? { resumable: h.resumable } : {}),
      ...(h.invocationCwd !== undefined ? { invocationCwd: h.invocationCwd } : {}),
      ...(h.workflowCwd !== undefined ? { workflowCwd: h.workflowCwd } : {}),
      ...(h.repositoryRoot !== undefined ? { repositoryRoot: h.repositoryRoot } : {}),
      ...(h.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: h.gitWorktreeRoot } : {}),
      ts: h.updatedAt,
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

  /** Export all records (for FileDurableBackend serialization or debugging). */
  exportAll(): readonly { readonly handle: DurableWorkflowHandle; readonly checkpoints: readonly DurableCheckpoint[] }[] {
    return [...this.workflows.values()].map((rec) => ({ handle: rec.handle, checkpoints: [...rec.checkpoints.values()] }));
  }

  /** Import records (for FileDurableBackend deserialization). */
  importAll(records: readonly { readonly handle: DurableWorkflowHandle; readonly checkpoints: readonly DurableCheckpoint[] }[]): void {
    for (const rec of records) {
      this.registerWorkflow(rec.handle);
      for (const cp of rec.checkpoints) this.recordCheckpoint(cp);
    }
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
