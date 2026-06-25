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
export { FileDurableBackend, defaultDurableStateDir, durableStateFileFor } from "./file-backend.js";
export {
  isDbosConfigured,
  DbosDurableBackend,
  createDbosDurableBackend,
  type DbosSdkHandle,
  type DbosWorkflowInfo,
} from "./dbos-backend.js";
export {
  getDurableBackend,
  setDurableBackend,
  createInMemoryBackend,
  createDefaultFileBackend,
  createWorkflowFileBackend,
} from "./factory.js";
export {
  scanResumableWorkflows,
  listResumableFromBackend,
  persistDurableCacheEntry,
  formatResumableWorkflowList,
} from "./resume-catalog.js";
export {
  createToolPrimitive,
  createCheckpointIdGenerator,
  type WorkflowToolPrimitive,
  type WorkflowToolOptions,
} from "./tool-primitive.js";
export { wrapUiWithDurable, type DurableUiDeps } from "./ui-primitive.js";
export {
  recordStageCheckpoint,
  createStageReplayKeyGenerator,
  type DurableStageDeps,
} from "./stage-primitive.js";
export {
  resumeDurableWorkflow,
  resolveDurableEntry,
  type ResumeDurableDeps,
  type ResumeDurableResult,
} from "./resume-runtime.js";
