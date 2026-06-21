import { renderCall } from "./render-call.js";
import { renderResult } from "./render-result.js";
import type { WorkflowToolResult } from "./render-result.js";
import { WorkflowParametersSchema } from "./workflow-schema.js";
import { dynamicTextRenderComponent } from "./render-component.js";
import type { ExtensionAPI, PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import { DEFAULT_PROMPT_GUIDANCE, WORKFLOW_TOOL_DESCRIPTION } from "./workflow-prompts.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { renderWorkflowToolContent } from "./workflow-tool-content.js";

export function registerWorkflowTool(
  pi: ExtensionAPI,
  executeWorkflowTool: (
    args: WorkflowToolArgs,
    ctx: PiExecuteContext,
  ) => Promise<WorkflowToolResult>,
  runWithLifecycleSuppressedForPolicy: <T>(
    policy: ReturnType<typeof workflowPolicyFromContext>,
    fn: () => Promise<T>,
  ) => Promise<T>,
): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool<WorkflowToolArgs, WorkflowToolResult>({
    name: "workflow",
    label: "workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    parameters: WorkflowParametersSchema,
    promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
    renderShell: "self",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const policy = workflowPolicyFromContext(ctx);
      const details = (params.action ?? "run") === "run"
        ? await runWithLifecycleSuppressedForPolicy(policy, () => executeWorkflowTool(params, ctx))
        : await executeWorkflowTool(params, ctx);
      return {
        content: [{ type: "text", text: renderWorkflowToolContent(details, params) }],
        details,
      };
    },
    renderCall: (args, _theme, _context) =>
      dynamicTextRenderComponent((width) => renderCall(args, { width })),
    renderResult: (result, opts, _theme, context) => {
      const capturedNow = Date.now();
      return dynamicTextRenderComponent((width) =>
        renderResult(result.details, {
          ...opts,
          width,
          now: capturedNow,
          runInputs: (context as { args?: WorkflowToolArgs }).args?.inputs,
        }),
      );
    },
  });
}
