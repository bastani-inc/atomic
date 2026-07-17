/**
 * Real `@dbos-inc/dbos-sdk` handle factory.
 *
 * Wraps the DBOS static executor into the {@link DbosSdkHandle} seam used by
 * {@link DbosDurableBackend}. Kept separate from the backend adapter so both
 * files stay within the repository file-length gate.
 */

import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosSdkHandle, DbosStepRecord, DbosWorkflowInfo } from "./dbos-backend.js";

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

/**
 * Unique executor identity for this Atomic process. Multiple concurrent Atomic
 * sessions share one DBOS database; a per-process id keeps DBOS-level recovery
 * and workflow ownership scoped to the process that actually runs the work.
 */
const ATOMIC_EXECUTOR_ID = `atomic-${process.pid.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export function getAtomicExecutorId(): string {
  return ATOMIC_EXECUTOR_ID;
}

export interface DbosLogger {
  info(value: unknown, metadata?: object): void;
  debug(value: unknown, metadata?: object): void;
  warn(value: unknown, metadata?: object): void;
  error(value: unknown, metadata?: object): void;
}

export interface DbosConfiguration {
  readonly name: string;
  readonly systemDatabaseUrl?: string;
  readonly runAdminServer: boolean;
  readonly executorID: string;
  readonly logger: DbosLogger;
}

export interface DbosStatic {
  setConfig(config: DbosConfiguration): void;
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

export function createRealDbosHandle(
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
      let handle: DbosWorkflowHandle;
      try {
        handle = await dbos.startWorkflow(checkpointWorkflow, { workflowID: checkpointId(workflowId, stepName) })(workflowId, stepName, output);
      } catch (err) {
        if (!isDbosDuplicateWorkflowError(err)) throw err;
        handle = dbos.retrieveWorkflow(checkpointId(workflowId, stepName));
      }
      // Await completion so the record is durable and readable before the
      // caller's flush boundary; duplicates resolve to the first stored output.
      await handle.getResult();
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
  if (status.input !== undefined && status.input.length >= 2) {
    const inputs = status.input[1];
    if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
      return { ...info, inputs: inputs as import("./types.js").WorkflowSerializableObject };
    }
  }
  return info;
}
