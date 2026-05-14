/**
 * atomic-workflows
 * Public entry point — re-exports the authoring API and public types.
 */

export { defineWorkflow } from "./workflows/define-workflow.js";
export { createRegistry } from "./workflows/registry.js";
export { normalizeWorkflowName, workflowNamesEqual } from "./workflows/identity.js";
export type * from "./shared/types.js";
export type { WorkflowBuilder, CompletedWorkflowBuilder } from "./workflows/define-workflow.js";
export type { WorkflowRegistry } from "./workflows/registry.js";

export { run, runTask, runParallel, runChain, resolveInputs } from "./runs/foreground/executor.js";
export type { RunOpts, RunResult, ResolvedInputs } from "./runs/foreground/executor.js";
export { parseWorkflowSdkFlags, runWorkflowSdkEntrypoint, runWorkflowSdkSpec } from "./runs/shared/workflow-sdk-entrypoint.js";
export type { WorkflowSdkEntrypointOptions, WorkflowSdkEntrypointResult, WorkflowSdkEntrypointSpec, WorkflowSdkFlagParseResult } from "./runs/shared/workflow-sdk-entrypoint.js";
export type { AgentSessionAdapter, StageAdapters } from "./runs/foreground/stage-runner.js";
export { GraphFrontierTracker } from "./runs/shared/graph-inference.js";
export type { StageNode } from "./runs/shared/graph-inference.js";
export { createStore, store } from "./shared/store.js";
export type { RunStatus, StageStatus, ToolEvent, StageSnapshot, RunSnapshot, StoreSnapshot, WorkflowNotice, NoticeLevel, WorkflowOverlayAdapter, PromptKind, PendingPrompt } from "./shared/store-types.js";

// Phase D — cancellation registry
export { createCancellationRegistry, cancellationRegistry } from "./runs/background/cancellation-registry.js";
export type { CancellationRegistry, ActiveRunEntry } from "./runs/background/cancellation-registry.js";
