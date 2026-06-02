/**
 * workflows
 * Public entry point — re-exports the authoring API and public types.
 */

// Add new non-cyclic public runtime exports to sdk-surface.ts so the Bun
// virtual SDK used by workflow discovery stays in lockstep with this entry.
export * from "./sdk-surface.js";

// runWorkflow is exported here only: workflow-runner imports discovery.ts, so
// discovery provides a lazy wrapper instead of importing this entry eagerly.
export { runWorkflow } from "./runs/shared/workflow-runner.js";
export type { WorkflowOptions, WorkflowRunOptions } from "./runs/shared/workflow-runner.js";

// Note: `Type` / `Static` / `TSchema` are re-exported via ./sdk-surface.js.
