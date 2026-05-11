/**
 * pi-workflows
 * Public entry point — re-exports the authoring API and public types.
 */

export { defineWorkflow } from "./workflows/define-workflow.js";
export { createRegistry } from "./workflows/registry.js";
export { normalizeWorkflowName, workflowNamesEqual } from "./workflows/identity.js";
export type * from "./shared/types.js";
export type * from "./types.js";

// Phase C — DAG executor
export { run, resolveInputs } from "./runs/sync/executor.js";
export type { RunOpts, RunResult, ResolvedInputs } from "./runs/sync/executor.js";
export type { PromptAdapter, CompleteAdapter, SubagentAdapter, StageAdapters } from "./runs/sync/stage-runner.js";
export { GraphFrontierTracker } from "./runs/shared/graph-inference.js";
export type { StageNode } from "./runs/shared/graph-inference.js";
export { createStore, store } from "./store.js";
export type { RunStatus, StageStatus, ToolEvent, StageSnapshot, RunSnapshot, StoreSnapshot } from "./store-types.js";

// Phase D — cancellation registry
export { createCancellationRegistry, cancellationRegistry } from "./runs/detach/cancellation-registry.js";
export type { CancellationRegistry, ActiveRunEntry } from "./runs/detach/cancellation-registry.js";
