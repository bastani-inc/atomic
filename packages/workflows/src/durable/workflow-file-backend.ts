import { rmSync, statSync } from "node:fs";
import type { DurableWorkflowBackend } from "./backend.js";
import type { PromptReservationToken } from "./prompt-reservation-state.js";
import type { DurableCheckpoint, DurableWorkflowStatus } from "./types.js";
import { FileDurableBackend } from "./file-backend.js";
import { durableStateFileFor, isPrunableTerminalStatus, stateMatchesWorkflowId } from "./file-backend-state.js";
import { invalidateDurableFileStateCache, readDurableFileStateCached } from "./file-backend-cache.js";
import {
  durableLockDirs,
  durableStateFiles,
  readDurableRecordsFromFile,
  type DurableRecordScanDeps,
} from "./file-backend-scan.js";
import { FileDurableCatalog, type DurableWorkflowCatalogEntries, type FileCatalogSource } from "./file-catalog.js";
import type { FileDurableRecord } from "./file-state.js";
import { isReopenableSessionTranscript } from "../shared/session-transcript.js";

export class WorkflowFileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly fileBackends = new Map<string, FileDurableBackend>();
  private readonly suppressedIds = new Set<string>();
  private readonly catalog: FileDurableCatalog;

  constructor(private readonly dir: string, private readonly scopedWorkflowId?: string) {
    this.catalog = new FileDurableCatalog(dir);
  }

  registerWorkflow(handle: Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]): void {
    this.catalog.markDirty(handle.workflowId);
    this.backendFor(handle.workflowId).registerWorkflow(handle);
    this.suppressedIds.delete(handle.workflowId);
    this.syncCatalog(handle.workflowId);
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.catalog.markDirty(checkpoint.workflowId);
    this.backendFor(checkpoint.workflowId).recordCheckpoint(checkpoint);
    this.syncCatalog(checkpoint.workflowId);
  }

  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    this.catalog.markDirty(checkpoint.workflowId);
    await this.backendFor(checkpoint.workflowId).recordCheckpointAsync(checkpoint);
    this.syncCatalog(checkpoint.workflowId);
  }

  getToolOutput(workflowId: string, argsHash: string) { return this.backendFor(workflowId).getToolOutput(workflowId, argsHash); }
  getUiResponse(workflowId: string, promptHash: string) { return this.backendFor(workflowId).getUiResponse(workflowId, promptHash); }
  getStageOutput(workflowId: string, replayKey: string) { return this.backendFor(workflowId).getStageOutput(workflowId, replayKey); }
  getStageSession(workflowId: string, replayKey: string) { return this.backendFor(workflowId).getStageSession(workflowId, replayKey); }
  listCheckpoints(workflowId: string) { return this.backendFor(workflowId).listCheckpoints(workflowId); }
  getWorkflow(workflowId: string) { return this.backendFor(workflowId).getLoadableWorkflow(workflowId); }
  getLoadableWorkflow(workflowId: string) { return this.backendFor(workflowId).getLoadableWorkflow(workflowId); }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    this.catalog.markDirty(workflowId);
    const backend = this.backendFor(workflowId);
    backend.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    if (isPrunableTerminalStatus(status, resumable)
      && backend.isWorkflowLoadable(workflowId)
      && backend.getWorkflow(workflowId) !== undefined) {
      this.removeWorkflowFile(workflowId);
      return;
    }
    this.syncCatalog(workflowId);
  }

  transitionWorkflowStatus(workflowId: string, expectedStatuses: readonly DurableWorkflowStatus[], status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): boolean {
    this.catalog.markDirty(workflowId);
    const transitioned = this.backendFor(workflowId)
      .transitionWorkflowStatus(workflowId, expectedStatuses, status, pendingPrompts, resumable);
    this.syncCatalog(workflowId);
    return transitioned;
  }

  adjustPendingPrompts(workflowId: string, delta: number): void {
    this.catalog.markDirty(workflowId);
    this.backendFor(workflowId).adjustPendingPrompts(workflowId, delta);
    this.syncCatalog(workflowId);
  }

  promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string } {
    return this.backendFor(workflowId).promptReservationScope(workflowId);
  }

  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined {
    this.catalog.markDirty(workflowId);
    const token = this.backendFor(workflowId).pendingPromptToken(workflowId, reservationId);
    this.syncCatalog(workflowId);
    return token;
  }

  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken {
    this.catalog.markDirty(workflowId);
    const token = this.backendFor(workflowId).reservePendingPrompt(workflowId, reservationId);
    this.syncCatalog(workflowId);
    return token;
  }

  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    this.catalog.markDirty(workflowId);
    this.backendFor(workflowId).releasePendingPrompt(workflowId, reservationId, token);
    this.syncCatalog(workflowId);
  }

  listResumableWorkflows() { return this.catalog.list(() => this.scanCatalogSync()).resumable; }
  listCompletedWorkflows() {
    const catalog = this.catalog.list(() => this.scanCatalogSync());
    return catalog.completedAll ?? catalog.completed;
  }
  prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
    return this.catalog.prepare(() => this.scanCatalog());
  }
  repairWorkflowCatalogEntry(workflowId: string): void { this.syncCatalog(workflowId); }
  toCacheEntry(workflowId: string) { return this.backendFor(workflowId).toCacheEntry(workflowId); }

  async deleteWorkflow(workflowId: string): Promise<void> {
    this.catalog.markDirty(workflowId);
    await this.backendFor(workflowId).deleteWorkflow(workflowId);
    this.suppressedIds.add(workflowId);
    this.catalog.remove(workflowId);
  }

  async deleteWorkflowIfInactive(workflowId: string) {
    this.catalog.markDirty(workflowId);
    const result = await this.backendFor(workflowId).deleteWorkflowIfInactive(workflowId);
    if (result.ok) {
      this.suppressedIds.add(workflowId);
      this.catalog.remove(workflowId);
    } else {
      this.syncCatalog(workflowId);
    }
    return result;
  }

  isWorkflowLoadable(workflowId: string): boolean {
    const filePath = durableStateFileFor(this.dir, workflowId);
    const ownState = readDurableFileStateCached(filePath);
    if (ownState.kind === "current" && stateMatchesWorkflowId(ownState.state, workflowId)) {
      const loadable = this.backendForFile(filePath, workflowId).isWorkflowLoadable(workflowId);
      if (loadable) this.suppressedIds.delete(workflowId);
      else this.suppressedIds.add(workflowId);
      return loadable;
    }
    if (this.suppressedIds.has(workflowId)) return false;
    const loadable = this.backendForFile(filePath, workflowId).isWorkflowLoadable(workflowId);
    if (!loadable) this.suppressedIds.add(workflowId);
    return loadable;
  }

  reset(): void {
    if (this.scopedWorkflowId !== undefined) {
      this.backendFor(this.scopedWorkflowId).reset();
      this.suppressedIds.delete(this.scopedWorkflowId);
      this.catalog.remove(this.scopedWorkflowId);
      return;
    }
    this.fileBackends.clear();
    this.suppressedIds.clear();
    for (const filePath of durableStateFiles(this.dir)) this.removeStateFile(filePath);
    for (const lockPath of durableLockDirs(this.dir)) rmSync(lockPath, { recursive: true, force: true });
    this.catalog.reset();
  }

  private backendFor(workflowId: string): FileDurableBackend {
    return this.backendForFile(durableStateFileFor(this.dir, workflowId), workflowId);
  }

  private static readonly MAX_RETAINED_FILE_BACKENDS = 128;

  private backendForFile(filePath: string, expectedWorkflowId: string): FileDurableBackend {
    const existing = this.fileBackends.get(filePath);
    if (existing !== undefined) {
      this.fileBackends.delete(filePath);
      this.fileBackends.set(filePath, existing);
      return existing;
    }
    const backend = new FileDurableBackend(filePath, expectedWorkflowId);
    this.fileBackends.set(filePath, backend);
    if (this.fileBackends.size > WorkflowFileDurableBackend.MAX_RETAINED_FILE_BACKENDS) {
      const oldest = this.fileBackends.keys().next().value;
      if (oldest !== undefined) this.fileBackends.delete(oldest);
    }
    return backend;
  }

  private scanDeps(): DurableRecordScanDeps {
    return {
      dir: this.dir,
      suppressedIds: this.suppressedIds,
      backendForFile: (filePath, workflowId) => this.backendForFile(filePath, workflowId),
    };
  }

  private scanCatalogSync(): readonly FileCatalogSource[] {
    const transcriptCache = new Map<string, boolean>();
    return durableStateFiles(this.dir).flatMap((filePath) =>
      readDurableRecordsFromFile(this.scanDeps(), filePath)
        .map((record) => this.catalogSource(record, filePath, transcriptCache)));
  }

  private async scanCatalog(): Promise<readonly FileCatalogSource[]> {
    const sources: FileCatalogSource[] = [];
    const transcriptCache = new Map<string, boolean>();
    const files = durableStateFiles(this.dir);
    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index]!;
      for (const record of readDurableRecordsFromFile(this.scanDeps(), filePath)) {
        sources.push(this.catalogSource(record, filePath, transcriptCache));
      }
      if (index > 0 && index % 256 === 0) await Bun.sleep(0);
    }
    return sources;
  }

  private syncCatalog(workflowId: string): void {
    const filePath = durableStateFileFor(this.dir, workflowId);
    const record = readDurableRecordsFromFile(this.scanDeps(), filePath)
      .find((candidate) => candidate.handle.workflowId === workflowId);
    if (record === undefined) {
      this.catalog.remove(workflowId);
      return;
    }
    this.catalog.sync(this.catalogSource(record, filePath, new Map()));
  }

  private catalogSource(record: FileDurableRecord, filePath: string, transcriptCache: Map<string, boolean>): FileCatalogSource {
    const stats = statSync(filePath);
    return {
      record,
      stateFile: filePath,
      stateMtimeMs: stats.mtimeMs,
      stateSize: stats.size,
      completedOpenable: completedRecordOpenable(record, transcriptCache),
    };
  }

  private removeWorkflowFile(workflowId: string): void {
    this.removeStateFile(durableStateFileFor(this.dir, workflowId));
    this.catalog.remove(workflowId);
  }

  private removeStateFile(filePath: string): void {
    this.fileBackends.delete(filePath);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}.lock`, { recursive: true, force: true });
    invalidateDurableFileStateCache(filePath);
  }
}

function completedRecordOpenable(record: FileDurableRecord, cache: Map<string, boolean>): boolean {
  if (record.handle.status !== "completed") return false;
  const sessionByReplayKey = new Map<string, string>();
  for (const checkpoint of record.checkpoints) {
    if (checkpoint.kind === "stage" && checkpoint.sessionFile !== undefined) {
      sessionByReplayKey.set(checkpoint.replayKey, checkpoint.sessionFile);
    }
  }
  for (const sessionFile of sessionByReplayKey.values()) {
    let openable = cache.get(sessionFile);
    if (openable === undefined) {
      openable = isReopenableSessionTranscript(sessionFile);
      cache.set(sessionFile, openable);
    }
    if (openable) return true;
  }
  return false;
}
