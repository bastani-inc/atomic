/**
 * File-backed durable backend.
 *
 * Persists durable checkpoints to a JSON file so a new Atomic session/process
 * can resume a workflow started in a prior session without requiring Postgres.
 * This is the zero-infrastructure fallback: when `DBOS_SYSTEM_DATABASE_URL` is
 * not set, the engine uses this backend by default.
 *
 * The file format is a single JSON object with `workflows` and `checkpoints`
 * arrays. Writes are atomic (write-to-temp then rename) to avoid corruption.
 *
 * cross-ref: issue #1498 — "Save state in DBOS by caching on session file".
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DurableCheckpoint, DurableWorkflowHandle } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";

interface FileDurableState {
  readonly version: number;
  readonly workflows: readonly { readonly handle: DurableWorkflowHandle; readonly checkpoints: readonly DurableCheckpoint[] }[];
}

const FILE_FORMAT_VERSION = 1;

/**
 * File-backed durable backend. Delegates to an {@link InMemoryDurableBackend}
 * for query logic and persists state to a JSON file on each mutation.
 */
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
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as FileDurableState;
      if (parsed && Array.isArray(parsed.workflows)) {
        this.mem.importAll(parsed.workflows);
      }
    } catch {
      // Corrupt or partial file — start fresh rather than crash.
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state: FileDurableState = { version: FILE_FORMAT_VERSION, workflows: this.mem.exportAll() };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, this.filePath);
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
    if (existsSync(this.filePath)) {
      try { writeFileSync(this.filePath, JSON.stringify({ version: FILE_FORMAT_VERSION, workflows: [] }), "utf-8"); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve the default durable state file path.
 * Uses `ATOMIC_WORKFLOW_DURABLE_DIR` env var or `~/.atomic/workflow-durable/`.
 */
export function defaultDurableStateDir(): string {
  const env = process.env.ATOMIC_WORKFLOW_DURABLE_DIR;
  if (env && env.length > 0) return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.atomic/workflow-durable`;
}

/**
 * Resolve the durable state file path for a specific workflow id.
 * Each workflow gets its own file to keep reads/writes fast.
 */
export function durableStateFileFor(dir: string, workflowId: string): string {
  return `${dir}/${workflowId}.json`;
}
