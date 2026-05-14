/**
 * Render the workflow tool call as a compact string for display in chat.
 * cross-ref: pi-subagents src/extension/index.ts renderCall slot
 */

export interface WorkflowToolArgs {
  workflow?: string;
  inputs?: Record<string, unknown>;
  action?: "run" | "list" | "get" | "status" | "interrupt" | "resume" | "inputs" | "doctor";
  runId?: string;
}

/**
 * Returns a compact human-readable string describing the tool invocation.
 * Used in the renderCall slot of the workflow tool registration.
 */
export function renderCall(args: WorkflowToolArgs): string {
  const action = args.action ?? "run";
  const name = args.workflow ?? args.runId ?? "(unnamed)";

  switch (action) {
    case "list":
      return "workflow: list registered workflows";
    case "status":
      return "workflow: list in-flight runs";
    case "inputs":
      return `workflow: show inputs for "${name}"`;
    case "run":
      return `workflow: run "${name}"`;
    case "interrupt":
      return `workflow: interrupt run "${name}"`;
    case "resume":
      return `workflow: resume run "${name}"`;
    case "get":
      return `workflow: get "${name}"`;
    case "doctor":
      return "workflow: doctor";
    default:
      return `workflow: ${action} "${name}"`;
  }
}
