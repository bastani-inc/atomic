/**
 * File-backed durable backend.
 *
 * Persists durable checkpoints to JSON files so a new Atomic session/process
 * can resume a workflow started in a prior session without requiring Postgres.
 * The default directory backend stores one state file per root workflow to keep
 * checkpoint writes bounded to that workflow. Each state file still uses a
 * small lock directory plus read-merge-write to avoid lost updates when multiple
 * Atomic processes update the same workflow.
 *
 * cross-ref: issue #1498 — durable fallback when DBOS/Postgres is unavailable.
 */

import { rmSync } from "node:fs";
import type { DurableCheckpoint, DurableWorkflowStatus } from "./types.js";
import {
  InMemoryDurableBackend,
  type DurableInactiveDeleteResult,
  type DurableWorkflowBackend,
} from "./backend.js";
import type { PromptReservationToken } from "./prompt-reservation-state.js";
import { mergeFileDurableRecords, readDurableFileState, type FileDurableRecord, type FileDurableState } from "./file-state.js";
import { currentState, emptyState, isPrunableTerminalStatus, stateMatchesWorkflowId } from "./file-backend-state.js";
export { defaultDurableStateDir, durableStateFileFor } from "./file-backend-state.js";
import { enqueueDurableFileWrite, withDurableFileLock, withDurableFileLockAsync, writeDurableFileState } from "./file-lock.js";
import { invalidateDurableFileStateCache, readDurableFileStateCached } from "./file-backend-cache.js";
import {
  adjustFilePrompts,
  claimFilePrompt,
  promptReservationsFrom,
  releaseFilePrompt,
  reserveFilePrompt,
  resetFilePrompts,
  withPromptReservations,
  type FilePromptReservations,
} from "./file-prompt-reservations.js";


