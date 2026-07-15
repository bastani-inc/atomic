import { existsSync, readFileSync } from "node:fs";
import type { WorkflowSerializableValue } from "../shared/types.js";
import {
  DURABLE_STAGE_TOPOLOGY_VERSION,
  type DurableCheckpoint,
  type DurableStageTopology,
  type DurableWorkflowHandle,
} from "./types.js";
import { classifyDurableFormatVersion, DURABLE_FORMAT_VERSION } from "./format-version.js";
import { mergePromptReservationSnapshots, type PromptReservationSnapshot } from "./prompt-reservation-state.js";

export interface FileDurableRecord {
  readonly handle: DurableWorkflowHandle;
  readonly checkpoints: readonly DurableCheckpoint[];
  /** Legacy active prompt identities written before generation tombstones. */
  readonly promptReservations?: readonly string[];
  /** Identity-owned active tokens, released generations, and consumed-token tombstones. */
  readonly promptReservationState?: PromptReservationSnapshot;
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
  const promptReservations = value["promptReservations"];
  const promptReservationState = value["promptReservationState"];
  if (!isHandle(handle) || !Array.isArray(checkpoints)
    || (promptReservations !== undefined && !isStringArray(promptReservations))
    || (promptReservationState !== undefined && !isPromptReservationSnapshot(promptReservationState))) return false;
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

function isPromptReservationSnapshot(value: unknown): value is PromptReservationSnapshot {
  if (!isObject(value) || !Array.isArray(value["active"]) || !Array.isArray(value["released"])
    || !isStringArray(value["anonymousTokenIds"]) || !isStringArray(value["consumedTokenIds"])) return false;
  return value["active"].every((entry) => isPromptReservationEntry(entry, true))
    && value["released"].every((entry) => isPromptReservationEntry(entry, false));
}

function isPromptReservationEntry(value: unknown, tokenRequired: boolean): boolean {
  return isObject(value) && typeof value["reservationId"] === "string"
    && typeof value["generation"] === "number" && Number.isInteger(value["generation"]) && value["generation"] > 0
    && (tokenRequired ? typeof value["tokenId"] === "string" : value["tokenId"] === undefined);
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

/** Merge persisted records without reviving released prompt generations or consumed tokens. */
export function mergeFileDurableRecords(
  first: readonly FileDurableRecord[],
  second: readonly FileDurableRecord[],
): readonly FileDurableRecord[] {
  const merged = new Map<string, {
    handle: DurableWorkflowHandle;
    checkpoints: Map<string, DurableCheckpoint>;
    promptReservationState?: PromptReservationSnapshot;
  }>();
  for (const record of [...first, ...second]) {
    const existing = merged.get(record.handle.workflowId);
    const handle = existing === undefined || record.handle.updatedAt >= existing.handle.updatedAt
      ? record.handle
      : existing.handle;
    const checkpoints = existing?.checkpoints ?? new Map<string, DurableCheckpoint>();
    for (const checkpoint of record.checkpoints) {
      checkpoints.set(`${checkpoint.kind}:${checkpoint.checkpointId}`, checkpoint);
    }
    const currentState = record.promptReservationState ?? legacyPromptReservationState(record);
    const promptReservationState = mergePromptReservationSnapshots(
      existing?.promptReservationState, currentState, handle.pendingPrompts,
    );
    merged.set(record.handle.workflowId, {
      handle,
      checkpoints,
      ...(promptReservationState !== undefined ? { promptReservationState } : {}),
    });
  }
  return [...merged.values()].map((record) => ({
    handle: record.handle,
    checkpoints: [...record.checkpoints.values()],
    ...(record.promptReservationState !== undefined ? { promptReservationState: record.promptReservationState } : {}),
  }));
}

function legacyPromptReservationState(record: FileDurableRecord): PromptReservationSnapshot | undefined {
  if (record.promptReservations === undefined) return undefined;
  return {
    active: record.promptReservations.map((reservationId) => ({
      reservationId, generation: 1, tokenId: `reservation:${encodeURIComponent(reservationId)}:1`,
    })),
    released: [],
    anonymousTokenIds: [],
    consumedTokenIds: [],
  };
}
