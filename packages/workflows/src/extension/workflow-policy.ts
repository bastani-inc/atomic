import {
  INTERACTIVE_WORKFLOW_POLICY,
  NON_INTERACTIVE_WORKFLOW_POLICY,
  type WorkflowExecutionPolicy,
} from "../shared/types.js";

export const WORKFLOW_NON_INTERACTIVE_MESSAGE =
  "Workflows are policy-gated in non-interactive (-p) mode; deterministic workflows can run headlessly while runtime human input remains unavailable.";

export function workflowPolicyFromContext(ctx?: {
  readonly hasUI?: boolean;
}): WorkflowExecutionPolicy {
  if (ctx?.hasUI === false) return NON_INTERACTIVE_WORKFLOW_POLICY;
  return INTERACTIVE_WORKFLOW_POLICY;
}
