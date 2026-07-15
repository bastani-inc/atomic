import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import { classifyDurableFormatVersion, DURABLE_FORMAT_VERSION } from "./format-version.js";
import type { DurableCheckpointEntry, DurableWorkflowStatus } from "./types.js";
import { isAbsorbingDurableStatus } from "./workflow-status-transition.js";

const METADATA_STEP_PREFIX = "__atomic_metadata";

export type DbosMetadataCompatibility =
  | { readonly kind: "current"; readonly entry: DurableCheckpointEntry }
  | { readonly kind: "legacy" }
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable" };

export function metadataStepName(ts: number): string {
  return `${METADATA_STEP_PREFIX}:${ts}:${crypto.randomUUID()}`;
}

export function isMetadataStep(stepName: string): boolean {
  return stepName === METADATA_STEP_PREFIX || stepName.startsWith(`${METADATA_STEP_PREFIX}:`);
}

export function encodeMetadata(entry: DurableCheckpointEntry): WorkflowSerializableValue {
  return {
    __atomicDurableMetadata: true,
    version: DURABLE_FORMAT_VERSION,
    entry: {
      formatVersion: entry.formatVersion,
      type: entry.type,
      workflowId: entry.workflowId,
      name: entry.name,
      inputs: entry.inputs,
      status: entry.status,
      completedCheckpoints: entry.completedCheckpoints,
      pendingPrompts: entry.pendingPrompts,
      ...(entry.promptReservationEpoch !== undefined ? { promptReservationEpoch: entry.promptReservationEpoch } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.rootWorkflowId !== undefined ? { rootWorkflowId: entry.rootWorkflowId } : {}),
      ...(entry.resumable !== undefined ? { resumable: entry.resumable } : {}),
      ...(entry.invocationCwd !== undefined ? { invocationCwd: entry.invocationCwd } : {}),
      ...(entry.workflowCwd !== undefined ? { workflowCwd: entry.workflowCwd } : {}),
      ...(entry.repositoryRoot !== undefined ? { repositoryRoot: entry.repositoryRoot } : {}),
      ...(entry.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: entry.gitWorktreeRoot } : {}),
      ts: entry.ts,
    },
  };
}

export function classifyLatestMetadata(records: readonly DbosStepRecord[], workflowId: string): DbosMetadataCompatibility {
  const metadata = records.filter((record) => isMetadataStep(record.stepName));
  if (metadata.length === 0) return { kind: "unavailable" };
  const latest = metadata.reduce((selected, record) => metadataTimestamp(record) >= metadataTimestamp(selected) ? record : selected);
  const latestClassification = classifyMetadataRecord(latest, workflowId);
  if (latestClassification.kind !== "current") return latestClassification;
  const terminals = metadata.map((record) => ({ record, classified: classifyMetadataRecord(record, workflowId) }))
    .filter((candidate): candidate is { record: DbosStepRecord; classified: { kind: "current"; entry: DurableCheckpointEntry } } =>
      candidate.classified.kind === "current"
      && isAbsorbingDurableStatus(candidate.classified.entry.status, candidate.classified.entry.resumable));
  if (terminals.length === 0) return latestClassification;
  return terminals.reduce((selected, candidate) =>
    metadataTimestamp(candidate.record) >= metadataTimestamp(selected.record) ? candidate : selected).classified;
}

function classifyMetadataRecord(record: DbosStepRecord, workflowId: string): DbosMetadataCompatibility {
  if (typeof record.output !== "object" || record.output === null || Array.isArray(record.output)) return { kind: "unknown" };
  const raw = record.output as Record<string, WorkflowSerializableValue>;
  if (raw["__atomicDurableMetadata"] !== true) return { kind: "unknown" };
  const compatibility = classifyDurableFormatVersion(raw["version"]);
  if (compatibility !== "current") return { kind: compatibility };
  const entry = parseDurableCheckpointEntry(raw["entry"], workflowId);
  return entry === undefined ? { kind: "unknown" } : { kind: "current", entry };
}

function metadataTimestamp(record: DbosStepRecord): number {
  const segment = record.stepName.split(":")[1];
  const fromName = segment === undefined ? Number.NaN : Number(segment);
  return Number.isFinite(fromName) ? fromName : (record.completedAt ?? 0);
}

function parseDurableCheckpointEntry(
  value: WorkflowSerializableValue | undefined,
  workflowId: string,
): DurableCheckpointEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Partial<DurableCheckpointEntry>;
  if (entry.workflowId !== workflowId
    || entry.formatVersion !== DURABLE_FORMAT_VERSION
    || entry.type !== "workflow.durable.checkpoint"
    || typeof entry.workflowId !== "string"
    || typeof entry.name !== "string"
    || typeof entry.inputs !== "object"
    || entry.inputs === null
    || Array.isArray(entry.inputs)
    || typeof entry.status !== "string"
    || !isDurableWorkflowStatus(entry.status)
    || typeof entry.completedCheckpoints !== "number"
    || typeof entry.pendingPrompts !== "number"
    || (entry.promptReservationEpoch !== undefined && typeof entry.promptReservationEpoch !== "string")
    || typeof entry.ts !== "number"
    || (entry.label !== undefined && typeof entry.label !== "string")
    || (entry.rootWorkflowId !== undefined && typeof entry.rootWorkflowId !== "string")
    || (entry.resumable !== undefined && typeof entry.resumable !== "boolean")
    || (entry.invocationCwd !== undefined && typeof entry.invocationCwd !== "string")
    || (entry.workflowCwd !== undefined && typeof entry.workflowCwd !== "string")
    || (entry.repositoryRoot !== undefined && typeof entry.repositoryRoot !== "string")
    || (entry.gitWorktreeRoot !== undefined && typeof entry.gitWorktreeRoot !== "string")) return undefined;
  return entry as DurableCheckpointEntry;
}

function isDurableWorkflowStatus(value: string): value is DurableWorkflowStatus {
  return value === "running" || value === "paused" || value === "completed"
    || value === "failed" || value === "cancelled" || value === "blocked";
}
