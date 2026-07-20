import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import { isCurrentDurableFormat, DURABLE_FORMAT_VERSION } from "./format-version.js";

export const DBOS_DELETION_STEP = "__atomic_deleted";

export type DbosDeletionCompatibility = "current" | "unknown" | "absent";

export function encodeDbosDeletionTombstone(workflowId: string): WorkflowSerializableValue {
  return {
    __atomicDurableDeleted: true,
    version: DURABLE_FORMAT_VERSION,
    workflowId,
  };
}

export function classifyDbosDeletionTombstone(
  records: readonly DbosStepRecord[],
  workflowId: string,
): DbosDeletionCompatibility {
  const record = records.find((candidate) => candidate.stepName === DBOS_DELETION_STEP);
  if (record === undefined) return "absent";
  if (typeof record.output !== "object" || record.output === null || Array.isArray(record.output)) return "unknown";
  const raw = record.output as Record<string, WorkflowSerializableValue>;
  if (raw["__atomicDurableDeleted"] !== true || raw["workflowId"] !== workflowId) return "unknown";
  return isCurrentDurableFormat(raw["version"]) ? "current" : "unknown";
}
