/**
 * Render the workflow tool call as a compact string for display in chat.
 * cross-ref: pi-subagents src/extension/index.ts renderCall slot
 */

import { truncateToWidth } from "../tui/text-helpers.js";

export interface WorkflowToolArgs {
  workflow?: string;
  inputs?: Record<string, unknown>;
  action?: "run" | "list" | "get" | "status" | "interrupt" | "kill" | "resume" | "inputs";
  runId?: string;
  task?: { name?: string; prompt?: string; task?: string } | string;
  tasks?: readonly unknown[];
  chain?: readonly unknown[];
}

function runTarget(args: WorkflowToolArgs): string | undefined {
  if (args.workflow !== undefined && args.workflow.trim().length > 0) return args.workflow;
  if (args.runId !== undefined && args.runId.trim().length > 0) return args.runId;
  if (args.task !== undefined) return "direct-task";
  if (args.tasks !== undefined) return "direct-parallel";
  if (args.chain !== undefined) return "direct-chain";
  return undefined;
}

function quoted(name: string | undefined): string {
  return name === undefined ? "" : `"${name}"`;
}

export interface RenderCallOpts {
  /** Optional host render width in terminal cells. */
  width?: number;
}

function fitLine(line: string, width?: number): string {
  if (width === undefined || width <= 0) return line;
  return truncateToWidth(line, width, "…");
}

/**
 * Returns a compact human-readable string describing the tool invocation.
 * Used in the renderCall slot of the workflow tool registration.
 */
export function renderCall(args: WorkflowToolArgs, opts: RenderCallOpts = {}): string {
  const action = args.action ?? "run";
  const name = runTarget(args);

  let line: string;
  switch (action) {
    case "list":
      line = "workflow: list registered workflows";
      break;
    case "status":
      line = "workflow: list in-flight runs";
      break;
    case "inputs":
      line = name === undefined
        ? "workflow: show inputs"
        : `workflow: show inputs for ${quoted(name)}`;
      break;
    case "run":
      line = name === undefined ? "workflow: run" : `workflow: run ${quoted(name)}`;
      break;
    case "interrupt":
      line = name === undefined
        ? "workflow: interrupt run"
        : `workflow: interrupt run ${quoted(name)}`;
      break;
    case "kill":
      line = name === undefined ? "workflow: kill run" : `workflow: kill run ${quoted(name)}`;
      break;
    case "resume":
      line = name === undefined
        ? "workflow: resume run"
        : `workflow: resume run ${quoted(name)}`;
      break;
    case "get":
      line = name === undefined ? "workflow: get" : `workflow: get ${quoted(name)}`;
      break;
    default:
      line = name === undefined ? `workflow: ${action}` : `workflow: ${action} ${quoted(name)}`;
      break;
  }
  return fitLine(line, opts.width);
}
