/**
 * Non-cyclic public SDK surface for @bastani/workflows.
 *
 * Keep public runtime exports here when they are safe to load during workflow
 * discovery. The package root re-exports this module directly.
 */

export type { Static, TSchema } from "typebox";
export { KEEP_CONTEXT_CLOSE_TAG, KEEP_CONTEXT_OPEN_TAG, keepContext } from "./authoring/keep-context.js";
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

export type {
	AuthoredWorkflowDefinition,
	AuthoredWorkflowSpec,
	WorkflowInputsFromSchemas,
	WorkflowOutputsFromSchemas,
	WorkflowProvidedInputsFromSchemas,
} from "./authoring/workflow.js";
export type { StageNode } from "./engine/graph-inference.js";
export { GraphFrontierTracker } from "./engine/graph-inference.js";
export type { ActiveRunEntry, CancellationRegistry } from "./runs/background/cancellation-registry.js";
// Phase D — cancellation registry
export { cancellationRegistry, createCancellationRegistry } from "./runs/background/cancellation-registry.js";
export type { ResolvedInputs, RunOpts, RunResult } from "./runs/foreground/executor.js";

export { resolveInputs, run } from "./runs/foreground/executor.js";
export type { AgentSessionAdapter, StageAdapters } from "./runs/foreground/stage-runner.js";
export type { GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./runs/shared/worktree.js";
export { setupGitWorktree } from "./runs/shared/worktree.js";
export { createStore, store } from "./shared/store.js";
export type {
	CustomPromptIdentitySource,
	NoticeLevel,
	PendingPrompt,
	PromptKind,
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	StoreSnapshot,
	ToolEvent,
	ToolNodeSnapshot,
	WorkflowNotice,
	WorkflowOverlayAdapter,
} from "./shared/store-types.js";
export type * from "./shared/types.js";
export { INTERACTIVE_WORKFLOW_POLICY, NON_INTERACTIVE_WORKFLOW_POLICY } from "./shared/types.js";
export { normalizeWorkflowName, workflowNamesEqual } from "./workflows/identity.js";
export type { WorkflowRegistry } from "./workflows/registry.js";
export { createRegistry } from "./workflows/registry.js";
