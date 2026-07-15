import { existsSync, readFileSync } from "node:fs";
import type { WorkflowSerializableValue } from "../shared/types.js";
import {
  DURABLE_STAGE_TOPOLOGY_VERSION,
  type DurableCheckpoint,
  type DurableStageTopology,
  type DurableWorkflowHandle,
} from "./types.js";
import { classifyDurableFormatVersion, DURABLE_FORMAT_VERSION } from "./format-version.js";

export interface FileDurableRecord {
  readonly handle: DurableWorkflowHandle;
  readonly checkpoints: readonly DurableCheckpoint[];
}

export interface FileDurableState {
  readonly version: number;
  readonly workflows: readonly FileDurableRecord[];
  readonly deletedWorkflowIds: readonly string[];
}

export type FileStateReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "current"; readonly state: FileDurableState }
  | { readonly kind: "legacy"; readonly workflowIds: readonly string[] }
  | { readonly kind: "unknown" };

export function readDurableFileState(filePath: string): FileStateReadResult {
  if (!existsSync(filePath)) return { kind: "missing" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<FileDurableState> | null;
    if (parsed === null || !Array.isArray(parsed.workflows)) return { kind: "unknown" };
    const compatibility = classifyDurableFormatVersion(parsed.version);
    if (compatibility === "legacy") {
      const validRecords = parsed.workflows.filter(isFileDurableRecord);
      return {
        kind: "legacy",
        workflowIds: validRecords.length === parsed.workflows.length
          ? validRecords.map((record) => record.handle.workflowId)
          : [],
      };
    }
    const deleted = parsed.deletedWorkflowIds ?? [];
    if (compatibility === "unknown" || !isStringArray(deleted) || !parsed.workflows.every(isFileDurableRecord)) return { kind: "unknown" };
    return {
      kind: "current",
      state: {
        version: DURABLE_FORMAT_VERSION,
        workflows: parsed.workflows.map(withoutInvalidTopology),
        deletedWorkflowIds: deleted,
      },
    };
  } catch {
    return { kind: "unknown" };
  }
}

function isFileDurableRecord(value: unknown): value is FileDurableRecord {
  if (!isObject(value)) return false;
  const handle = value["handle"];
  const checkpoints = value["checkpoints"];
  if (!isHandle(handle) || !Array.isArray(checkpoints)) return false;
  return checkpoints.every((checkpoint) => isCheckpoint(checkpoint) && checkpoint.workflowId === handle.workflowId);
}

function isHandle(value: unknown): value is DurableWorkflowHandle {
  if (!isObject(value) || typeof value["workflowId"] !== "string" || typeof value["name"] !== "string"
    || !isSerializableObject(value["inputs"]) || typeof value["createdAt"] !== "number"
    || typeof value["updatedAt"] !== "number" || !isStatus(value["status"])
    || typeof value["completedCheckpoints"] !== "number" || typeof value["pendingPrompts"] !== "number") return false;
  return optionalString(value, "invocationCwd") && optionalString(value, "workflowCwd")
    && optionalString(value, "repositoryRoot") && optionalString(value, "gitWorktreeRoot")
    && optionalString(value, "sessionFile") && optionalString(value, "label")
    && optionalString(value, "rootWorkflowId") && optionalBoolean(value, "resumable");
}

function isCheckpoint(value: unknown): value is DurableCheckpoint {
  if (!isObject(value) || typeof value["workflowId"] !== "string" || typeof value["checkpointId"] !== "string"
    || typeof value["completedAt"] !== "number") return false;
  if (value["kind"] === "tool") return typeof value["name"] === "string" && typeof value["argsHash"] === "string" && isSerializable(value["output"]);
  if (value["kind"] === "ui") return typeof value["promptKind"] === "string" && typeof value["message"] === "string"
    && typeof value["promptHash"] === "string" && isSerializable(value["response"]);
  return value["kind"] === "stage" && typeof value["name"] === "string" && typeof value["replayKey"] === "string"
    && (!("output" in value) || isSerializable(value["output"]));
}

function withoutInvalidTopology(record: FileDurableRecord): FileDurableRecord {
  return {
    handle: record.handle,
    checkpoints: record.checkpoints.map((checkpoint) => {
      if (checkpoint.kind !== "stage" || checkpoint.topology === undefined || isStageTopology(checkpoint.topology)) {
        return checkpoint;
      }
      const { topology, ...withoutTopology } = checkpoint;
      void topology;
      return withoutTopology;
    }),
  };
}

function isStageTopology(value: unknown): value is DurableStageTopology {
  return isObject(value) && value["version"] === DURABLE_STAGE_TOPOLOGY_VERSION && typeof value["stageId"] === "string"
    && isStringArray(value["parentIds"]);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isStatus(value: unknown): boolean {
  return value === "running" || value === "paused" || value === "completed"
    || value === "failed" || value === "cancelled" || value === "blocked";
}

function isSerializableObject(value: unknown): value is Readonly<Record<string, WorkflowSerializableValue>> {
  return isObject(value) && Object.values(value).every(isSerializable);
}

function isSerializable(value: unknown): value is WorkflowSerializableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSerializable);
  return isSerializableObject(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}
