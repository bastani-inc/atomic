/** DBOS-backed durable backend adapter, loaded only when configured. */

import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkflowSerializableObject as DurableInputs } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend, type WorkflowRegistrationInput } from "./backend.js";
import { encodeCheckpoint, classifyCheckpointPayload } from "./dbos-envelope.js";
import { classifyLatestMetadata, encodeMetadata, isMetadataStep, metadataStepName } from "./dbos-metadata.js";
import { inactivePromptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";
import { DBOS_DELETION_STEP, classifyDbosDeletionTombstone, encodeDbosDeletionTombstone } from "./dbos-tombstone.js";
import {
  DbosPromptReservationTracker,
  isDbosPromptStateStep,
} from "./dbos-prompt-reservations.js";

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
  /** Permanently delete a root workflow and all prefix checkpoint records. */
  readonly deleteWorkflowData: (workflowId: string) => Promise<void>;
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
  deleteWorkflows(workflowIds: string[], deleteChildren?: boolean): Promise<void>;
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
      try {
        await dbos.startWorkflow(checkpointWorkflow, { workflowID: checkpointId(workflowId, stepName) })(workflowId, stepName, output);
      } catch (err) {
        if (!isDbosDuplicateWorkflowError(err)) throw err;
      }
    },
    async deleteWorkflowData(workflowId) {
      const prefix = `${workflowId}:checkpoint:`;
      const checkpointIds: string[] = [];
      const pageSize = 1_000;
      for (let offset = 0;; offset += pageSize) {
        const page = await dbos.listWorkflows({ workflow_id_prefix: prefix, limit: pageSize, offset });
        checkpointIds.push(...page.map((status) => status.workflowID ?? status.workflowId ?? "").filter((id) => id.length > 0));
        if (page.length < pageSize) break;
      }
      await dbos.deleteWorkflows([...new Set([workflowId, ...checkpointIds])], true);
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
  private readonly incompatible = new Set<string>();
  private readonly compatible = new Set<string>();
  private readonly locallyRegistered = new Set<string>();
  private readonly promptReservations: DbosPromptReservationTracker;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: Error[] = [];

  constructor(sdk: DbosSdkHandle) {
    this.sdk = sdk;
    this.promptReservations = new DbosPromptReservationTracker({
      pendingPrompts: (workflowId) => this.mem.getWorkflow(workflowId)?.pendingPrompts ?? 0,
      adjustPendingPrompts: (workflowId, delta) => this.mem.adjustPendingPrompts(workflowId, delta),
      persist: (workflowId, stepName, output) => {
        this.enqueueWrite(() => this.sdk.recordStepOutput(workflowId, stepName, output));
      },
    });
  }

  registerWorkflow(handle: WorkflowRegistrationInput): void {
    this.incompatible.delete(handle.workflowId);
    this.compatible.add(handle.workflowId);
    this.locallyRegistered.add(handle.workflowId);
    this.promptReservations.register(handle.workflowId, handle.pendingPrompts ?? 0);
    this.mem.registerWorkflow(handle);
    this.enqueueWrite(async () => {
      await this.sdk.startWorkflow(handle.workflowId, handle.name, handle.inputs);
      await this.writeMetadata(handle.workflowId);
    });
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
    this.mem.recordCheckpoint(checkpoint);
    this.enqueueWrite(() => this.persistCheckpoint(checkpoint));
  }

  async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
    if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
    await this.enqueueWrite(async () => {
      if (!this.isWorkflowLoadable(checkpoint.workflowId)) return;
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
    await this.sdk.recordStepOutput(checkpoint.workflowId, checkpoint.checkpointId, encodeCheckpoint(checkpoint));
  }

  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined { return this.mem.getToolOutput(workflowId, argsHash); }
  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined { return this.mem.getUiResponse(workflowId, promptHash); }
  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined { return this.mem.getStageOutput(workflowId, replayKey); }
  getStageSession(workflowId: string, replayKey: string) { return this.mem.getStageSession(workflowId, replayKey); }
  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] { return this.mem.listCheckpoints(workflowId); }
  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined { return this.mem.getWorkflow(workflowId); }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): void {
    if (!this.isWorkflowLoadable(workflowId)) return;
    if (pendingPrompts !== undefined) {
      this.promptReservations.setBaseline(workflowId, pendingPrompts);
    }
    this.mem.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
    this.enqueueWrite(async () => {
      if (!this.isWorkflowLoadable(workflowId)) return;
      if (status === "cancelled") await this.sdk.cancelWorkflow(workflowId);
      else if (status === "running") await this.sdk.resumeWorkflow(workflowId);
      await this.writeMetadata(workflowId);
    });
  }

  adjustPendingPrompts(workflowId: string, delta: number): void {
    if (!this.isWorkflowLoadable(workflowId)) return;
    this.promptReservations.adjust(workflowId, delta);
  }

  promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string } {
    return { rootWorkflowId: workflowId, scope: "root" };
  }

  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined {
    return this.isWorkflowLoadable(workflowId) ? this.promptReservations.token(workflowId, reservationId) : undefined;
  }

  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken {
    if (!this.isWorkflowLoadable(workflowId)) return inactivePromptReservationToken(reservationId);
    return this.promptReservations.reserve(workflowId, reservationId);
  }

  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    if (this.isWorkflowLoadable(workflowId)) this.promptReservations.release(workflowId, reservationId, token);
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
    return this.mem.listResumableWorkflows().filter((entry) => !this.incompatible.has(entry.workflowId));
  }
  listCompletedWorkflows(): readonly ResumableWorkflowEntry[] {
    return this.mem.listCompletedWorkflows().filter((entry) => !this.incompatible.has(entry.workflowId));
  }
  toCacheEntry(workflowId: string) { return this.incompatible.has(workflowId) ? undefined : this.mem.toCacheEntry(workflowId); }
  async deleteWorkflow(workflowId: string): Promise<void> {
    this.incompatible.add(workflowId);
    this.compatible.delete(workflowId);
    this.locallyRegistered.delete(workflowId);
    this.hydrated.delete(workflowId);
    this.promptReservations.delete(workflowId);
    await this.mem.deleteWorkflow(workflowId);
    await this.enqueueWrite(async () => {
      await this.sdk.deleteWorkflowData(workflowId);
      await this.sdk.recordStepOutput(workflowId, DBOS_DELETION_STEP, encodeDbosDeletionTombstone(workflowId));
    });
  }
  isWorkflowLoadable(workflowId: string): boolean {
    return !this.incompatible.has(workflowId)
      && (this.locallyRegistered.has(workflowId) || this.compatible.has(workflowId));
  }
  reset(): void {
    this.mem.reset();
    this.hydrated.clear();
    this.incompatible.clear();
    this.compatible.clear();
    this.locallyRegistered.clear();
    this.promptReservations.clear();
    this.writeQueue = Promise.resolve();
    this.writeErrors = [];
  }

  async flush(): Promise<void> {
    await this.writeQueue;
    if (this.writeErrors.length === 0) return;
    const [first] = this.writeErrors;
    this.writeErrors = [];
    throw first;
  }

  async hydrateWorkflow(workflowId: string): Promise<void> {
    if (this.locallyRegistered.has(workflowId)) return;
    const info = await this.sdk.retrieveWorkflow(workflowId);
    if (info !== undefined) {
      await this.hydrateInfo(info);
      return;
    }
    const records = await this.sdk.listStepRecords(workflowId);
    const deletion = classifyDbosDeletionTombstone(records, workflowId);
    if (deletion !== "absent") await this.suppressWorkflow(workflowId);
  }

  async hydrateResumableWorkflows(): Promise<void> {
    const all = await this.sdk.listAllWorkflows();
    for (const info of all) {
      if (this.locallyRegistered.has(info.workflowId)) continue;
      await this.hydrateInfo(info);
    }
  }

  private async hydrateInfo(info: DbosWorkflowInfo): Promise<void> {
    const records = await this.sdk.listStepRecords(info.workflowId);
    const metadata = classifyLatestMetadata(records, info.workflowId);
    if (metadata.kind === "legacy") {
      await this.cleanupLegacyWorkflow(info.workflowId);
      return;
    }
    if (metadata.kind !== "current") {
      await this.suppressWorkflow(info.workflowId);
      return;
    }
    const checkpoints: DurableCheckpoint[] = [];
    for (const record of records) {
      if (isMetadataStep(record.stepName) || isDbosPromptStateStep(record.stepName)
        || record.stepName === DBOS_DELETION_STEP) continue;
      const classified = classifyCheckpointPayload(info.workflowId, record.stepName, record.output);
      if (classified.kind === "legacy") {
        await this.cleanupLegacyWorkflow(info.workflowId);
        return;
      }
      if (classified.kind === "unknown") {
        await this.suppressWorkflow(info.workflowId);
        return;
      }
      checkpoints.push(classified.checkpoint);
    }
    await this.mem.deleteWorkflow(info.workflowId);
    this.incompatible.delete(info.workflowId);
    this.compatible.add(info.workflowId);
    this.applyMetadata(info.workflowId, metadata.entry);
    checkpoints.forEach((checkpoint) => this.mem.recordCheckpoint(checkpoint));
    const current = this.mem.getWorkflow(info.workflowId);
    if (current !== undefined) {
      const pendingPrompts = this.promptReservations.hydrate(
        info.workflowId,
        metadata.entry.pendingPrompts,
        records,
      );
      this.mem.setWorkflowStatus(info.workflowId, current.status, pendingPrompts, current.resumable);
    }
    this.hydrated.add(info.workflowId);
  }

  private async cleanupLegacyWorkflow(workflowId: string): Promise<void> {
    try {
      await this.deleteWorkflow(workflowId);
    } catch {
      // deleteWorkflow marks the in-memory mirror incompatible before durable
      // cleanup. Its write queue records/logs the error, while hydration must
      // still return a filtered catalog and allow later discovery to retry.
    }
  }

  private async suppressWorkflow(workflowId: string): Promise<void> {
    this.incompatible.add(workflowId);
    this.compatible.delete(workflowId);
    this.hydrated.delete(workflowId);
    this.promptReservations.delete(workflowId);
    await this.mem.deleteWorkflow(workflowId);
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
    const metadata = {
      ...entry,
      pendingPrompts: this.promptReservations.metadataPendingPrompts(workflowId, entry.pendingPrompts),
    };
    await this.sdk.recordStepOutput(workflowId, metadataStepName(entry.ts), encodeMetadata(metadata));
  }

  private applyMetadata(workflowId: string, entry: import("./types.js").DurableCheckpointEntry): void {
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
      ...(entry.invocationCwd !== undefined ? { invocationCwd: entry.invocationCwd } : {}),
      ...(entry.workflowCwd !== undefined ? { workflowCwd: entry.workflowCwd } : {}),
      ...(entry.repositoryRoot !== undefined ? { repositoryRoot: entry.repositoryRoot } : {}),
      ...(entry.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: entry.gitWorktreeRoot } : {}),
    });
  }
}

// Metadata encoding/classification lives in dbos-metadata.ts to keep this adapter focused.
