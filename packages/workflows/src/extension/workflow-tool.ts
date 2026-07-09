import { inspectRun } from "../runs/background/status.js";
import type { WorkflowExecutionPolicy, WorkflowPersistencePort } from "../shared/types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { workflowGetResult } from "./workflow-tool-content.js";
import {
  directModeCount,
  hasDirectExecutionMode,
  hasNamedExecutionMode,
  withForkParentSession,
  workflowRunResultFromDetails,
} from "./workflow-tool-helpers.js";
import {
  workflowInterruptAction,
  workflowKillAction,
  workflowPauseAction,
  workflowReloadAction,
  workflowResumeAction,
} from "./workflow-tool-control.js";
import {
  workflowStageResult,
  workflowStagesResult,
  workflowTranscriptResult,
} from "./workflow-tool-inspection.js";
import { workflowSendAction } from "./workflow-tool-send.js";
import { isWorkflowStageToolContext, topLevelExpandedSnapshots } from "./workflow-targets.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";

export function makeExecuteWorkflowTool(
  runtime: ExtensionRuntime | ((ctx: PiExecuteContext) => ExtensionRuntime),
  getPersistence: () => WorkflowPersistencePort | undefined,
  reloadWorkflowResources: () => Promise<void> | void,
  ensureWorkflowResourcesLoaded: () => Promise<void> | void = () => {},
): (args: WorkflowToolArgs, ctx: PiExecuteContext) => Promise<WorkflowToolResult> {
  return async function executeWorkflowTool(
    args: WorkflowToolArgs,
    ctx: PiExecuteContext,
  ): Promise<WorkflowToolResult> {
    const action = args.action ?? "run";
    const runId = args.runId ?? "";
    if (isWorkflowStageToolContext(ctx)) {
      return {
        action: "run",
        runId,
        status: "failed",
        error: "workflows cannot invoke workflows from workflow stages",
        stages: [],
      };
    }
    const policy: WorkflowExecutionPolicy = workflowPolicyFromContext(ctx);
    const getRuntime = (): ExtensionRuntime => typeof runtime === "function" ? runtime(ctx) : runtime;
    const ensureWorkflowResourcesVisible = async (): Promise<void> => {
      try {
        await ensureWorkflowResourcesLoaded();
      } catch (error) {
        ctx.ui?.notify?.(formatWorkflowResourceLoadWarning(error), "warning");
      }
    };

    switch (action) {
      case "get":
        await ensureWorkflowResourcesVisible();
        return workflowGetResult(getRuntime(), args);
      case "list":
      case "inputs": {
        await ensureWorkflowResourcesVisible();
        return getRuntime().dispatch(args, { policy });
      }
      case "run": {
        if (hasDirectExecutionMode(args)) {
          const activeRuntime = getRuntime();
          const normalModeCount = directModeCount(args) + (hasNamedExecutionMode(args) ? 1 : 0);
          if (normalModeCount !== 1) {
            throw new Error("Workflow extension: specify exactly one normal execution mode: workflow, task, tasks, or chain");
          }
          const details = await activeRuntime.runDirect(withForkParentSession(args, ctx), { policy });
          return workflowRunResultFromDetails(details);
        }
        await ensureWorkflowResourcesVisible();
        return getRuntime().dispatch(args, { policy });
      }
      case "status": {
        const target = args.runId;
        if (target !== undefined) {
          const result = inspectRun(target);
          return result.ok
            ? { action: "statusDetail", runId: result.runId, detail: result.detail }
            : { action: "statusDetail", runId: target, error: `run not found: ${target}` };
        }
        return { action: "status", snapshots: topLevelExpandedSnapshots() };
      }
      case "stages":
        return workflowStagesResult(args);
      case "stage":
        return workflowStageResult(args);
      case "transcript":
        return workflowTranscriptResult(args);
      case "send":
        return workflowSendAction(args);
      case "pause":
        return workflowPauseAction(args);
      case "reload":
        return workflowReloadAction(args, { reloadWorkflowResources });
      case "kill":
        return workflowKillAction(args, { getPersistence });
      case "interrupt":
        return workflowInterruptAction(args);
      case "resume":
        return workflowResumeAction(args, { getRuntime, policy, ensureWorkflowResourcesLoaded });
      default: {
        const _exhaustive: never = action;
        throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
      }
    }
  };
}
