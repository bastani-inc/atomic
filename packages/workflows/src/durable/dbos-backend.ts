/** DBOS-backed durable backend adapter, loaded only when configured. */

import type { DurableCheckpoint, DurableCheckpointEntry, DurableWorkflowHandle, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkflowSerializableObject as DurableInputs } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend, type WorkflowRegistrationInput } from "./backend.js";
import { encodeCheckpoint, decodeToCheckpoint } from "./dbos-envelope.js";

// ---------------------------------------------------------------------------
// SDK abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction over the real `@dbos-inc/dbos-sdk` so the adapter is testable
 * without Postgres. The real factory (`createRealDbosHandle`) wraps the SDK;
 * tests supply a mock.
 */
export interface DbosSdkHandle {
  readonly launch: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly startWorkflow: (workflowId: string, name: string, inputs: Readonly<Record<string, WorkflowSerializableValue>>) => Promise<void>;
  readonly retrieveWorkflow: (workflowId: string) => Promise<DbosWorkflowInfo | undefined>;
  readonly cancelWorkflow: (workflowId: string) => Promise<void>;
  readonly resumeWorkflow: (workflowId: string) => Promise<void>;
  /** List all workflows (any status) with loaded inputs. */
  readonly listAllWorkflows: () => Promise<readonly DbosWorkflowInfo[]>;
  /** List all completed checkpoint step-records for a workflow. */
  readonly listStepRecords: (workflowId: string) => Promise<readonly DbosStepRecord[]>;
  /** Record a checkpoint step output (envelope) to DBOS. */
  readonly recordStepOutput: (workflowId: string, stepName: string, output: WorkflowSerializableValue) => Promise<void>;
}

export interface DbosWorkflowInfo {
  readonly workflowId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
  readonly inputs?: DurableInputs;
}

/** A completed checkpoint stored in DBOS, returned by `listStepRecords`. */
export interface DbosStepRecord {
  readonly stepName: string;
  readonly output: WorkflowSerializableValue;
  readonly completedAt?: number;
}

// ---------------------------------------------------------------------------
// Real SDK handle factory (lazy import, no top-level dependency)
// ---------------------------------------------------------------------------

interface DbosWorkflowHandle {
  readonly workflowID?: string;
  getStatus(): Promise<DbosStatus | null>;
  getResult(): Promise<WorkflowSerializableValue>;
}

interface DbosStatus {
  readonly workflowID?: string;
  readonly workflowId?: string;
  readonly workflowName?: string;
  readonly name?: string;
  readonly status?: string;
  readonly createdAt?: number;
  readonly input?: readonly WorkflowSerializableValue[];
}

interface DbosStatic {
  setConfig(config: Record<string, WorkflowSerializableValue>): void;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
  registerWorkflow<Args extends readonly WorkflowSerializableValue[]>(
    fn: (...args: Args) => Promise<WorkflowSerializableValue>,
    config?: { readonly name?: string },
  ): (...args: Args) => Promise<WorkflowSerializableValue>;
  startWorkflow<Args extends readonly WorkflowSerializableValue[]>(
    target: (...args: Args) => Promise<WorkflowSerializableValue>,
    params?: { readonly workflowID?: string },
  ): (...args: Args) => Promise<DbosWorkflowHandle>;
  retrieveWorkflow(workflowId: string): DbosWorkflowHandle;
  resumeWorkflow(workflowId: string): Promise<DbosWorkflowHandle>;
  cancelWorkflow(workflowId: string, options?: { readonly cancelChildren?: boolean }): Promise<void>;
  listWorkflows(input: Record<string, WorkflowSerializableValue>): Promise<readonly DbosStatus[]>;
}

export function isDbosConfigured(): boolean {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  return typeof url === "string" && url.length > 0;
}

export async function createDbosDurableBackend(config?: { readonly systemDatabaseUrl?: string }): Promise<DurableWorkflowBackend> {
  const sdk = await importDbosSdk();
  const url = config?.systemDatabaseUrl ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  if (url === undefined || url.length === 0) throw new Error("DBOS_SYSTEM_DATABASE_URL is required for DBOS workflow durability.");
  sdk.setConfig({ name: "atomic-workflows", systemDatabaseUrl: url, runAdminServer: false });
  const mainWorkflow = sdk.registerWorkflow(async (_name: string, inputs: DurableInputs) => inputs, { name: "atomicWorkflowHandle" });
  const checkpointWorkflow = sdk.registerWorkflow(async (_workflowId: string, _stepName: string, output: WorkflowSerializableValue) => output, { name: "atomicWorkflowCheckpoint" });
  await sdk.launch();
  return new DbosDurableBackend(createRealDbosHandle(sdk, mainWorkflow, checkpointWorkflow));
}

