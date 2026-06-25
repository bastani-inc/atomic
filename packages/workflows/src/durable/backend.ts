/**
 * Durable workflow backend seam.
 *
 * This interface abstracts durable checkpoint storage so the workflow engine
 * can persist `ctx.*` operation results without coupling to a specific storage
 * backend. The default implementation is {@link InMemoryDurableBackend} (used
 * in tests and when DBOS/Postgres is unavailable). A {@link FileDurableBackend}
 * persists checkpoints to a JSON file for simple cross-process resume without
 * Postgres. The {@link DbosDurableBackend} adapter (in dbos-backend.ts) wraps
 * the real `@dbos-inc/dbos-sdk` when configured.
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
import type {
  DurableCheckpoint,
  DurableCheckpointEntry,
  DurableToolCheckpoint,
  DurableUiCheckpoint,
  DurableStageCheckpoint,
  DurableWorkflowHandle,
  DurableWorkflowStatus,
  ResumableWorkflowEntry,
  WorkflowSerializableObject,
} from "./types.js";

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

/**
 * Abstract durable checkpoint store. Implementations:
 * - {@link InMemoryDurableBackend} — process-local; default for tests.
 * - {@link FileDurableBackend} — JSON-file-backed; simple cross-process resume.
 * - {@link DbosDurableBackend} — wraps `@dbos-inc/dbos-sdk` + Postgres.
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

  /** List all checkpoints for a workflow (in completion order). */
  listCheckpoints(workflowId: string): readonly DurableCheckpoint[];

  /** Get the top-level workflow handle, or `undefined` if not registered. */
  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined;

  /** Update workflow status (running/paused/completed/failed/cancelled/blocked). */
  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number): void;

  /**
   * List resumable workflows (not completed/cancelled, or explicitly marked
   * resumable after failure). Used by the `/workflow resume` selector.
   */
  listResumableWorkflows(): readonly ResumableWorkflowEntry[];

  /** Export a session-cache entry for the given workflow (for JSONL persistence). */
  toCacheEntry(workflowId: string): DurableCheckpointEntry | undefined;

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

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic content hash for a JSON-serializable value.
 * Uses canonical JSON stringification (sorted keys) for stability.
 */
export function durableHash(value: WorkflowSerializableValue | WorkflowSerializableObject): string {
  const canonical = canonicalJsonString(value);
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonString(obj[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

interface InMemoryWorkflowRecord {
  handle: DurableWorkflowHandle;
  checkpoints: Map<string, DurableCheckpoint>;
  toolByHash: Map<string, DurableToolCheckpoint>;
  uiByHash: Map<string, DurableUiCheckpoint>;
  stageByReplayKey: Map<string, DurableStageCheckpoint>;
}

function checkpointKey(c: DurableCheckpoint): string {
  return `${c.kind}:${c.checkpointId}`;
}

/**
 * Process-local durable backend. Default implementation used when DBOS/Postgres
 * is not configured. Checkpoints live in memory for the lifetime of the process;
 * for cross-process resume without Postgres, use {@link FileDurableBackend}.
 */
export class InMemoryDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = false;
  private readonly workflows = new Map<string, InMemoryWorkflowRecord>();

  registerWorkflow(handle: WorkflowRegistrationInput): void {
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
      ...(handle.sessionFile !== undefined ? { sessionFile: handle.sessionFile } : {}),
      completedCheckpoints,
      pendingPrompts,
      updatedAt,
      ...(handle.label !== undefined ? { label: handle.label } : {}),
      ...(handle.rootWorkflowId !== undefined ? { rootWorkflowId: handle.rootWorkflowId } : {}),
      ...(handle.resumable !== undefined ? { resumable: handle.resumable } : {}),
    };
    if (existing) existing.handle = full;
    else this.workflows.set(handle.workflowId, { handle: full, checkpoints: new Map(), toolByHash: new Map(), uiByHash: new Map(), stageByReplayKey: new Map() });
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    const rec = this.workflows.get(checkpoint.workflowId);
    if (!rec) return;
    const key = checkpointKey(checkpoint);
    if (rec.checkpoints.has(key)) return; // idempotent
    rec.checkpoints.set(key, checkpoint);
    if (checkpoint.kind === "tool") rec.toolByHash.set(checkpoint.argsHash, checkpoint);
    else if (checkpoint.kind === "ui") rec.uiByHash.set(checkpoint.promptHash, checkpoint);
    else rec.stageByReplayKey.set(checkpoint.replayKey, checkpoint);
    rec.handle = { ...rec.handle, completedCheckpoints: rec.checkpoints.size, updatedAt: checkpoint.completedAt };
  }

  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
    return this.workflows.get(workflowId)?.toolByHash.get(argsHash)?.output;
  }

  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
    return this.workflows.get(workflowId)?.uiByHash.get(promptHash)?.response;
  }

  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
    return this.workflows.get(workflowId)?.stageByReplayKey.get(replayKey)?.output;
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    const rec = this.workflows.get(workflowId);
    if (!rec) return [];
    return [...rec.checkpoints.values()].sort((a, b) => a.completedAt - b.completedAt);
  }

  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
    return this.workflows.get(workflowId)?.handle;
  }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number): void {
    const rec = this.workflows.get(workflowId);
    if (!rec) return;
    rec.handle = { ...rec.handle, status, updatedAt: Date.now(), ...(pendingPrompts !== undefined ? { pendingPrompts } : {}) };
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
    return [...this.workflows.values()]
      .filter((rec) => isRootWorkflow(rec.handle) && isResumableHandle(rec.handle))
      .map((rec) => toResumableEntry(rec.handle));
  }

  toCacheEntry(workflowId: string): DurableCheckpointEntry | undefined {
    const rec = this.workflows.get(workflowId);
    if (!rec) return undefined;
    const h = rec.handle;
    return {
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
      ts: h.updatedAt,
    };
  }

  reset(): void {
    this.workflows.clear();
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

function isResumableHandle(handle: DurableWorkflowHandle): boolean {
  if (handle.status === "failed" || handle.status === "blocked") return handle.resumable !== false;
  return handle.status === "running" || handle.status === "paused";
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
    createdAt: handle.createdAt,
    updatedAt: handle.updatedAt,
  };
}
