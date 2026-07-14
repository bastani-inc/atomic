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

import { readdirSync, rmSync } from "node:fs";
import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";
import { DURABLE_FORMAT_VERSION } from "./format-version.js";
import { readDurableFileState, type FileDurableRecord, type FileDurableState } from "./file-state.js";
import { withDurableFileLock, writeDurableFileState } from "./file-lock.js";

const FILE_FORMAT_VERSION = DURABLE_FORMAT_VERSION;

export class FileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly mem = new InMemoryDurableBackend();
  private readonly filePath: string;
  private readonly expectedWorkflowId?: string;
  private loaded = false;
  private unknownState = false;
  private suppressedAll = false;
  private readonly deletedWorkflowIds = new Set<string>();
  private readonly revivedWorkflowIds = new Set<string>();

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
    let result = readDurableFileState(this.filePath);
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

  private persist(): void {
    this.assertWritable();
    withDurableFileLock(this.filePath, () => {
      const result = readDurableFileState(this.filePath);
      if (result.kind === "unknown" || (result.kind === "current" && !this.matchesExpectedId(result.state))) {
        this.unknownState = true;
        this.suppressedAll = true;
        this.mem.reset();
        throw new Error(`Cannot overwrite unknown durable workflow state format: ${this.filePath}`);
      }
      const stored = result.kind === "current" ? result.state.workflows : [];
      const deleted = new Set(
        result.kind === "current" ? result.state.deletedWorkflowIds
          : result.kind === "legacy" ? result.workflowIds
            : [],
      );
      this.deletedWorkflowIds.forEach((id) => deleted.add(id));
      this.revivedWorkflowIds.forEach((id) => deleted.delete(id));
      const merged = mergeRecords(stored, this.mem.exportAll()).filter((record) => !deleted.has(record.handle.workflowId));
      const state = currentState(merged, deleted);
      this.writeState(this.filePath, state);
      this.replaceMirror(state);
      this.revivedWorkflowIds.clear();
    });
  }
  private refreshCompatibilityFromDisk(): void {
    const result = readDurableFileState(this.filePath);
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


  private replaceMirror(state: FileDurableState): void {
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
    this.assertWritable();
    this.suppressedAll = false;
    this.deletedWorkflowIds.delete(handle.workflowId);
    this.revivedWorkflowIds.add(handle.workflowId);
    this.mem.registerWorkflow(handle);
    this.persist();
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.ensureLoaded();
    this.assertWritable();
    this.mem.recordCheckpoint(checkpoint);
    this.persist();
  }

  getToolOutput(workflowId: string, argsHash: string) {
    this.ensureLoaded();
    return this.mem.getToolOutput(workflowId, argsHash);
  }

  getUiResponse(workflowId: string, promptHash: string) {
    this.ensureLoaded();
    return this.mem.getUiResponse(workflowId, promptHash);
  }

  getStageOutput(workflowId: string, replayKey: string) {
    this.ensureLoaded();
    return this.mem.getStageOutput(workflowId, replayKey);
  }

  getStageSession(workflowId: string, replayKey: string) {
    this.ensureLoaded();
    return this.mem.getStageSession(workflowId, replayKey);
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    this.ensureLoaded();
    return this.mem.listCheckpoints(workflowId);
  }

  getWorkflow(workflowId: string) {
    this.ensureLoaded();
    return this.mem.getWorkflow(workflowId);
  }

  setWorkflowStatus(workflowId: string, status: Parameters<DurableWorkflowBackend["setWorkflowStatus"]>[1], pendingPrompts?: number, resumable?: boolean): void {
    this.ensureLoaded();
    this.assertWritable();
    this.mem.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    this.persist();
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
    withDurableFileLock(this.filePath, () => {
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
      deleted.add(workflowId);
      const merged = mergeRecords(stored, this.mem.exportAll())
        .filter((record) => !deleted.has(record.handle.workflowId));
      const state = currentState(merged, deleted);
      this.writeState(this.filePath, state);
      this.replaceMirror(state);
    });
  }

  isWorkflowLoadable(workflowId: string): boolean {
    this.ensureLoaded();
    this.refreshCompatibilityFromDisk();
    return !this.suppressedAll && !this.deletedWorkflowIds.has(workflowId);
  }

  reset(): void {
    this.mem.reset();
    this.unknownState = false;
    this.suppressedAll = false;
    this.deletedWorkflowIds.clear();
    this.revivedWorkflowIds.clear();
    withDurableFileLock(this.filePath, () => this.writeState(this.filePath, emptyState()));
  }
}