async function importDbosSdk(): Promise<DbosStatic> {
  const spec = "@dbos-inc/dbos-sdk";
  try {
    const mod = await import(spec);
    const dbos = (mod as { readonly DBOS?: DbosStatic }).DBOS;
    if (dbos === undefined) throw new Error("@dbos-inc/dbos-sdk did not export DBOS");
    return dbos;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DBOS workflow durability is configured but @dbos-inc/dbos-sdk could not be loaded: ${msg}`);
  }
}

function createRealDbosHandle(
  dbos: DbosStatic,
  mainWorkflow: (name: string, inputs: Record<string, WorkflowSerializableValue>) => Promise<WorkflowSerializableValue>,
  checkpointWorkflow: (workflowId: string, stepName: string, output: WorkflowSerializableValue) => Promise<WorkflowSerializableValue>,
): DbosSdkHandle {
  const checkpointId = (workflowId: string, stepName: string): string => `${workflowId}:checkpoint:${stepName}`;
  return {
    launch: () => dbos.launch(),
    shutdown: () => dbos.shutdown(),
    async startWorkflow(workflowId, name, inputs) {
      try {
        await dbos.startWorkflow(mainWorkflow, { workflowID: workflowId })(name, { ...inputs });
      } catch (err) {
        if (!isDbosDuplicateWorkflowError(err)) throw err;
      }
    },
    async retrieveWorkflow(workflowId) {
      const statuses = await dbos.listWorkflows({ workflowIDs: [workflowId], loadInput: true, limit: 1 });
      const status = statuses[0];
      if (status === undefined) return undefined;
      return statusToInfo(status, workflowId);
    },
    async cancelWorkflow(workflowId) { await dbos.cancelWorkflow(workflowId, { cancelChildren: true }); },
    async resumeWorkflow(workflowId) { await dbos.resumeWorkflow(workflowId); },
    async listAllWorkflows() {
      const statuses = await dbos.listWorkflows({ workflowName: "atomicWorkflowHandle", loadInput: true, sortDesc: true });
      return statuses.map((s) => statusToInfo(s, s.workflowID ?? s.workflowId ?? ""));
    },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:checkpoint:`;
      const statuses = await dbos.listWorkflows({ workflow_id_prefix: prefix, loadOutput: true, sortDesc: false });
      const records: DbosStepRecord[] = [];
      for (const s of statuses) {
        if (s.status !== "SUCCESS") continue;
        const wid = s.workflowID ?? s.workflowId ?? "";
        const stepName = wid.slice(prefix.length);
        if (stepName.length === 0) continue;
        const handle = dbos.retrieveWorkflow(wid);
        const output = await handle.getResult();
        records.push({ stepName, output, completedAt: s.createdAt });
      }
      return records;
    },
    async recordStepOutput(workflowId, stepName, output) {
      await dbos.startWorkflow(checkpointWorkflow, { workflowID: checkpointId(workflowId, stepName) })(workflowId, stepName, output);
    },
  };
}

function isDbosDuplicateWorkflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate|conflict|already/i.test(msg);
}