export class FileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly mem = new InMemoryDurableBackend();
  private readonly filePath: string;
  private readonly expectedWorkflowId?: string;
  private loaded = false;
  private unknownState = false;
  private suppressedAll = false;
  private readonly deletedWorkflowIds = new Set<string>();

  constructor(
    filePath: string,
    expectedWorkflowId?: string,
    private readonly writeState: typeof writeDurableFileState = writeDurableFileState,
  ) {
    this.filePath = filePath;
    this.expectedWorkflowId = expectedWorkflowId;
  }
  private ensureLoaded(): void {
    if (this.loaded) return;
    let result = readDurableFileStateCached(this.filePath);
    if (result.kind === "legacy" && this.expectedWorkflowId !== undefined
      && (result.workflowIds.length === 0 || result.workflowIds.some((id) => id !== this.expectedWorkflowId))) {
      this.unknownState = true;
      this.suppressedAll = true;
      this.loaded = true;
      return;
    }
    if (result.kind === "legacy") {
      this.replaceLegacyState();
      result = readDurableFileState(this.filePath);
    }
    if (result.kind === "unknown" || (result.kind === "current" && !this.matchesExpectedId(result.state))) {
      this.unknownState = true;
      this.suppressedAll = true;
      this.loaded = true;
      return;
    }
    if (result.kind === "current") {
      result.state.deletedWorkflowIds.forEach((id) => this.deletedWorkflowIds.add(id));
      this.mem.importAll(result.state.workflows.filter((record) => !this.deletedWorkflowIds.has(record.handle.workflowId)));
    }
    this.loaded = true;
  }

  private replaceLegacyState(): void {
    withDurableFileLock(this.filePath, () => {
      const latest = readDurableFileState(this.filePath);
      if (latest.kind !== "legacy") return;
      const ids = this.expectedWorkflowId === undefined
        ? latest.workflowIds
        : [this.expectedWorkflowId];
      if (ids.length === 0) {
        rmSync(this.filePath, { force: true });
        this.suppressedAll = true;
        return;
      }
      ids.forEach((id) => this.deletedWorkflowIds.add(id));
      this.writeState(this.filePath, emptyState(ids));
    });
  }

  private assertWritable(): void {
    if (this.unknownState) throw new Error(`Cannot overwrite unknown durable workflow state format: ${this.filePath}`);
  }

  private mutateFreshState<T>(
    mutate: (
      latest: InMemoryDurableBackend,
      reservations: FilePromptReservations,
      deleted: Set<string>,
    ) => T,
  ): T {
    this.assertWritable();
    return withDurableFileLock(this.filePath, () => this.mutateLocked(mutate));
  }

  /** Read-merge-write body. The caller must hold the durable file lock. */
  private mutateLocked<T>(
    mutate: (
      latest: InMemoryDurableBackend,
      reservations: FilePromptReservations,
      deleted: Set<string>,
    ) => T,
  ): T {
    const result = readDurableFileState(this.filePath);
    if (result.kind === "unknown" || (result.kind === "current" && !this.matchesExpectedId(result.state))) {
      this.unknownState = true;
      this.suppressedAll = true;
      this.mem.reset();
      throw new Error(`Cannot overwrite unknown durable workflow state format: ${this.filePath}`);
    }
    const records = result.kind === "current" ? result.state.workflows : [];
    const deleted = new Set(
      result.kind === "current" ? result.state.deletedWorkflowIds
        : result.kind === "legacy" ? result.workflowIds
          : [],
    );
    const latest = new InMemoryDurableBackend();
    latest.importAll(records.filter((record) => !deleted.has(record.handle.workflowId)));
    const reservations = promptReservationsFrom(records);
    const value = mutate(latest, reservations, deleted);
    const state = currentState(withPromptReservations(latest.exportAll(), reservations), deleted);
    this.writeState(this.filePath, state);
    this.replaceMirror(state);
    return value;
  }
  private refreshCompatibilityFromDisk(): void {
    const result = readDurableFileStateCached(this.filePath);
    if (result.kind === "current" && this.matchesExpectedId(result.state)) {
      this.unknownState = false;
      this.suppressedAll = false;
      this.replaceMirror(result.state);
      return;
    }
    if (result.kind === "unknown"
      || (result.kind === "current" && !this.matchesExpectedId(result.state))
      || (result.kind === "legacy" && this.expectedWorkflowId !== undefined
        && (result.workflowIds.length === 0 || result.workflowIds.some((id) => id !== this.expectedWorkflowId)))) {
      this.unknownState = true;
      this.suppressedAll = true;
      this.mem.reset();
      return;
    }
    if (result.kind === "legacy") {
      this.loaded = false;
      this.mem.reset();
      this.deletedWorkflowIds.clear();
      this.ensureLoaded();
    }
  }
  private refreshReplayState(): readonly FileDurableRecord[] {
    this.ensureLoaded();
    // Lock-free read: writes are atomic tmp-file + rename, so readers always
    // see one consistent snapshot without spinning on the lock directory.
    const result = readDurableFileStateCached(this.filePath);
    if (result.kind === "current" && this.matchesExpectedId(result.state)) {
      this.unknownState = false; this.suppressedAll = false;
      this.replaceMirror(result.state);
      return result.state.workflows;
    }
    if (result.kind === "missing") {
      this.unknownState = false; this.suppressedAll = false;
      this.replaceMirror(emptyState());
    } else {
      this.unknownState = true; this.suppressedAll = true;
      this.mem.reset();
    }
    return [];
  }
  /** Skip mirror rebuilds when the cached state object is already applied. */
  private lastMirroredState: FileDurableState | undefined;
  private replaceMirror(state: FileDurableState): void {
    if (this.lastMirroredState === state) return; this.lastMirroredState = state;
    this.mem.reset();
    this.deletedWorkflowIds.clear();
    state.deletedWorkflowIds.forEach((id) => this.deletedWorkflowIds.add(id));
    this.mem.importAll(state.workflows.filter((record) => !this.deletedWorkflowIds.has(record.handle.workflowId)));
  }

  private matchesExpectedId(state: FileDurableState): boolean {
    if (this.expectedWorkflowId === undefined) return true;
    return state.workflows.every((record) => record.handle.workflowId === this.expectedWorkflowId)
      && state.deletedWorkflowIds.every((id) => id === this.expectedWorkflowId);
  }

  registerWorkflow(handle: Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]): void {
    this.ensureLoaded();
    this.suppressedAll = false;
    this.mutateFreshState((latest, reservations, deleted) => {
      deleted.delete(handle.workflowId);
      latest.registerWorkflow(handle);
      if (handle.pendingPrompts !== undefined) resetFilePrompts(reservations, handle.workflowId, handle.pendingPrompts);
    });
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.ensureLoaded();
    this.mutateFreshState((latest) => latest.recordCheckpoint(checkpoint));
  }

  /**
   * Async checkpoint persistence: serialized per state file in-process and
   * guarded by the event-loop-friendly async lock (no main-thread spinning).
   */
  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    this.ensureLoaded();
    this.assertWritable();
    await enqueueDurableFileWrite(this.filePath, () =>
      withDurableFileLockAsync(this.filePath, () => {
        this.mutateLocked((latest) => latest.recordCheckpoint(checkpoint));
      }));
  }

  getToolOutput(workflowId: string, argsHash: string) {
    this.refreshReplayState();
    return this.mem.getToolOutput(workflowId, argsHash);
  }

  getUiResponse(workflowId: string, promptHash: string) {
    this.refreshReplayState();
    return this.mem.getUiResponse(workflowId, promptHash);
  }

  getStageOutput(workflowId: string, replayKey: string) {
    this.refreshReplayState();
    return this.mem.getStageOutput(workflowId, replayKey);
  }

  getStageSession(workflowId: string, replayKey: string) {
    this.refreshReplayState();
    return this.mem.getStageSession(workflowId, replayKey);
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    this.refreshReplayState();
    return this.mem.listCheckpoints(workflowId);
  }

  getWorkflow(workflowId: string) {
    this.ensureLoaded();
    return this.mem.getWorkflow(workflowId);
  }

  getLoadableWorkflow(workflowId: string) {
    this.refreshReplayState(); const handle = !this.suppressedAll && !this.deletedWorkflowIds.has(workflowId) ? this.mem.getWorkflow(workflowId) : undefined;
    return handle === undefined ? undefined : structuredClone(handle);
  }

  setWorkflowStatus(workflowId: string, status: Parameters<DurableWorkflowBackend["setWorkflowStatus"]>[1], pendingPrompts?: number, resumable?: boolean): void {
    this.ensureLoaded();
    this.mutateFreshState((latest, reservations) => {
      latest.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      if (pendingPrompts !== undefined) resetFilePrompts(reservations, workflowId, pendingPrompts);
    });
  }

  transitionWorkflowStatus(workflowId: string, expectedStatuses: readonly DurableWorkflowStatus[], status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): boolean {
    this.ensureLoaded();
    return this.mutateFreshState((latest, reservations, deleted) => {
      const handle = deleted.has(workflowId) ? undefined : latest.getWorkflow(workflowId);
      if (handle === undefined || !expectedStatuses.includes(handle.status)) return false;
      latest.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      if (pendingPrompts !== undefined) resetFilePrompts(reservations, workflowId, pendingPrompts);
      return true;
    });
  }

  adjustPendingPrompts(workflowId: string, delta: number): void {
    this.ensureLoaded();
    this.mutateFreshState((latest, reservations) => {
      adjustFilePrompts(latest, reservations, workflowId, delta);
    });
  }

  promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string } {
    return { rootWorkflowId: workflowId, scope: "root" };
  }
  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined { this.ensureLoaded(); return this.mutateFreshState((latest, reservations) => claimFilePrompt(latest, reservations, workflowId, reservationId)); }

  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken {
    this.ensureLoaded();
    return this.mutateFreshState((latest, reservations) =>
      reserveFilePrompt(latest, reservations, workflowId, reservationId));
  }
  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    this.ensureLoaded();
    this.mutateFreshState((latest, reservations) => {
      releaseFilePrompt(latest, reservations, workflowId, reservationId, token);
    });
  }

  listResumableWorkflows() {
    this.ensureLoaded();
    return this.mem.listResumableWorkflows();
  }

  listCompletedWorkflows() {
    this.ensureLoaded();
    return this.mem.listCompletedWorkflows();
  }

  toCacheEntry(workflowId: string) {
    this.ensureLoaded();
    return this.mem.toCacheEntry(workflowId);
  }
  async deleteWorkflow(workflowId: string): Promise<void> {
    this.ensureLoaded();
    this.assertWritable();
    withDurableFileLock(this.filePath, () => { this.deleteStoredWorkflow(workflowId, false); });
  }

  async deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult> {
    this.ensureLoaded();
    this.assertWritable();
    return withDurableFileLock(this.filePath, () => this.deleteStoredWorkflow(workflowId, true));
  }

  removeWorkflowFileIfPrunableTerminal(workflowId: string): boolean {
    this.ensureLoaded();
    this.assertWritable();
    return withDurableFileLock(this.filePath, () => {
      const result = readDurableFileState(this.filePath);
      if (result.kind === "unknown" || (result.kind === "current" && !this.matchesExpectedId(result.state))) {
        throw new Error(`Cannot overwrite unknown durable workflow state format: ${this.filePath}`);
      }
      if (result.kind !== "current" || !stateMatchesWorkflowId(result.state, workflowId)) return false;
      const deleted = new Set(result.state.deletedWorkflowIds);
      const current = result.state.workflows.find((record) =>
        record.handle.workflowId === workflowId && !deleted.has(workflowId));
      if (current === undefined
        || !isPrunableTerminalStatus(current.handle.status, current.handle.resumable)) return false;
      rmSync(this.filePath, { force: true });
      invalidateDurableFileStateCache(this.filePath);
      this.unknownState = false;
      this.suppressedAll = false;
      this.replaceMirror(emptyState());
      return true;
    });
  }

  private deleteStoredWorkflow(workflowId: string, requireInactive: boolean): DurableInactiveDeleteResult {
    const result = readDurableFileState(this.filePath);
    if (result.kind === "unknown" || (result.kind === "current" && !this.matchesExpectedId(result.state))) {
      throw new Error(`Cannot overwrite unknown durable workflow state format: ${this.filePath}`);
    }
    const stored = result.kind === "current" ? result.state.workflows : [];
    const deleted = new Set(
      result.kind === "current" ? result.state.deletedWorkflowIds
        : result.kind === "legacy" ? result.workflowIds
          : [],
    );
    const current = stored.find((record) =>
      record.handle.workflowId === workflowId && !deleted.has(workflowId));
    if (requireInactive && current === undefined) return { ok: false, reason: "not_found" };
    if (requireInactive && current?.handle.status === "running") return { ok: false, reason: "running" };
    deleted.add(workflowId);
    const merged = mergeFileDurableRecords(stored, this.mem.exportAll())
      .filter((record) => !deleted.has(record.handle.workflowId));
    const state = currentState(merged, deleted);
    this.writeState(this.filePath, state);
    this.replaceMirror(state);
    return { ok: true };
  }

  isWorkflowLoadable(workflowId: string): boolean {
    this.ensureLoaded();
    this.refreshCompatibilityFromDisk();
    return !this.suppressedAll && !this.deletedWorkflowIds.has(workflowId);
  }

  reset(): void {
    this.lastMirroredState = undefined;
    this.mem.reset();
    this.unknownState = false;
    this.suppressedAll = false;
    this.deletedWorkflowIds.clear();
    withDurableFileLock(this.filePath, () => this.writeState(this.filePath, emptyState()));
  }
}


export { WorkflowFileDurableBackend } from "./workflow-file-backend.js";
