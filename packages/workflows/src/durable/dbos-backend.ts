/** DBOS-backed durable backend adapter. */

import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkflowSerializableObject as DurableInputs } from "./types.js";
import { InMemoryDurableBackend, type DurableInactiveDeleteResult, type DurableWorkflowBackend, type DurableWorkflowCatalogEntries, type WorkflowRegistrationInput } from "./backend.js";
import { encodeCheckpoint, classifyCheckpointPayload } from "./dbos-envelope.js";
import { transitionDbosWorkflowStatus } from "./dbos-status-transition.js";
import { claimMetadataStepName, classifyLatestMetadata, encodeMetadata, isMetadataStep, metadataStepName, parseCurrentMetadataRecord } from "./dbos-metadata.js";
import { inactivePromptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";
import { DBOS_DELETION_STEP, classifyDbosDeletionTombstone, encodeDbosDeletionTombstone } from "./dbos-tombstone.js";
import { isForeignLiveWorkflow } from "./resume-eligibility.js";
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
import {
  createRealDbosHandle,
  getAtomicExecutorId,
  type DbosLogger,
  type DbosStatic,
} from "./dbos-sdk-handle.js";
// ---------------------------------------------------------------------------
// Real SDK handle factory (lazy import, no top-level dependency)
// ---------------------------------------------------------------------------

export interface ConfiguredDbosDurability {
  readonly backend: DbosDurableBackend;
  readonly launch: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

const SILENT_DBOS_LOGGER: DbosLogger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

/** Configure and register DBOS workflows without launching the executor. */
export async function configureDbosDurableBackend(config?: { readonly systemDatabaseUrl?: string }): Promise<ConfiguredDbosDurability> {
  const sdk = await importDbosSdk();
  const url = config?.systemDatabaseUrl ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  sdk.setConfig({
    name: "atomic-workflows",
    ...(url === undefined || url.length === 0 ? {} : { systemDatabaseUrl: url }),
    runAdminServer: false,
    // Unique per process: concurrent Atomic sessions share one database, and
    // DBOS-level pending-workflow recovery must stay scoped to the owner.
    executorID: getAtomicExecutorId(),
    logger: SILENT_DBOS_LOGGER,
  });
  const mainWorkflow = sdk.registerWorkflow(async (_name: string, inputs: DurableInputs) => inputs, { name: "atomicWorkflowHandle" });
  const checkpointWorkflow = sdk.registerWorkflow(async (_workflowId: string, _stepName: string, output: WorkflowSerializableValue) => output, { name: "atomicWorkflowCheckpoint" });
  return {
    backend: new DbosDurableBackend(createRealDbosHandle(sdk, mainWorkflow, checkpointWorkflow)),
    launch: () => sdk.launch(),
    shutdown: () => sdk.shutdown(),
  };
}

export async function importDbosSdk(): Promise<DbosStatic> {
  const spec = "@dbos-inc/dbos-sdk";
  try {
    const mod = await import(spec);
    const dbos = (mod as { readonly DBOS?: DbosStatic }).DBOS;
    if (dbos === undefined) throw new Error("@dbos-inc/dbos-sdk did not export DBOS");
    return dbos;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`@dbos-inc/dbos-sdk could not be loaded: ${msg}`);
  }
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
  private readonly invalid = new Set<string>();
  private readonly current = new Set<string>();
  private readonly locallyRegistered = new Set<string>();
  private readonly promptReservations: DbosPromptReservationTracker;
  private readonly executorId: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: Error[] = [];

  constructor(sdk: DbosSdkHandle, options?: { readonly executorId?: string }) {
    this.sdk = sdk;
    this.executorId = options?.executorId ?? getAtomicExecutorId();
    this.promptReservations = new DbosPromptReservationTracker({
      pendingPrompts: (workflowId) => this.mem.getWorkflow(workflowId)?.pendingPrompts ?? 0,
      adjustPendingPrompts: (workflowId, delta) => this.mem.adjustPendingPrompts(workflowId, delta),
      persist: (workflowId, stepName, output) => {
        this.enqueueWrite(() => this.sdk.recordStepOutput(workflowId, stepName, output));
      },
    });
  }

  registerWorkflow(handle: WorkflowRegistrationInput): void {
    this.invalid.delete(handle.workflowId);
    this.current.add(handle.workflowId);
    this.locallyRegistered.add(handle.workflowId);
    const pendingPrompts = this.promptReservations.registerWorkflow(
      handle.workflowId, handle.pendingPrompts, this.mem.getWorkflow(handle.workflowId)?.pendingPrompts ?? 0,
    );
    this.mem.registerWorkflow({ ...handle, pendingPrompts });
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
  getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined { return this.isWorkflowLoadable(workflowId) ? this.mem.getWorkflow(workflowId) : undefined; }

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

  async transitionWorkflowStatus(workflowId: string, expected: readonly DurableWorkflowStatus[], status: DurableWorkflowStatus, pendingPrompts?: number, resumable?: boolean): Promise<boolean> {
    return await transitionDbosWorkflowStatus({
      expectedStatuses: expected, status, flush: () => this.flush(), local: () => this.getLoadableWorkflow(workflowId),
      read: async () => classifyLatestMetadata(await this.sdk.listStepRecords(workflowId), workflowId),
      reconcile: (entry) => this.mem.setWorkflowStatus(workflowId, entry.status, undefined, entry.resumable),
      claim: (authoritative, generation) => this.claimStatusTransition(workflowId, authoritative, generation, status),
      write: async () => { this.setWorkflowStatus(workflowId, status, pendingPrompts, resumable); await this.flush(); },
    });
  }

  /**
   * The transition's metadata write IS the claim: every racer that observed
   * the same generation writes the same deterministic step id, DBOS keeps the
   * first record, and `ownerExecutorId` identifies the winner. A crash after a
   * won claim leaves valid `running` metadata whose stale heartbeat makes the
   * workflow resumable again — a generation can never wedge.
   */
  private async claimStatusTransition(
    workflowId: string,
    authoritative: import("./types.js").DurableWorkflowMetadata,
    generation: number,
    status: DurableWorkflowStatus,
  ): Promise<boolean> {
    const stepName = claimMetadataStepName(generation, status);
    const claim: import("./types.js").DurableWorkflowMetadata = {
      ...authoritative,
      status,
      ownerExecutorId: this.executorId,
      updatedAt: Date.now(),
    };
    await this.sdk.recordStepOutput(workflowId, stepName, encodeMetadata(claim));
    const records = await this.sdk.listStepRecords(workflowId);
    const record = records.find((candidate) => candidate.stepName === stepName);
    if (record === undefined) return false;
    return parseCurrentMetadataRecord(record, workflowId)?.ownerExecutorId === this.executorId;
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
    // A running workflow with fresh metadata owned by another Atomic process is
    // genuinely executing in that session, not crashed; hide it from resume.
    return this.mem.listResumableWorkflows().filter((entry) =>
      !this.invalid.has(entry.workflowId)
      && !isForeignLiveWorkflow(
        { status: entry.status, updatedAt: entry.updatedAt, ownerExecutorId: this.mem.getWorkflow(entry.workflowId)?.ownerExecutorId },
        this.executorId,
      ));
  }

  listCompletedWorkflows(): readonly ResumableWorkflowEntry[] {
    return this.mem.listCompletedWorkflows().filter((entry) => !this.invalid.has(entry.workflowId));
  }

  toMetadata(workflowId: string) {
    return this.invalid.has(workflowId) ? undefined : this.mem.toMetadata(workflowId);
  }

  async prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
    await this.hydrateResumableWorkflows();
    return { resumable: this.listResumableWorkflows(), completed: this.listCompletedWorkflows() };
  }
  async deleteWorkflow(workflowId: string): Promise<void> {
    this.invalid.add(workflowId);
    this.current.delete(workflowId);
    this.locallyRegistered.delete(workflowId);
    this.promptReservations.delete(workflowId);
    await this.mem.deleteWorkflow(workflowId);
    await this.enqueueWrite(async () => {
      await this.sdk.deleteWorkflowData(workflowId);
      await this.sdk.recordStepOutput(workflowId, DBOS_DELETION_STEP, encodeDbosDeletionTombstone(workflowId));
    });
  }

  async deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult> {
    await this.flush();
    await this.hydrateWorkflow(workflowId);
    const handle = this.getLoadableWorkflow(workflowId);
    if (handle === undefined) return { ok: false, reason: "not_found" };
    if (handle.status === "running") return { ok: false, reason: "running" };
    const guarded = await this.transitionWorkflowStatus(workflowId, [handle.status], handle.status);
    if (!guarded) return { ok: false, reason: "running" };
    await this.deleteWorkflow(workflowId);
    await this.flush();
    return { ok: true };
  }
  isWorkflowLoadable(workflowId: string): boolean {
    return !this.invalid.has(workflowId)
      && (this.locallyRegistered.has(workflowId) || this.current.has(workflowId));
  }
  reset(): void {
    this.mem.reset();
    this.invalid.clear();
    this.current.clear();
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
    if (metadata.kind !== "current") {
      await this.suppressWorkflow(info.workflowId);
      return;
    }
    const checkpoints: DurableCheckpoint[] = [];
    for (const record of records) {
      if (isMetadataStep(record.stepName) || isDbosPromptStateStep(record.stepName)
        || record.stepName === DBOS_DELETION_STEP) continue;
      const classified = classifyCheckpointPayload(info.workflowId, record.stepName, record.output);
      if (classified.kind === "unknown") {
        await this.suppressWorkflow(info.workflowId);
        return;
      }
      checkpoints.push(classified.checkpoint);
    }
    await this.mem.deleteWorkflow(info.workflowId);
    this.invalid.delete(info.workflowId);
    this.current.add(info.workflowId);
    this.applyMetadata(info.workflowId, metadata.metadata);
    checkpoints.forEach((checkpoint) => this.mem.recordCheckpoint(checkpoint));
    const current = this.mem.getWorkflow(info.workflowId);
    if (current !== undefined) {
      const pendingPrompts = this.promptReservations.hydrate(
        info.workflowId,
        metadata.metadata.pendingPrompts,
        records,
        metadata.metadata.promptReservationEpoch,
      );
      // Re-register instead of setWorkflowStatus: hydration is a read-side
      // reconstruction and must preserve the authoritative updatedAt, which
      // doubles as the cross-session liveness heartbeat for running handles.
      this.applyMetadata(info.workflowId, {
        ...metadata.metadata,
        pendingPrompts,
        completedCheckpoints: current.completedCheckpoints,
      });
    }
  }

  private async suppressWorkflow(workflowId: string): Promise<void> {
    this.invalid.add(workflowId);
    this.current.delete(workflowId);
    this.promptReservations.delete(workflowId);
    await this.mem.deleteWorkflow(workflowId);
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.writeErrors.push(error);
      // The next readiness/flush boundary surfaces this fatal persistence error.
    });
    return next;
  }

  private async writeMetadata(workflowId: string): Promise<void> {
    const value = this.mem.toMetadata(workflowId);
    if (value === undefined) return;
    const metadata = {
      ...this.promptReservations.metadata(workflowId, value),
      // Ownership provenance: consulted for `running` handles to distinguish a
      // workflow live in another Atomic session from a crashed one.
      ownerExecutorId: this.executorId,
    };
    await this.sdk.recordStepOutput(
      workflowId,
      metadataStepName(metadata.updatedAt),
      encodeMetadata(metadata),
    );
  }

  private applyMetadata(
    workflowId: string,
    metadata: import("./types.js").DurableWorkflowMetadata,
  ): void {
    this.mem.registerWorkflow({
      workflowId,
      name: metadata.name,
      inputs: metadata.inputs,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      status: metadata.status,
      completedCheckpoints: metadata.completedCheckpoints,
      pendingPrompts: metadata.pendingPrompts,
      ...(metadata.ownerExecutorId !== undefined ? { ownerExecutorId: metadata.ownerExecutorId } : {}),
      ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
      ...(metadata.label !== undefined ? { label: metadata.label } : {}),
      ...(metadata.rootWorkflowId !== undefined ? { rootWorkflowId: metadata.rootWorkflowId } : {}),
      ...(metadata.resumable !== undefined ? { resumable: metadata.resumable } : {}),
      ...(metadata.invocationCwd !== undefined ? { invocationCwd: metadata.invocationCwd } : {}),
      ...(metadata.workflowCwd !== undefined ? { workflowCwd: metadata.workflowCwd } : {}),
      ...(metadata.repositoryRoot !== undefined ? { repositoryRoot: metadata.repositoryRoot } : {}),
      ...(metadata.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: metadata.gitWorktreeRoot } : {}),
    });
  }
}

// Metadata encoding/classification lives in dbos-metadata.ts to keep this adapter focused.
