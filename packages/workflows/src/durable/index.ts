/**
 * Durable workflow backend — barrel export.
 *
 * cross-ref: issue #1498 — DBOS-backed cross-session resumability.
 */

export type {
  DurableCheckpoint,
  DurableCheckpointEntry,
  DurableStageCheckpoint,
  DurableToolCheckpoint,
  DurableUiCheckpoint,
  DurableWorkflowHandle,
  DurableWorkflowStatus,
  ResumableWorkflowEntry,
  UiPromptKind,
  WorkflowSerializableObject,
} from "./types.js";

export type { DurableWorkflowBackend } from "./backend.js";
export { InMemoryDurableBackend, durableHash } from "./backend.js";
export { FileDurableBackend, WorkflowFileDurableBackend, defaultDurableStateDir, durableStateFileFor } from "./file-backend.js";
export {
  isDbosConfigured,
  DbosDurableBackend,
  createDbosDurableBackend,
  type DbosSdkHandle,
  type DbosWorkflowInfo,
  type DbosStepRecord,
} from "./dbos-backend.js";
export {
  encodeCheckpoint,
  decodeToCheckpoint,
  isCheckpointEnvelope,
  DBOS_ENVELOPE_VERSION,
  type DbosCheckpointEnvelope,
} from "./dbos-envelope.js";
export {
  getDurableBackend,
  setDurableBackend,
  createInMemoryBackend,
  createDefaultFileBackend,
  createWorkflowFileBackend,
  initializeDbosDurableBackendFromEnv,
} from "./factory.js";
export {
  scanResumableWorkflows,
  listResumableFromBackend,
  persistDurableCacheEntry,
  formatResumableWorkflowList,
} from "./resume-catalog.js";
export {
  completedWorkflowSnapshot,
  listCompletedFromBackend,
  listOpenableCompletedWorkflows,
  resolveCompletedWorkflow,
  type CompletedWorkflowResolution,
} from "./completed-catalog.js";
export {
  openCompletedDurableWorkflow,
  type OpenCompletedDurableDeps,
  type OpenCompletedDurableResult,
} from "./completed-inspection.js";
export {
  createToolPrimitive,
  createCheckpointIdGenerator,
  type WorkflowToolPrimitive,
  type WorkflowToolOptions,
} from "./tool-primitive.js";
export { wrapUiWithDurable, type DurableUiDeps } from "./ui-primitive.js";
export {
  recordStageCheckpoint,
  createDurableStagePrimitive,
  createDurableTaskPrimitive,
  createStageReplayKeyGenerator,
  stableCheckpointId,
  type DurableStageDeps,
} from "./stage-primitive.js";
export {
  resumeDurableWorkflow,
  resolveDurableEntry,
  prepareDurableResume,
  type ResumeDurableDeps,
  type ResumeDurableResult,
} from "./resume-runtime.js";
