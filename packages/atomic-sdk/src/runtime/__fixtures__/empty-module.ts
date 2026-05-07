/**
 * Fixture: a module that neither calls `hostWorkflows([…])` nor
 * exports a default WorkflowDefinition. Used by
 * `orchestrator-entry.resolve.test.ts` to assert the
 * `InvalidWorkflowError` failure path.
 */
export const _placeholder = "no workflow registered";