export class WorkflowFileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly dir: string;
  private readonly fileBackends = new Map<string, FileDurableBackend>();
  private readonly suppressedIds = new Set<string>();

  constructor(dir: string) { this.dir = dir; }

  registerWorkflow(handle: Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]): void {
    this.backendFor(handle.workflowId).registerWorkflow(handle);
    this.suppressedIds.delete(handle.workflowId);
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void { this.backendFor(checkpoint.workflowId).recordCheckpoint(checkpoint); }
  getToolOutput(workflowId: string, argsHash: string) { return this.backendFor(workflowId).getToolOutput(workflowId, argsHash); }
  getUiResponse(workflowId: string, promptHash: string) { return this.backendFor(workflowId).getUiResponse(workflowId, promptHash); }
  getStageOutput(workflowId: string, replayKey: string) { return this.backendFor(workflowId).getStageOutput(workflowId, replayKey); }
  getStageSession(workflowId: string, replayKey: string) { return this.backendFor(workflowId).getStageSession(workflowId, replayKey); }
  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] { return this.backendFor(workflowId).listCheckpoints(workflowId); }
  getWorkflow(workflowId: string) { return this.backendFor(workflowId).getWorkflow(workflowId); }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    const backend = this.backendFor(workflowId);
    backend.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    if (isPrunableTerminalStatus(status, resumable)
      && backend.isWorkflowLoadable(workflowId)
      && backend.getWorkflow(workflowId) !== undefined) this.removeWorkflowFile(workflowId);
  }

  listResumableWorkflows() {
    const mem = new InMemoryDurableBackend();
    mem.importAll(mergeRecords([], this.readAllRecords()));
    return mem.listResumableWorkflows();
  }

  listCompletedWorkflows() {
    const mem = new InMemoryDurableBackend();
    mem.importAll(mergeRecords([], this.readAllRecords()));
    return mem.listCompletedWorkflows();
  }

  toCacheEntry(workflowId: string) { return this.backendFor(workflowId).toCacheEntry(workflowId); }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.backendFor(workflowId).deleteWorkflow(workflowId);
    this.suppressedIds.add(workflowId);
  }

  isWorkflowLoadable(workflowId: string): boolean {
    const filePath = durableStateFileFor(this.dir, workflowId);
    const ownState = readDurableFileState(filePath);
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
    this.fileBackends.clear();
    this.suppressedIds.clear();
    for (const filePath of this.stateFiles()) this.removeStateFile(filePath);
    for (const lockPath of this.lockDirs()) rmSync(lockPath, { recursive: true, force: true });
  }

  private backendFor(workflowId: string): FileDurableBackend {
    return this.backendForFile(durableStateFileFor(this.dir, workflowId), workflowId);
  }

  private backendForFile(filePath: string, expectedWorkflowId: string): FileDurableBackend {
    const existing = this.fileBackends.get(filePath);
    if (existing !== undefined) return existing;
    const backend = new FileDurableBackend(filePath, expectedWorkflowId);
    this.fileBackends.set(filePath, backend);
    return backend;
  }

  private stateFiles(): readonly string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json"))
        .map((entry) => `${this.dir}/${entry.name}`);
    } catch { return []; }
  }

  private lockDirs(): readonly string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json.lock"))
        .map((entry) => `${this.dir}/${entry.name}`);
    } catch { return []; }
  }

  private readAllRecords(): readonly FileDurableRecord[] {
    return this.stateFiles().flatMap((filePath) => {
      const workflowId = workflowIdFromStateFile(this.dir, filePath);
      if (workflowId === undefined) return [];
      const result = readDurableFileState(filePath);
      const embeddedIds = result.kind === "current"
        ? [...result.state.workflows.map((record) => record.handle.workflowId), ...result.state.deletedWorkflowIds]
        : result.kind === "legacy" ? result.workflowIds : [];
      const mismatched = embeddedIds.filter((id) => id !== workflowId);
      if (mismatched.length > 0) {
        this.suppressedIds.add(workflowId);
        mismatched.forEach((id) => this.suppressedIds.add(id));
        this.backendForFile(filePath, workflowId).isWorkflowLoadable(workflowId);
        return [];
      }
      const backend = this.backendForFile(filePath, workflowId);
      if (!backend.isWorkflowLoadable(workflowId)) {
        this.suppressedIds.add(workflowId);
        return [];
      }
      this.suppressedIds.delete(workflowId);
      const current = readDurableFileState(filePath);
      if (current.kind !== "current" || !stateMatchesWorkflowId(current.state, workflowId)) return [];
      return current.state.workflows.filter((record) => !current.state.deletedWorkflowIds.includes(record.handle.workflowId));
    });
  }

  private removeWorkflowFile(workflowId: string): void { this.removeStateFile(durableStateFileFor(this.dir, workflowId)); }

  private removeStateFile(filePath: string): void {
    this.fileBackends.delete(filePath);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}.lock`, { recursive: true, force: true });
  }
}

function workflowIdFromStateFile(dir: string, filePath: string): string | undefined {
  const prefix = `${dir}/workflow-`;
  if (!filePath.startsWith(prefix) || !filePath.endsWith(".json")) return undefined;
  try { return decodeURIComponent(filePath.slice(prefix.length, -".json".length)); }
  catch { return undefined; }
}


function emptyState(deletedWorkflowIds: readonly string[] = []): FileDurableState {
  return { version: FILE_FORMAT_VERSION, workflows: [], deletedWorkflowIds };
}

function currentState(records: readonly FileDurableRecord[], deleted: ReadonlySet<string>): FileDurableState {
  return { version: FILE_FORMAT_VERSION, workflows: records, deletedWorkflowIds: [...deleted] };
}

function stateMatchesWorkflowId(state: FileDurableState, workflowId: string): boolean {
  return state.workflows.every((record) => record.handle.workflowId === workflowId)
    && state.deletedWorkflowIds.every((id) => id === workflowId);
}
function isPrunableTerminalStatus(status: DurableWorkflowStatus, resumable?: boolean): boolean {
  if (status === "cancelled") return true;
  return (status === "failed" || status === "blocked") && resumable === false;
}

function mergeRecords(a: readonly FileDurableRecord[], b: readonly FileDurableRecord[]): readonly FileDurableRecord[] {
  const byWorkflow = new Map<string, { handle: DurableWorkflowHandle; checkpoints: Map<string, DurableCheckpoint> }>();
  for (const rec of [...a, ...b]) {
    const existing = byWorkflow.get(rec.handle.workflowId);
    const handle = existing === undefined || rec.handle.updatedAt >= existing.handle.updatedAt ? rec.handle : existing.handle;
    const checkpoints = existing?.checkpoints ?? new Map<string, DurableCheckpoint>();
    for (const cp of rec.checkpoints) checkpoints.set(`${cp.kind}:${cp.checkpointId}`, cp);
    byWorkflow.set(rec.handle.workflowId, { handle, checkpoints });
  }
  return [...byWorkflow.values()].map((rec) => ({ handle: rec.handle, checkpoints: [...rec.checkpoints.values()] }));
}

export function defaultDurableStateDir(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home === undefined || home.length === 0 ? undefined : `${home}/.atomic/workflow-durable`;
}

export function durableStateFileFor(dir: string, workflowId: string): string {
  return `${dir}/workflow-${encodeURIComponent(workflowId)}.json`;
}
