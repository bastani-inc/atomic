/**
 * Scoped durable backend for child workflow runs.
 *
 * A child workflow launched via `ctx.workflow(child)` runs with its own run id,
 * but its internal `ctx.tool` / `ctx.ui` / `ctx.stage` side effects must be
 * checkpointed under the PARENT (root) durable workflow so that an interrupted
 * child does not re-execute completed side effects when the parent is resumed.
 *
 * Without scoping, child checkpoints are written under a fresh per-run UUID
 * that is never recovered on resume, so a re-dispatched child loses all of its
 * prior checkpoints and re-runs side effects (split-brain). {@link ScopedDurableBackend}
 * remaps every checkpoint identity to the root workflow id, prefixed by a stable
 * child boundary key, so the same side effects are recovered on resume.
 *
 * Only checkpoint read/write methods are scoped. Lifecycle methods
 * (`registerWorkflow`, `setWorkflowStatus`, `listResumableWorkflows`,
 * `toCacheEntry`, `getWorkflow`) are no-ops for scoped children because child
 * runs are never independently resumable — only the root workflow is resumed.
 *
 * cross-ref: issue #1498 — child side effects under the root durable workflow.
 */

import type { DurableCheckpoint, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend, WorkflowRegistrationInput } from "./backend.js";

/**
 * Durable scope for a child workflow run.
 *
 * - `rootWorkflowId`: the top-level workflow id under which checkpoints persist.
 * - `scopePrefix`: a stable boundary key (e.g. `workflow:<name>:<ordinal>`)
 *   unique within the root so multiple children (and the root itself) do not
 *   collide.
 */
export interface DurableScope {
  readonly rootWorkflowId: string;
  readonly scopePrefix: string;
}

/**
 * Wrap a durable backend so all checkpoint identities for a child run are
 * namespaced under the root workflow. The wrapped backend is the source of
 * truth; this wrapper only translates keys.
 */
export class ScopedDurableBackend implements DurableWorkflowBackend {
  public readonly persistent: boolean;
  private readonly inner: DurableWorkflowBackend;
  private readonly scope: DurableScope;

  constructor(inner: DurableWorkflowBackend, scope: DurableScope) {
    this.inner = inner;
    this.scope = scope;
    this.persistent = inner.persistent;
  }

  registerWorkflow(_handle: WorkflowRegistrationInput): void {
    // Child runs are not independently resumable; only the root is registered.
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.inner.recordCheckpoint(this.remap(checkpoint));
  }

  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    if (this.inner.recordCheckpointAsync !== undefined) {
      await this.inner.recordCheckpointAsync(this.remap(checkpoint));
      return;
    }
    this.inner.recordCheckpoint(this.remap(checkpoint));
    await this.inner.flush?.();
  }

  flush(): Promise<void> {
    return this.inner.flush?.() ?? Promise.resolve();
  }

  getToolOutput(_workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
    return this.inner.getToolOutput(this.scope.rootWorkflowId, this.scopeKey(argsHash));
  }

  getUiResponse(_workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
    return this.inner.getUiResponse(this.scope.rootWorkflowId, this.scopeKey(promptHash));
  }

  getStageOutput(_workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
    return this.inner.getStageOutput(this.scope.rootWorkflowId, this.scopeKey(replayKey));
  }

  getStageSession(_workflowId: string, replayKey: string): { sessionId?: string; sessionFile?: string } | undefined {
    return this.inner.getStageSession(this.scope.rootWorkflowId, this.scopeKey(replayKey));
  }

  listCheckpoints(_workflowId: string): readonly DurableCheckpoint[] {
    const all = this.inner.listCheckpoints(this.scope.rootWorkflowId);
    const prefix = `${this.scope.scopePrefix}:`;
    // Checkpoints are stored with their scope prefix already embedded in their
    // ids (see remap()). Filter by the stored id directly — NOT by re-prefixing
    // — so sibling scopes (e.g. "workflow:child:1") are excluded when the
    // current scope is "workflow:child:2". Re-prefixing would prepend the
    // current scope prefix to every id, causing sibling ids to falsely match.
    return all.filter((cp) => storedScopeId(cp).startsWith(prefix));
  }

  getWorkflow(_workflowId: string): undefined {
    // Child runs have no independent resumable handle.
    return undefined;
  }

  setWorkflowStatus(_workflowId: string, _status: DurableWorkflowStatus, _pendingPrompts?: number, _resumable?: boolean): void {
    // No-op: child status is reflected via the root workflow boundary.
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
    return [];
  }

  toCacheEntry(_workflowId: string): undefined {
    return undefined;
  }

  reset(): void {
    // No-op: scoped backends never own root state.
  }

  hydrateWorkflow(_workflowId: string): Promise<void> {
    return Promise.resolve();
  }

  hydrateResumableWorkflows(): Promise<void> {
    return Promise.resolve();
  }

  private scopeKey(key: string): string {
    return `${this.scope.scopePrefix}:${key}`;
  }

  private remap(checkpoint: DurableCheckpoint): DurableCheckpoint {
    const workflowId = this.scope.rootWorkflowId;
    if (checkpoint.kind === "tool") {
      return {
        ...checkpoint,
        workflowId,
        checkpointId: this.scopeKey(checkpoint.checkpointId),
        argsHash: this.scopeKey(checkpoint.argsHash),
      };
    }
    if (checkpoint.kind === "ui") {
      return {
        ...checkpoint,
        workflowId,
        checkpointId: this.scopeKey(checkpoint.checkpointId),
        promptHash: this.scopeKey(checkpoint.promptHash),
      };
    }
    return {
      ...checkpoint,
      workflowId,
      checkpointId: this.scopeKey(checkpoint.checkpointId),
      replayKey: this.scopeKey(checkpoint.replayKey),
    };
  }
}

/**
 * Return the checkpoint's stored scope-qualified id, which includes any scope
 * prefix embedded by {@link ScopedDurableBackend.remap}. This is the raw stored
 * value used for prefix filtering in {@link ScopedDurableBackend.listCheckpoints}.
 */
function storedScopeId(cp: DurableCheckpoint): string {
  return cp.kind === "stage" ? cp.replayKey : cp.checkpointId;
}
