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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";

interface FileDurableRecord {
  readonly handle: DurableWorkflowHandle;
  readonly checkpoints: readonly DurableCheckpoint[];
}

interface FileDurableState {
  readonly version: number;
  readonly workflows: readonly FileDurableRecord[];
}

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}

const FILE_FORMAT_VERSION = 1;
const LOCK_OWNER_FILE = "owner.json";
const STALE_LOCK_MS = 30_000;

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

  reset(): void {
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

function withFileLock<T>(filePath: string, fn: () => T): T {
  const dir = dirname(filePath);
  ensureSecureDir(dir);
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        chmodBestEffort(lockDir, 0o700);
        writeLockOwner(lockDir);
      } catch (ownerErr) {
        rmSync(lockDir, { recursive: true, force: true });
        throw ownerErr;
      }
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (tryReclaimStaleLock(lockDir, STALE_LOCK_MS)) continue;
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

function tryReclaimStaleLock(lockDir: string, staleMs: number): boolean {
  if (!isStaleLock(lockDir, staleMs)) return false;
  const owner = readLockOwner(lockDir);
  if (owner === undefined || !isLockOwnerAbandoned(owner)) return false;
  const quarantine = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockDir, quarantine);
  } catch {
    return false;
  }
  const quarantinedOwner = readLockOwner(quarantine);
  if (!sameLockOwner(owner, quarantinedOwner)) {
    restoreQuarantinedLock(lockDir, quarantine);
    return false;
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // The stale lock has already been moved away from the active lock path.
  }
  return true;
}

function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    const stat = statSync(lockDir);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function writeLockOwner(lockDir: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    acquiredAt: Date.now(),
  };
  const ownerPath = `${lockDir}/${LOCK_OWNER_FILE}`;
  writeFileSync(ownerPath, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
  chmodBestEffort(ownerPath, 0o600);
}

function readLockOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${lockDir}/${LOCK_OWNER_FILE}`, "utf-8"));
    if (!isLockOwner(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<LockOwner>;
  return typeof record.pid === "number"
    && typeof record.host === "string"
    && typeof record.token === "string"
    && typeof record.acquiredAt === "number";
}

function isLockOwnerAbandoned(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    const code = errorCode(err);
    return code === "ESRCH";
  }
}

function sameLockOwner(a: LockOwner, b: LockOwner | undefined): boolean {
  return b !== undefined && a.pid === b.pid && a.host === b.host && a.token === b.token;
}

function restoreQuarantinedLock(lockDir: string, quarantine: string): void {
  try {
    if (!existsSync(lockDir)) renameSync(quarantine, lockDir);
    else rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // Best-effort: never delete the active lock path after a failed compare.
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
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
