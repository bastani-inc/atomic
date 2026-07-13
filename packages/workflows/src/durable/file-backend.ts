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

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";
import { withFileLock } from "./file-lock.js";
import { claimExecutionLease, executionLeasePath, hasActiveExecutionLease, releaseExecutionLease } from "./execution-lease.js";

interface FileDurableRecord {
  readonly handle: DurableWorkflowHandle;
  readonly checkpoints: readonly DurableCheckpoint[];
}

interface FileDurableState {
  readonly version: number;
  readonly workflows: readonly FileDurableRecord[];
}


const FILE_FORMAT_VERSION = 1;

export class FileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly mem = new InMemoryDurableBackend();
  private readonly filePath: string;
  private loaded = false;
  private readonly executionToken = `${process.pid}-${randomUUID()}`;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.mem.importAll(readState(this.filePath).workflows);
  }

  private persist(): void {
    withFileLock(this.filePath, () => {
      const merged = mergeRecords(readState(this.filePath).workflows, this.mem.exportAll());
      this.mem.reset();
      this.mem.importAll(merged);
      writeState(this.filePath, { version: FILE_FORMAT_VERSION, workflows: merged });
    });
  }

  registerWorkflow(handle: Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]): void {
    this.ensureLoaded();
    this.mem.registerWorkflow(handle);
    this.persist();
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.ensureLoaded();
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
    this.mem.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    this.persist();
    if (status !== "running") releaseExecutionLease(this.filePath, this.executionToken);
  }

  claimWorkflowExecution(_workflowId: string): boolean {
    return claimExecutionLease(this.filePath, this.executionToken);
  }

  releaseWorkflowExecution(_workflowId: string): void {
    releaseExecutionLease(this.filePath, this.executionToken);
  }

  isWorkflowExecutionActive(_workflowId: string): boolean {
    return hasActiveExecutionLease(this.filePath);
  }

  listActiveWorkflowHandles(): readonly DurableWorkflowHandle[] {
    this.ensureLoaded();
    return hasActiveExecutionLease(this.filePath) ? this.mem.exportAll().map((record) => record.handle) : [];
  }

  listResumableWorkflows() {
    this.ensureLoaded();
    return this.mem.listResumableWorkflows().filter((entry) => !this.isWorkflowExecutionActive(entry.workflowId));
  }

  toCacheEntry(workflowId: string) {
    this.ensureLoaded();
    return this.mem.toCacheEntry(workflowId);
  }

  reset(): void {
    releaseExecutionLease(this.filePath, this.executionToken);
    this.mem.reset();
    withFileLock(this.filePath, () => writeState(this.filePath, { version: FILE_FORMAT_VERSION, workflows: [] }));
  }
}

/**
 * Directory-backed durable backend that stores each root workflow in its own
 * JSON file while preserving the same DurableWorkflowBackend interface.
 */
