/**
 * DBOS checkpoint envelope — a structured payload stored as DBOS step output so
 * a fresh process can reconstruct full durable checkpoints from DBOS alone.
 *
 * Without the envelope, `recordStepOutput` would only persist the raw output
 * value, losing checkpoint metadata (kind, checkpointId, argsHash, promptHash,
 * replayKey, etc.). That makes cross-process DBOS hydration impossible because
 * the synchronous replay reads (`getToolOutput`, `getUiResponse`,
 * `getStageOutput`) cannot reconstruct their lookup keys.
 *
 * Payloads without the current envelope marker and version are rejected.
 */

import type { WorkflowSerializableObject, WorkflowSerializableValue } from "../shared/types.js";
import {
  DURABLE_STAGE_TOPOLOGY_VERSION,
  DURABLE_TOOL_TOPOLOGY_VERSION,
  type DurableCheckpoint,
  type DurableCheckpointKind,
  type DurableStageCheckpoint,
  type DurableStageTopology,
  type DurableToolCheckpoint,
  type DurableToolTopology,
  type DurableUiCheckpoint,
  type UiPromptKind,
} from "./types.js";
import { isCurrentDurableFormat, DURABLE_FORMAT_VERSION } from "./format-version.js";

/** Envelope schema version. */
export const DBOS_ENVELOPE_VERSION = DURABLE_FORMAT_VERSION;

/** Marker key present on every envelope payload. */
const ENVELOPE_MARKER = "__dbos_checkpoint__";

/**
 * Structured DBOS step-output payload containing all checkpoint metadata.
 * Stored as the output of a DBOS checkpoint workflow so it round-trips through
 * `getResult()` / `listWorkflows` on hydration.
 */
export interface DbosCheckpointEnvelope extends WorkflowSerializableObject {
  readonly __dbos_checkpoint__: typeof ENVELOPE_MARKER;
  readonly v: typeof DBOS_ENVELOPE_VERSION;
  readonly kind: DurableCheckpointKind;
  readonly checkpointId: string;
  readonly name?: string;
  readonly argsHash?: string;
  readonly promptKind?: UiPromptKind;
  readonly message?: string;
  readonly promptHash?: string;
  readonly replayKey?: string;
  readonly output?: WorkflowSerializableValue;
  readonly hasOutput?: boolean;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly completedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: string;
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: WorkflowSerializableValue;
  readonly modelAttempts?: WorkflowSerializableValue;
  readonly topology?: WorkflowSerializableValue;
}

/** Add a compatibility root topology when a legacy/output-only writer omits it. */
export function withCurrentStageTopology(cp: DurableCheckpoint): DurableCheckpoint {
  if (cp.kind !== "stage" || cp.topology !== undefined) return cp;
  return {
    ...cp,
    topology: { version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId: cp.checkpointId, parentIds: [] },
  };
}

/**
 * Encode a durable checkpoint into a DBOS step-output envelope.
 */
export function encodeCheckpoint(checkpoint: DurableCheckpoint): DbosCheckpointEnvelope {
  const cp = withCurrentStageTopology(checkpoint);
  const output = checkpointOutputValue(cp);
  const base: DbosCheckpointEnvelope = {
    __dbos_checkpoint__: ENVELOPE_MARKER,
    v: DBOS_ENVELOPE_VERSION,
    kind: cp.kind,
    checkpointId: cp.checkpointId,
    ...(output !== undefined ? { output } : {}),
    hasOutput: output !== undefined,
    completedAt: cp.completedAt,
  };
  if (cp.kind === "tool") {
    const t = cp as DurableToolCheckpoint;
    return {
      ...base,
      name: t.name,
      argsHash: t.argsHash,
      ...(t.topology !== undefined ? { topology: {
        version: t.topology.version,
        nodeId: t.topology.nodeId,
        ordinal: t.topology.ordinal,
        order: t.topology.order,
        parentIds: [...t.topology.parentIds],
        ...(t.topology.startedAt !== undefined ? { startedAt: t.topology.startedAt } : {}),
        ...(t.topology.endedAt !== undefined ? { endedAt: t.topology.endedAt } : {}),
        ...(t.topology.run !== undefined ? { run: { ...t.topology.run } } : {}),
      } } : {}),
    };
  }
  if (cp.kind === "ui") {
    const u = cp as DurableUiCheckpoint;
    return { ...base, promptKind: u.promptKind, message: u.message, promptHash: u.promptHash };
  }
  const s = cp as DurableStageCheckpoint;
  return {
    ...base,
    name: s.name,
    replayKey: s.replayKey,
    ...(s.topology !== undefined ? { topology: {
      version: s.topology.version,
      stageId: s.topology.stageId,
      parentIds: [...s.topology.parentIds],
      ...(s.topology.order !== undefined ? { order: s.topology.order } : {}),
      ...(s.topology.run !== undefined ? { run: { ...s.topology.run } } : {}),
    } } : {}),
    ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
    ...(s.sessionFile !== undefined ? { sessionFile: s.sessionFile } : {}),
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
    ...(s.result !== undefined ? { result: s.result } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.fastMode !== undefined ? { fastMode: s.fastMode } : {}),
    ...(s.attemptedModels !== undefined ? { attemptedModels: [...s.attemptedModels] } : {}),
    ...(s.modelAttempts !== undefined ? { modelAttempts: s.modelAttempts as WorkflowSerializableValue } : {}),
  };
}

