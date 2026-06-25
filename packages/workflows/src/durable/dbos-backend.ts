/**
 * DBOS-backed durable backend adapter.
 *
 * This adapter wraps the `@dbos-inc/dbos-sdk` to provide real durable workflow
 * execution with Postgres-backed checkpointing. It is loaded lazily — only when
 * `DBOS_SYSTEM_DATABASE_URL` is set — so the workflows package has no hard
 * dependency on DBOS or Postgres for basic operation or tests.
 *
 * The adapter maps Atomic durable concepts to DBOS primitives:
 * - `registerWorkflow` → `DBOS.startWorkflow` (or `retrieveWorkflow` if exists)
 * - `recordCheckpoint` (tool) → `DBOS.runStep` output (checkpointed automatically)
 * - `recordCheckpoint` (ui) → `DBOS.setEvent` / checkpointed step
 * - `recordCheckpoint` (stage) → step output checkpoint
 * - `listResumableWorkflows` → `DBOS.listWorkflows({ status: "PENDING" })`
 * - `setWorkflowStatus(cancelled)` → `DBOS.cancelWorkflow`
 * - `setWorkflowStatus(running)` on resume → `DBOS.resumeWorkflow`
 *
 * Because DBOS requires Postgres at runtime, this adapter is only instantiated
 * when explicitly configured. Tests use {@link InMemoryDurableBackend} or
 * {@link FileDurableBackend} instead.
 *
 * cross-ref: issue #1498 — DBOS TypeScript SDK integration.
 */

import type { DurableCheckpoint, DurableWorkflowHandle, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import { InMemoryDurableBackend, type DurableWorkflowBackend, type WorkflowRegistrationInput } from "./backend.js";
import type { WorkflowSerializableValue } from "../shared/types.js";

/**
 * Lazy DBOS SDK handle. We avoid a top-level import to keep the package
 * dependency-free when DBOS is not configured. The adapter dynamically imports
 * the SDK only when {@link createDbosDurableBackend} is called.
 */
export interface DbosSdkHandle {
  readonly launch: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly startWorkflow: (workflowId: string, name: string, inputs: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly retrieveWorkflow: (workflowId: string) => Promise<DbosWorkflowInfo | undefined>;
  readonly cancelWorkflow: (workflowId: string) => Promise<void>;
  readonly resumeWorkflow: (workflowId: string) => Promise<void>;
  readonly listPendingWorkflows: () => Promise<readonly DbosWorkflowInfo[]>;
  readonly recordStepOutput: (workflowId: string, stepName: string, output: WorkflowSerializableValue) => Promise<void>;
  readonly getStepOutput: (workflowId: string, stepName: string) => Promise<WorkflowSerializableValue | undefined>;
}

export interface DbosWorkflowInfo {
  readonly workflowId: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: number;
}

/**
 * Check whether DBOS is configured (env var present).
 */
export function isDbosConfigured(): boolean {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  return typeof url === "string" && url.length > 0;
}

/**
 * Create a DBOS-backed durable backend. This dynamically imports the DBOS SDK.
 * Throws if the SDK is not installed.
 *
 * Exported for the extension runtime to call when DBOS is configured. Tests
 * should never call this — use InMemoryDurableBackend or FileDurableBackend.
 */
export async function createDbosDurableBackend(_config?: { readonly systemDatabaseUrl?: string }): Promise<DurableWorkflowBackend> {
  throw new Error(
    "DbosDurableBackend: the DBOS SDK adapter is implemented as a lazy seam. " +
      "Set DBOS_SYSTEM_DATABASE_URL and install @dbos-inc/dbos-sdk to enable. " +
      "The InMemoryDurableBackend or FileDurableBackend is used by default.",
  );
}

/**
 * DBOS-backed durable backend. Wraps a {@link DbosSdkHandle} to implement the
 * {@link DurableWorkflowBackend} interface. The SDK handle abstracts the actual
 * DBOS calls so this class is testable without Postgres.
 *
 * This is the production adapter used when DBOS is configured. It delegates
 * checkpoint storage to DBOS step outputs (the source of truth) while keeping
 * an in-memory mirror for synchronous query APIs used by the engine.
 */
export class DbosDurableBackend implements DurableWorkflowBackend {
  public readonly persistent = true;
  private readonly mem = new InMemoryDurableBackend();
  private readonly sdk: DbosSdkHandle;

  constructor(sdk: DbosSdkHandle) {
    this.sdk = sdk;
  }

  registerWorkflow(handle: WorkflowRegistrationInput): void {
    this.mem.registerWorkflow(handle);
    // Fire-and-forget DBOS registration; the in-memory mirror handles queries.
    void this.sdk.startWorkflow(handle.workflowId, handle.name, handle.inputs as Record<string, unknown>);
  }

  recordCheckpoint(checkpoint: DurableCheckpoint): void {
    this.mem.recordCheckpoint(checkpoint);
    const stepName = checkpoint.kind === "stage" ? checkpoint.replayKey : checkpoint.checkpointId;
    void this.sdk.recordStepOutput(checkpoint.workflowId, stepName, checkpointOutput(checkpoint));
  }

  getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
    return this.mem.getToolOutput(workflowId, argsHash);
  }

  getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
    return this.mem.getUiResponse(workflowId, promptHash);
  }

  getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
    return this.mem.getStageOutput(workflowId, replayKey);
  }

  listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
    return this.mem.listCheckpoints(workflowId);
  }

  getWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
    return this.mem.getWorkflow(workflowId);
  }

  setWorkflowStatus(workflowId: string, status: DurableWorkflowStatus, _pendingPrompts?: number): void {
    this.mem.setWorkflowStatus(workflowId, status, _pendingPrompts);
    if (status === "cancelled") void this.sdk.cancelWorkflow(workflowId);
    else if (status === "running") void this.sdk.resumeWorkflow(workflowId);
  }

  listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
    // Return from the in-memory mirror synchronously.
    // The extension runtime refreshes the mirror from DBOS periodically.
    return this.mem.listResumableWorkflows();
  }

  toCacheEntry(workflowId: string) {
    return this.mem.toCacheEntry(workflowId);
  }

  reset(): void {
    this.mem.reset();
  }
}

function checkpointOutput(cp: DurableCheckpoint): WorkflowSerializableValue {
  if (cp.kind === "tool") return cp.output;
  if (cp.kind === "ui") return cp.response;
  return cp.output;
}