function statusToInfo(status: DbosStatus, fallbackId: string): DbosWorkflowInfo {
  const info: DbosWorkflowInfo = {
    workflowId: status.workflowID ?? status.workflowId ?? fallbackId,
    name: status.workflowName ?? status.name ?? "atomicWorkflowHandle",
    status: status.status ?? "PENDING",
    createdAt: status.createdAt ?? Date.now(),
  };
  // Inputs were passed as (name, inputs) to the main workflow; extract the
  // inputs object from the second positional argument.
  if (status.input !== undefined && status.input.length >= 2) {
    const inputs = status.input[1];
    if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
      return { ...info, inputs: inputs as DurableInputs };
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Backend adapter
// ---------------------------------------------------------------------------

/**
 * DBOS-backed durable backend. Wraps a {@link DbosSdkHandle} to implement the
 * {@link DurableWorkflowBackend} interface. Writes are serialized to DBOS
 * with an in-memory mirror for synchronous queries. A fresh process hydrates
 * its mirror from DBOS via {@link hydrateWorkflow} / {@link hydrateResumableWorkflows}
 * before resume/replay reads.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */
export class DbosDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly mem = new InMemoryDurableBackend();
  private readonly sdk: DbosSdkHandle;
  private readonly hydrated = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: Error[] = [];

  constructor(sdk: DbosSdkHandle) {
    this.sdk = sdk;
  }

  registerWorkflow(handle: WorkflowRegistrationInput): void {
    this.mem.registerWorkflow(handle);
    this.enqueueWrite(async () => {
      await this.sdk.startWorkflow(handle.workflowId, handle.name, handle.inputs);
      await this.writeMetadata(handle.workflowId);
    });
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.mem.recordCheckpoint(checkpoint);
    this.enqueueWrite(() => this.persistCheckpoint(checkpoint));
  }

  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.persistCheckpointRecord(checkpoint);
      this.mem.recordCheckpoint(checkpoint);
      await this.writeMetadata(checkpoint.workflowId);
    });
  }

  private async persistCheckpoint(checkpoint: DurableCheckpoint): Promise<void> {
    await this.persistCheckpointRecord(checkpoint);
    await this.writeMetadata(checkpoint.workflowId);
  }

  private async persistCheckpointRecord(checkpoint: DurableCheckpoint): Promise<void> {
    const stepName = checkpoint.kind === "stage" ? checkpoint.replayKey : checkpoint.checkpointId;
    await this.sdk.recordStepOutput(checkpoint.workflowId, stepName, encodeCheckpoint(checkpoint));
  }

  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined { return this.mem.getToolOutput(workflowId, argsHash); }
  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined { return this.mem.getUiResponse(workflowId, promptHash); }
  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined { return this.mem.getStageOutput(workflowId, replayKey); }
  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] { return this.mem.listCheckpoints(workflowId); }
  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined { return this.mem.getWorkflow(workflowId); }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number): void {
    this.mem.setWorkflowStatus(workflowId, status, pendingPrompts);
    this.enqueueWrite(async () => {
      if (status === "cancelled") await this.sdk.cancelWorkflow(workflowId);
      else if (status === "running") await this.sdk.resumeWorkflow(workflowId);
      await this.writeMetadata(workflowId);
    });
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] { return this.mem.listResumableWorkflows(); }
  toCacheEntry(workflowId: string) { return this.mem.toCacheEntry(workflowId); }
  reset(): void { this.mem.reset(); this.hydrated.clear(); this.writeQueue = Promise.resolve(); this.writeErrors = []; }
  async flush(): Promise<void> {
    await this.writeQueue;
    if (this.writeErrors.length === 0) return;
    const [first] = this.writeErrors;
    this.writeErrors = [];
    throw first;
  }

  /**
   * Hydrate a single workflow's handle and checkpoints from DBOS into the
   * in-memory mirror. Idempotent: skips workflows already hydrated with
   * checkpoints. Safe to call before synchronous replay reads.
   */
  async hydrateWorkflow(workflowId: string): Promise<void> {
    if (this.hydrated.has(workflowId) && this.mem.getWorkflow(workflowId) !== undefined) return;
    const info = await this.sdk.retrieveWorkflow(workflowId);
    if (info !== undefined && this.mem.getWorkflow(workflowId) === undefined) {
      this.mem.registerWorkflow({
        workflowId: info.workflowId,
        name: info.name,
        inputs: info.inputs ?? {},
        createdAt: info.createdAt,
        status: dbosStatusToDurable(info.status),
      });
    }
    const stepRecords = await this.sdk.listStepRecords(workflowId);
    this.applyMetadata(workflowId, stepRecords);
    for (const rec of stepRecords) {
      if (isMetadataStep(rec.stepName)) continue;
      const cp = decodeToCheckpoint(workflowId, rec.stepName, rec.output);
      if (cp !== undefined) this.mem.recordCheckpoint(cp);
    }
    this.hydrated.add(workflowId);
  }

  /**
   * Hydrate all resumable workflows from DBOS into the in-memory mirror.
   * Called by the resume/list path before enumerating resumable entries so
   * a fresh process discovers workflows persisted by a prior session.
   */
  async hydrateResumableWorkflows(): Promise<void> {
    const all = await this.sdk.listAllWorkflows();
    for (const info of all) {
      if (this.mem.getWorkflow(info.workflowId) === undefined) {
        this.mem.registerWorkflow({
          workflowId: info.workflowId,
          name: info.name,
          inputs: info.inputs ?? {},
          createdAt: info.createdAt,
          status: dbosStatusToDurable(info.status),
        });
      }
      if (!this.hydrated.has(info.workflowId)) {
        const stepRecords = await this.sdk.listStepRecords(info.workflowId);
        this.applyMetadata(info.workflowId, stepRecords);
        for (const rec of stepRecords) {
          if (isMetadataStep(rec.stepName)) continue;
          const cp = decodeToCheckpoint(info.workflowId, rec.stepName, rec.output);
          if (cp !== undefined) this.mem.recordCheckpoint(cp);
        }
        this.hydrated.add(info.workflowId);
      }
    }
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.writeErrors.push(error);
      console.warn(`atomic-workflows: DBOS durable write failed: ${error.message}`);
    });
    return next;
  }

  private async writeMetadata(workflowId: string): Promise<void> {
    const entry = this.mem.toCacheEntry(workflowId);
    if (entry === undefined) return;
    await this.sdk.recordStepOutput(workflowId, metadataStepName(entry.ts), encodeMetadata(entry));
  }

  private applyMetadata(workflowId: string, records: readonly DbosStepRecord[]): void {
    const entries = records
      .filter((r) => isMetadataStep(r.stepName))
      .map((r) => decodeMetadata(r.output))
      .filter((entry): entry is DurableCheckpointEntry => entry !== undefined)
      .sort((a, b) => a.ts - b.ts);
    const entry = entries.at(-1);
    if (entry === undefined) return;
    this.mem.registerWorkflow({
      workflowId,
      name: entry.name,
      inputs: entry.inputs,
      createdAt: entry.ts,
      updatedAt: entry.ts,
      status: entry.status,
      completedCheckpoints: entry.completedCheckpoints,
      pendingPrompts: entry.pendingPrompts,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.rootWorkflowId !== undefined ? { rootWorkflowId: entry.rootWorkflowId } : {}),
      ...(entry.resumable !== undefined ? { resumable: entry.resumable } : {}),
    });
  }
}

