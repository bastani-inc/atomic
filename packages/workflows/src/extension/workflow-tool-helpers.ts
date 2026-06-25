import type { WorkflowDetails } from "../shared/types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";

export function hasDirectExecutionMode(args: WorkflowToolArgs): boolean {
  return (
    (args.task !== undefined && typeof args.task === "object") ||
    Array.isArray(args.tasks) ||
    Array.isArray(args.chain)
  );
}

export function directModeCount(args: WorkflowToolArgs): number {
  return [
    args.task !== undefined && typeof args.task === "object",
    Array.isArray(args.tasks),
    Array.isArray(args.chain),
  ].filter(Boolean).length;
}

export function hasNamedExecutionMode(args: WorkflowToolArgs): boolean {
  return typeof args.workflow === "string" && args.workflow.trim().length > 0;
}

function directRequestsFork(args: WorkflowToolArgs): boolean {
  if (args.context === "fork") return true;
  if (
    args.task !== undefined &&
    typeof args.task === "object" &&
    args.task.context === "fork"
  ) return true;
  if (args.tasks?.some((task) => task.context === "fork")) return true;
  return (
    args.chain?.some((step) =>
      "parallel" in step
        ? step.parallel.some((task) => task.context === "fork")
        : step.context === "fork",
    ) ?? false
  );
}

export function withForkParentSession(
  args: WorkflowToolArgs,
  ctx: PiExecuteContext,
): WorkflowToolArgs {
  if (!directRequestsFork(args) || args.forkFromSessionFile !== undefined) return args;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.length > 0
    ? { ...args, forkFromSessionFile: sessionFile }
    : args;
}

export function workflowRunResultFromDetails(
  details: WorkflowDetails,
): WorkflowToolResult {
  return {
    action: "run",
    name: `direct-${details.mode}`,
    runId: details.runId ?? "",
    status: details.status,
    result: details.output,
    details,
    error: details.error,
    stages: [],
  };
}