export class WorkflowFileDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly dir: string;
  private readonly fileBackends = new Map<string, FileDurableBackend>();

  constructor(dir: string) {
    this.dir = dir;
  }

  registerWorkflow(handle: Parameters<DurableWorkflowBackend["registerWorkflow"]>[0]): void {
    this.backendFor(handle.workflowId).registerWorkflow(handle);
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.backendFor(checkpoint.workflowId).recordCheckpoint(checkpoint);
  }

  getToolOutput(workflowId: string, argsHash: string) {
    return this.backendFor(workflowId).getToolOutput(workflowId, argsHash);
  }

  getUiResponse(workflowId: string, promptHash: string) {
    return this.backendFor(workflowId).getUiResponse(workflowId, promptHash);
  }

  getStageOutput(workflowId: string, replayKey: string) {
    return this.backendFor(workflowId).getStageOutput(workflowId, replayKey);
  }

  getStageSession(workflowId: string, replayKey: string) {
    return this.backendFor(workflowId).getStageSession(workflowId, replayKey);
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    return this.backendFor(workflowId).listCheckpoints(workflowId);
  }

  getWorkflow(workflowId: string) {
    return this.backendFor(workflowId).getWorkflow(workflowId);
  }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    const backend = this.backendFor(workflowId);
    backend.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    if (isPrunableTerminalStatus(status, resumable)) this.removeWorkflowFile(workflowId);
  }

  claimWorkflowExecution(workflowId: string): boolean {
    return this.backendFor(workflowId).claimWorkflowExecution(workflowId);
  }

  releaseWorkflowExecution(workflowId: string): void {
    this.backendFor(workflowId).releaseWorkflowExecution(workflowId);
  }

  isWorkflowExecutionActive(workflowId: string): boolean {
    return this.backendFor(workflowId).isWorkflowExecutionActive(workflowId);
  }

  listActiveWorkflowHandles(): readonly DurableWorkflowHandle[] {
    return this.readAllRecords()
      .filter((record) => this.isWorkflowExecutionActive(record.handle.workflowId))
      .map((record) => record.handle);
  }

  listResumableWorkflows() {
    const mem = new InMemoryDurableBackend();
    mem.importAll(mergeRecords([], this.readAllRecords()));
    return mem.listResumableWorkflows().filter((entry) => !this.isWorkflowExecutionActive(entry.workflowId));
  }

  toCacheEntry(workflowId: string) {
    return this.backendFor(workflowId).toCacheEntry(workflowId);
  }

  reset(): void {
    this.fileBackends.clear();
    for (const filePath of this.stateFiles()) this.removeStateFile(filePath);
    for (const lockPath of this.lockDirs()) rmSync(lockPath, { recursive: true, force: true });
  }

  private backendFor(workflowId: string): FileDurableBackend {
    return this.backendForFile(durableStateFileFor(this.dir, workflowId));
  }

  private backendForFile(filePath: string): FileDurableBackend {
    const existing = this.fileBackends.get(filePath);
    if (existing !== undefined) return existing;
    const backend = new FileDurableBackend(filePath);
    this.fileBackends.set(filePath, backend);
    return backend;
  }

  private stateFiles(): readonly string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json"))
        .map((entry) => `${this.dir}/${entry.name}`);
    } catch {
      return [];
    }
  }

  private lockDirs(): readonly string[] {
    try {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json.lock"))
        .map((entry) => `${this.dir}/${entry.name}`);
    } catch {
      return [];
    }
  }

  private readAllRecords(): readonly FileDurableRecord[] {
    return this.stateFiles().flatMap((filePath) => readState(filePath).workflows);
  }

  private removeWorkflowFile(workflowId: string): void {
    this.removeStateFile(durableStateFileFor(this.dir, workflowId));
  }

  private removeStateFile(filePath: string): void {
    this.fileBackends.delete(filePath);
    rmSync(filePath, { force: true });
    rmSync(`${filePath}.lock`, { recursive: true, force: true });
    rmSync(executionLeasePath(filePath), { recursive: true, force: true });
  }
}

function readState(filePath: string): FileDurableState {
  if (!existsSync(filePath)) return { version: FILE_FORMAT_VERSION, workflows: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as FileDurableState;
    return parsed && Array.isArray(parsed.workflows) ? parsed : { version: FILE_FORMAT_VERSION, workflows: [] };
  } catch {
    return { version: FILE_FORMAT_VERSION, workflows: [] };
  }
}

function writeState(filePath: string, state: FileDurableState): void {
  const dir = dirname(filePath);
  ensureSecureDir(dir);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
  chmodBestEffort(tmp, 0o600);
  renameSync(tmp, filePath);
  chmodBestEffort(filePath, 0o600);
}


function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodBestEffort(dir, 0o700);
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // chmod is unavailable or unsupported on some filesystems/platforms.
  }
}

function isPrunableTerminalStatus(status: DurableWorkflowStatus, resumable?: boolean): boolean {
  if (status === "completed" || status === "cancelled") return true;
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
  // encodeURIComponent leaves `*` unescaped even though Windows forbids it
  // in path components. The fixed prefix/suffix avoid reserved device names.
  const encodedId = encodeURIComponent(workflowId).replaceAll("*", "%2A");
  return `${dir}/workflow-${encodedId}.json`;
}