/**
 * Type guard: is this value a checkpoint envelope?
 */
export function isCheckpointEnvelope(value: WorkflowSerializableValue | undefined): value is DbosCheckpointEnvelope {
  if (!hasCheckpointEnvelopeMarker(value)) return false;
  return value.v === DBOS_ENVELOPE_VERSION;
}

function hasCheckpointEnvelopeMarker(value: WorkflowSerializableValue | undefined): value is Record<string, WorkflowSerializableValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as Record<string, WorkflowSerializableValue>)[ENVELOPE_MARKER] === ENVELOPE_MARKER;
}
export type DbosCheckpointCompatibility =
  | { readonly kind: "current"; readonly checkpoint: DurableCheckpoint }
  | { readonly kind: "unknown" };

/** Classify and decode one DBOS checkpoint payload without reinterpreting marked formats. */
export function classifyCheckpointPayload(
  workflowId: string,
  stepName: string,
  value: WorkflowSerializableValue,
): DbosCheckpointCompatibility {
  if (!hasCheckpointEnvelopeMarker(value) || !isCurrentDurableFormat(value.v)) return { kind: "unknown" };
  const hasOutput = value["hasOutput"];
  const containsOutput = value["output"] !== undefined;
  if (value["checkpointId"] !== stepName || typeof hasOutput !== "boolean" || hasOutput !== containsOutput) {
    return { kind: "unknown" };
  }
  const checkpoint = decodeEnvelope(workflowId, value as DbosCheckpointEnvelope);
  return checkpoint === undefined ? { kind: "unknown" } : { kind: "current", checkpoint };
}

/** Decode one current DBOS checkpoint envelope. */
export function decodeToCheckpoint(
  workflowId: string,
  stepName: string,
  value: WorkflowSerializableValue,
): DurableCheckpoint | undefined {
  const classified = classifyCheckpointPayload(workflowId, stepName, value);
  return classified.kind === "current" ? classified.checkpoint : undefined;
}

function decodeEnvelope(workflowId: string, env: DbosCheckpointEnvelope): DurableCheckpoint | undefined {
  if (typeof env.checkpointId !== "string" || env.checkpointId.length === 0
    || typeof env.completedAt !== "number" || !Number.isFinite(env.completedAt)
    || (env.name !== undefined && typeof env.name !== "string")
    || (env.hasOutput !== undefined && typeof env.hasOutput !== "boolean")) return undefined;
  const common = { workflowId, checkpointId: env.checkpointId, completedAt: env.completedAt };
  if (env.kind === "tool") {
    if (typeof env.argsHash !== "string" || env.output === undefined) return undefined;
    const topology = env.topology === undefined ? undefined : toolTopology(env.topology);
    if (env.topology !== undefined && topology === undefined) return undefined;
    return {
      kind: "tool",
      ...common,
      name: env.name ?? "tool",
      argsHash: env.argsHash,
      output: env.output,
      ...(topology !== undefined ? { topology } : {}),
    } as DurableToolCheckpoint;
  }
  if (env.kind === "ui") {
    if (typeof env.promptHash !== "string" || !isUiPromptKind(env.promptKind) || env.output === undefined
      || (env.message !== undefined && typeof env.message !== "string")) return undefined;
    return {
      kind: "ui",
      ...common,
      promptKind: env.promptKind,
      message: env.message ?? "",
      promptHash: env.promptHash,
      response: env.output,
    } as DurableUiCheckpoint;
  }
  const topology = stageTopology(env.topology);
  if (env.kind !== "stage" || topology === undefined
    || (env.replayKey !== undefined && typeof env.replayKey !== "string")
    || (env.sessionId !== undefined && typeof env.sessionId !== "string")
    || (env.sessionFile !== undefined && typeof env.sessionFile !== "string")
    || !isOptionalFiniteNumber(env.startedAt)
    || !isOptionalFiniteNumber(env.endedAt)
    || !isOptionalFiniteNumber(env.durationMs)
    || (env.result !== undefined && typeof env.result !== "string")
    || (env.model !== undefined && typeof env.model !== "string")
    || (env.fastMode !== undefined && typeof env.fastMode !== "boolean")
    || (env.attemptedModels !== undefined && !isStringArray(env.attemptedModels))
    || (env.modelAttempts !== undefined && !isModelAttempts(env.modelAttempts))) return undefined;
  return {
    kind: "stage",
    ...common,
    name: env.name ?? "stage",
    replayKey: env.replayKey ?? env.checkpointId,
    ...(env.hasOutput !== false && env.output !== undefined ? { output: env.output } : {}),
    topology,
    ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}),
    ...(env.sessionFile !== undefined ? { sessionFile: env.sessionFile } : {}),
    ...(typeof env.startedAt === "number" ? { startedAt: env.startedAt } : {}),
    ...(typeof env.endedAt === "number" ? { endedAt: env.endedAt } : {}),
    ...(typeof env.durationMs === "number" ? { durationMs: env.durationMs } : {}),
    ...(typeof env.result === "string" ? { result: env.result } : {}),
    ...(typeof env.model === "string" ? { model: env.model } : {}),
    ...(typeof env.fastMode === "boolean" ? { fastMode: env.fastMode } : {}),
    ...(isStringArray(env.attemptedModels) ? { attemptedModels: env.attemptedModels } : {}),
    ...(Array.isArray(env.modelAttempts) ? { modelAttempts: env.modelAttempts as DurableStageCheckpoint["modelAttempts"] } : {}),
  } as DurableStageCheckpoint;
}