const METADATA_STEP_PREFIX = "__atomic_metadata";
const METADATA_VERSION = 1;

function metadataStepName(ts: number): string {
  return `${METADATA_STEP_PREFIX}:${ts}:${crypto.randomUUID()}`;
}

function isMetadataStep(stepName: string): boolean {
  return stepName === METADATA_STEP_PREFIX || stepName.startsWith(`${METADATA_STEP_PREFIX}:`);
}

interface DbosMetadataEnvelope {
  readonly __atomicDurableMetadata: true;
  readonly version: 1;
  readonly entry: DurableCheckpointEntry;
}

function encodeMetadata(entry: DurableCheckpointEntry): WorkflowSerializableValue {
  return {
    __atomicDurableMetadata: true,
    version: METADATA_VERSION,
    entry: {
      type: entry.type,
      workflowId: entry.workflowId,
      name: entry.name,
      inputs: entry.inputs,
      status: entry.status,
      completedCheckpoints: entry.completedCheckpoints,
      pendingPrompts: entry.pendingPrompts,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.rootWorkflowId !== undefined ? { rootWorkflowId: entry.rootWorkflowId } : {}),
      ...(entry.resumable !== undefined ? { resumable: entry.resumable } : {}),
      ts: entry.ts,
    },
  };
}

function decodeMetadata(value: WorkflowSerializableValue): DurableCheckpointEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Partial<DbosMetadataEnvelope>;
  if (raw.__atomicDurableMetadata !== true || raw.version !== METADATA_VERSION) return undefined;
  return raw.entry;
}

function dbosStatusToDurable(status: string): DurableWorkflowStatus {
  switch (status) {
    case "SUCCESS": return "completed";
    case "ERROR": return "failed";
    case "CANCELLED": return "cancelled";
    case "PENDING":
    case "ENQUEUED":
    case "DELAYED":
      return "running";
    default: return "running";
  }
}
