/**
 * Non-cyclic public SDK surface for @bastani/workflows.
 *
 * Keep public runtime exports here when they are safe to load during workflow
 * discovery. The package root re-exports this module directly.
 */

export { workflow } from "./authoring/workflow.js";

const REMOVED_RUN_WORKFLOW_MESSAGE =
  "@bastani/workflows no longer exports runWorkflow; author workflows with workflow({...})";

/**
 * @deprecated Removed imperative workflow API. Kept as a runtime migration
 * stub so older workflow modules fail at the call site with a clear message.
 */
export const runWorkflow: never = (() => {
  throw new Error(REMOVED_RUN_WORKFLOW_MESSAGE);
}) as never;

export { createRegistry } from "./workflows/registry.js";
export { normalizeWorkflowName, workflowNamesEqual } from "./workflows/identity.js";
export type * from "./shared/types.js";
export { INTERACTIVE_WORKFLOW_POLICY, NON_INTERACTIVE_WORKFLOW_POLICY } from "./shared/types.js";
export type { AuthoredWorkflowDefinition, AuthoredWorkflowSpec, WorkflowInputsFromSchemas, WorkflowOutputsFromSchemas, WorkflowProvidedInputsFromSchemas } from "./authoring/workflow.js";
export type { WorkflowRegistry } from "./workflows/registry.js";

export { run, runTask, runParallel, runChain, resolveInputs } from "./runs/foreground/executor.js";
export type { RunOpts, RunResult, ResolvedInputs } from "./runs/foreground/executor.js";
export type { AgentSessionAdapter, StageAdapters } from "./runs/foreground/stage-runner.js";
export { GraphFrontierTracker } from "./runs/shared/graph-inference.js";
export type { StageNode } from "./runs/shared/graph-inference.js";
export { setupGitWorktree } from "./runs/shared/worktree.js";
export type { GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./runs/shared/worktree.js";
export { createStore, store } from "./shared/store.js";
export type { RunStatus, StageStatus, ToolEvent, StageSnapshot, RunSnapshot, StoreSnapshot, WorkflowNotice, NoticeLevel, WorkflowOverlayAdapter, PromptKind, CustomPromptIdentitySource, PendingPrompt } from "./shared/store-types.js";

// Phase D — cancellation registry
export { createCancellationRegistry, cancellationRegistry } from "./runs/background/cancellation-registry.js";
export type { CancellationRegistry, ActiveRunEntry } from "./runs/background/cancellation-registry.js";