function toolTopology(value: WorkflowSerializableValue): DurableToolTopology | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, WorkflowSerializableValue>;
  if (record["version"] !== DURABLE_TOOL_TOPOLOGY_VERSION
    || typeof record["nodeId"] !== "string"
    || typeof record["ordinal"] !== "number" || !Number.isInteger(record["ordinal"])
    || typeof record["order"] !== "number" || !Number.isInteger(record["order"])
    || !isStringArray(record["parentIds"])
    || !isOptionalFiniteNumber(record["startedAt"])
    || !isOptionalFiniteNumber(record["endedAt"])) return undefined;
  const run = stageRunTopology(record["run"]);
  if (record["run"] !== undefined && run === undefined) return undefined;
  return {
    version: DURABLE_TOOL_TOPOLOGY_VERSION,
    nodeId: record["nodeId"],
    ordinal: record["ordinal"],
    order: record["order"],
    parentIds: record["parentIds"],
    ...(typeof record["startedAt"] === "number" ? { startedAt: record["startedAt"] } : {}),
    ...(typeof record["endedAt"] === "number" ? { endedAt: record["endedAt"] } : {}),
    ...(run !== undefined ? { run } : {}),
  };
}

function stageTopology(value: WorkflowSerializableValue | undefined): DurableStageTopology | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, WorkflowSerializableValue>;
  if (record["version"] !== DURABLE_STAGE_TOPOLOGY_VERSION
    || typeof record["stageId"] !== "string" || !isStringArray(record["parentIds"])) return undefined;
  const run = stageRunTopology(record["run"]);
  if (record["run"] !== undefined && run === undefined) return undefined;
  return {
    version: DURABLE_STAGE_TOPOLOGY_VERSION,
    stageId: record["stageId"],
    parentIds: record["parentIds"],
    ...(typeof record["order"] === "number" && Number.isInteger(record["order"]) ? { order: record["order"] } : {}),
    ...(run !== undefined ? { run } : {}),
  };
}

function stageRunTopology(value: WorkflowSerializableValue | undefined): NonNullable<DurableStageTopology["run"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const run = value as Record<string, WorkflowSerializableValue>;
  if (typeof run["runId"] !== "string" || typeof run["runName"] !== "string") return undefined;
  for (const key of ["parentRunId", "parentStageId", "rootRunId"] as const) {
    if (run[key] !== undefined && typeof run[key] !== "string") return undefined;
  }
  return {
    runId: run["runId"],
    runName: run["runName"],
    ...(typeof run["parentRunId"] === "string" ? { parentRunId: run["parentRunId"] } : {}),
    ...(typeof run["parentStageId"] === "string" ? { parentStageId: run["parentStageId"] } : {}),
    ...(typeof run["rootRunId"] === "string" ? { rootRunId: run["rootRunId"] } : {}),
  };
}

function isModelAttempts(value: WorkflowSerializableValue | undefined): boolean {
  return Array.isArray(value) && value.every((attempt) => {
    if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) return false;
    const record = attempt as Record<string, WorkflowSerializableValue>;
    return typeof record["model"] === "string"
      && typeof record["success"] === "boolean"
      && (record["reasoningLevel"] === undefined || isReasoningLevel(record["reasoningLevel"]))
      && (record["error"] === undefined || typeof record["error"] === "string")
      && (record["usage"] === undefined || isModelUsage(record["usage"]));
  });
}

function isReasoningLevel(value: WorkflowSerializableValue): boolean {
  return value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max";
}

function isModelUsage(value: WorkflowSerializableValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, WorkflowSerializableValue>;
  return ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"]
    .every((key) => usage[key] === undefined || (typeof usage[key] === "number" && Number.isFinite(usage[key])));
}

function isUiPromptKind(value: WorkflowSerializableValue | undefined): value is UiPromptKind {
  return value === "input" || value === "confirm" || value === "select"
    || value === "editor" || value === "custom";
}

function isOptionalFiniteNumber(value: WorkflowSerializableValue | undefined): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isStringArray(value: WorkflowSerializableValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkpointOutputValue(cp: DurableCheckpoint): WorkflowSerializableValue | undefined {
  if (cp.kind === "tool") return (cp as DurableToolCheckpoint).output;
  if (cp.kind === "ui") return (cp as DurableUiCheckpoint).response;
  const stage = cp as DurableStageCheckpoint;
  return "output" in stage ? stage.output : undefined;
}
