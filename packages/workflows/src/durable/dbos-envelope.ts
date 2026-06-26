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
 * The envelope is forward-compatible: old/simple payloads (plain values without
 * the envelope marker) are treated as generic stage outputs during hydration.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */

import type { WorkflowSerializableObject, WorkflowSerializableValue } from "../shared/types.js";
import type {
  DurableCheckpoint,
  DurableCheckpointKind,
  DurableStageCheckpoint,
  DurableToolCheckpoint,
  DurableUiCheckpoint,
  UiPromptKind,
} from "./types.js";

/** Envelope schema version. */
export const DBOS_ENVELOPE_VERSION = 1;

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
}

/**
 * Encode a durable checkpoint into a DBOS step-output envelope.
 */
export function encodeCheckpoint(cp: DurableCheckpoint): DbosCheckpointEnvelope {
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
    return { ...base, name: t.name, argsHash: t.argsHash };
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
    ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
    ...(s.sessionFile !== undefined ? { sessionFile: s.sessionFile } : {}),
  };
}

/**
 * Type guard: is this value a checkpoint envelope?
 */
export function isCheckpointEnvelope(value: WorkflowSerializableValue | undefined): value is DbosCheckpointEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj[ENVELOPE_MARKER] === ENVELOPE_MARKER;
}

/**
 * Decode a DBOS step output into a durable checkpoint.
 *
 * - Envelope payloads reconstruct the full checkpoint with original metadata.
 * - Non-envelope payloads (legacy/simple) produce a generic stage checkpoint
 *   so the output is still discoverable during replay.
 *
 * Returns `undefined` if the payload cannot be interpreted.
 */
export function decodeToCheckpoint(
  workflowId: string,
  stepName: string,
  value: WorkflowSerializableValue,
): DurableCheckpoint | undefined {
  if (isCheckpointEnvelope(value)) return decodeEnvelope(workflowId, value);
  if (value === undefined) return undefined;
  return decodeLegacy(workflowId, stepName, value);
}

function decodeEnvelope(workflowId: string, env: DbosCheckpointEnvelope): DurableCheckpoint | undefined {
  const common = { workflowId, checkpointId: env.checkpointId, completedAt: env.completedAt };
  if (env.kind === "tool") {
    if (env.argsHash === undefined || env.output === undefined) return undefined;
    return {
      kind: "tool",
      ...common,
      name: env.name ?? "tool",
      argsHash: env.argsHash,
      output: env.output,
    } as DurableToolCheckpoint;
  }
  if (env.kind === "ui") {
    if (env.promptHash === undefined || env.promptKind === undefined || env.output === undefined) return undefined;
    return {
      kind: "ui",
      ...common,
      promptKind: env.promptKind,
      message: env.message ?? "",
      promptHash: env.promptHash,
      response: env.output,
    } as DurableUiCheckpoint;
  }
  return {
    kind: "stage",
    ...common,
    name: env.name ?? "stage",
    replayKey: env.replayKey ?? env.checkpointId,
    ...(env.hasOutput !== false && env.output !== undefined ? { output: env.output } : {}),
    ...(env.sessionId !== undefined ? { sessionId: env.sessionId } : {}),
    ...(env.sessionFile !== undefined ? { sessionFile: env.sessionFile } : {}),
  } as DurableStageCheckpoint;
}

function decodeLegacy(
  workflowId: string,
  stepName: string,
  output: WorkflowSerializableValue,
): DurableStageCheckpoint {
  return {
    kind: "stage",
    workflowId,
    checkpointId: `stage:${stepName}`,
    name: stepName,
    replayKey: stepName,
    output,
    completedAt: Date.now(),
  };
}

function checkpointOutputValue(cp: DurableCheckpoint): WorkflowSerializableValue | undefined {
  if (cp.kind === "tool") return (cp as DurableToolCheckpoint).output;
  if (cp.kind === "ui") return (cp as DurableUiCheckpoint).response;
  const stage = cp as DurableStageCheckpoint;
  return "output" in stage ? stage.output : undefined;
}
