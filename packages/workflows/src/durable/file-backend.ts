/**
 * File-backed durable backend.
 *
 * Persists durable checkpoints to a JSON file so a new Atomic session/process
 * can resume a workflow started in a prior session without requiring Postgres.
 * Writes use a small lock directory plus read-merge-write to avoid lost updates
 * when multiple Atomic processes update the same durable state file.
 *
 * cross-ref: issue #1498 — durable fallback when DBOS/Postgres is unavailable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DurableCheckpoint, DurableWorkflowHandle } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";

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

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    this.ensureLoaded();
    return this.mem.listCheckpoints(workflowId);
  }

  getWorkflow(workflowId: string) {
    this.ensureLoaded();
    return this.mem.getWorkflow(workflowId);
  }

  setWorkflowStatus(workflowId: string, status: Parameters<DurableWorkflowBackend["setWorkflowStatus"]>[1], pendingPrompts?: number): void {
    this.ensureLoaded();
    this.mem.setWorkflowStatus(workflowId, status, pendingPrompts);
    this.persist();
  }

  listResumableWorkflows() {
    this.ensureLoaded();
    return this.mem.listResumableWorkflows();
  }

  toCacheEntry(workflowId: string) {
    this.ensureLoaded();
    return this.mem.toCacheEntry(workflowId);
  }

  reset(): void {
    this.mem.reset();
    withFileLock(this.filePath, () => writeState(this.filePath, { version: FILE_FORMAT_VERSION, workflows: [] }));
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, filePath);
}

function withFileLock<T>(filePath: string, fn: () => T): T {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`Timed out acquiring durable workflow state lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
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

export function defaultDurableStateDir(): string {
  const env = process.env.ATOMIC_WORKFLOW_DURABLE_DIR;
  if (env && env.length > 0) return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.atomic/workflow-durable`;
}

export function durableStateFileFor(dir: string, workflowId: string): string {
  return `${dir}/${workflowId}.json`;
}
