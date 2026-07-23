import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import { isCurrentDurableFormat, DURABLE_FORMAT_VERSION } from "./format-version.js";
import type { DurableWorkflowMetadata, DurableWorkflowStatus } from "./types.js";
import { isAbsorbingDurableStatus } from "./workflow-status-transition.js";

const METADATA_STEP_PREFIX = "__atomic_metadata";

export type DbosMetadataClassification =
  | { readonly kind: "current"; readonly metadata: DurableWorkflowMetadata; readonly generation: number }
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable" };

export function metadataStepName(ts: number): string {
  return `${METADATA_STEP_PREFIX}:${ts}:${crypto.randomUUID()}`;
}

/** Deterministic first-writer-wins claim id for one observed generation. */
export function claimMetadataStepName(generation: number): string {
  return `${METADATA_STEP_PREFIX}:${generation + 1}:claim`;
}

export function isMetadataStep(stepName: string): boolean {
  return stepName === METADATA_STEP_PREFIX || stepName.startsWith(`${METADATA_STEP_PREFIX}:`);
}

/** Parse one metadata step record, returning current-format metadata only. */
export function parseCurrentMetadataRecord(
  record: DbosStepRecord,
  workflowId: string,
): DurableWorkflowMetadata | undefined {
  const classified = classifyMetadataRecord(record, workflowId);
  return classified.kind === "current" ? classified.metadata : undefined;
}

export function encodeMetadata(metadata: DurableWorkflowMetadata): WorkflowSerializableValue {
  return {
    __atomicDurableMetadata: true,
    version: DURABLE_FORMAT_VERSION,
    metadata: {
      workflowId: metadata.workflowId,
      name: metadata.name,
      inputs: metadata.inputs,
      status: metadata.status,
      createdAt: metadata.createdAt,
      completedCheckpoints: metadata.completedCheckpoints,
      pendingPrompts: metadata.pendingPrompts,
      promptReservationEpoch: metadata.promptReservationEpoch,
      ...(metadata.ownerExecutorId !== undefined ? { ownerExecutorId: metadata.ownerExecutorId } : {}),
      ...(metadata.transitionClaimId !== undefined ? { transitionClaimId: metadata.transitionClaimId } : {}),
      ...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
      ...(metadata.label !== undefined ? { label: metadata.label } : {}),
      ...(metadata.rootWorkflowId !== undefined ? { rootWorkflowId: metadata.rootWorkflowId } : {}),
      ...(metadata.resumable !== undefined ? { resumable: metadata.resumable } : {}),
      ...(metadata.invocationCwd !== undefined ? { invocationCwd: metadata.invocationCwd } : {}),
      ...(metadata.workflowCwd !== undefined ? { workflowCwd: metadata.workflowCwd } : {}),
      ...(metadata.repositoryRoot !== undefined ? { repositoryRoot: metadata.repositoryRoot } : {}),
      ...(metadata.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: metadata.gitWorktreeRoot } : {}),
      updatedAt: metadata.updatedAt,
    },
  };
}

export function classifyLatestMetadata(
  records: readonly DbosStepRecord[],
  workflowId: string,
): DbosMetadataClassification {
  const metadataRecords = records.filter((record) => isMetadataStep(record.stepName));
  if (metadataRecords.length === 0) return { kind: "unavailable" };
  const latest = metadataRecords.reduce((selected, record) =>
    metadataTimestamp(record) >= metadataTimestamp(selected) ? record : selected);
  const latestClassification = classifyMetadataRecord(latest, workflowId);
  if (latestClassification.kind !== "current") return latestClassification;
  const terminals = metadataRecords
    .map((record) => ({ record, classified: classifyMetadataRecord(record, workflowId) }))
    .filter((candidate): candidate is {
      record: DbosStepRecord;
      classified: { kind: "current"; metadata: DurableWorkflowMetadata };
    } => candidate.classified.kind === "current"
      && isAbsorbingDurableStatus(candidate.classified.metadata.status, candidate.classified.metadata.resumable));
  if (terminals.length === 0) {
    return { ...latestClassification, generation: metadataTimestamp(latest) };
  }
  const terminal = terminals.reduce((selected, candidate) =>
    metadataTimestamp(candidate.record) >= metadataTimestamp(selected.record) ? candidate : selected);
  return { ...terminal.classified, generation: metadataTimestamp(terminal.record) };
}

function classifyMetadataRecord(
  record: DbosStepRecord,
  workflowId: string,
): { readonly kind: "current"; readonly metadata: DurableWorkflowMetadata } | { readonly kind: "unknown" } {
  if (typeof record.output !== "object" || record.output === null || Array.isArray(record.output)) {
    return { kind: "unknown" };
  }
  const raw = record.output as Record<string, WorkflowSerializableValue>;
  if (raw["__atomicDurableMetadata"] !== true || !isCurrentDurableFormat(raw["version"])) {
    return { kind: "unknown" };
  }
  const metadata = parseDurableWorkflowMetadata(raw["metadata"], workflowId);
  return metadata === undefined ? { kind: "unknown" } : { kind: "current", metadata };
}

function metadataTimestamp(record: DbosStepRecord): number {
  const segment = record.stepName.split(":")[1];
  const fromName = segment === undefined ? Number.NaN : Number(segment);
  return Number.isFinite(fromName) ? fromName : (record.completedAt ?? 0);
}

function parseDurableWorkflowMetadata(
  value: WorkflowSerializableValue | undefined,
  workflowId: string,
): DurableWorkflowMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const metadata = value as Partial<DurableWorkflowMetadata>;
  if (metadata.workflowId !== workflowId
    || typeof metadata.workflowId !== "string"
    || typeof metadata.name !== "string"
    || typeof metadata.inputs !== "object"
    || metadata.inputs === null
    || Array.isArray(metadata.inputs)
    || typeof metadata.status !== "string"
    || !isDurableWorkflowStatus(metadata.status)
    || typeof metadata.completedCheckpoints !== "number"
    || typeof metadata.createdAt !== "number"
    || typeof metadata.pendingPrompts !== "number"
    || typeof metadata.promptReservationEpoch !== "string"
    || typeof metadata.updatedAt !== "number"
    || (metadata.ownerExecutorId !== undefined && typeof metadata.ownerExecutorId !== "string")
    || (metadata.transitionClaimId !== undefined && typeof metadata.transitionClaimId !== "string")
    || (metadata.sessionFile !== undefined && typeof metadata.sessionFile !== "string")
    || (metadata.label !== undefined && typeof metadata.label !== "string")
    || (metadata.rootWorkflowId !== undefined && typeof metadata.rootWorkflowId !== "string")
    || (metadata.resumable !== undefined && typeof metadata.resumable !== "boolean")
    || (metadata.invocationCwd !== undefined && typeof metadata.invocationCwd !== "string")
    || (metadata.workflowCwd !== undefined && typeof metadata.workflowCwd !== "string")
    || (metadata.repositoryRoot !== undefined && typeof metadata.repositoryRoot !== "string")
    || (metadata.gitWorktreeRoot !== undefined && typeof metadata.gitWorktreeRoot !== "string")) return undefined;
  return metadata as DurableWorkflowMetadata;
}

function isDurableWorkflowStatus(value: string): value is DurableWorkflowStatus {
  return value === "running" || value === "paused" || value === "completed"
    || value === "failed" || value === "cancelled" || value === "blocked";
}
