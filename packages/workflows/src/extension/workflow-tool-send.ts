import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import {
  ensurePostMortemStageHandle,
  type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { store } from "../shared/store.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import {
  coerceStageInputAnswer,
  hasStageInputAnswerContent,
  type StageInputAnswer,
} from "../shared/stage-prompt.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { WorkflowToolArgs } from "./public-types.js";
import {
  ambiguousRunMessage,
  resolveToolRunTarget,
  resolveToolStageTarget,
} from "./workflow-targets.js";

/**
 * Optional dependencies enabling `workflow send` to revive an eligible terminal
 * agent stage as a post-mortem chat when no process-local handle exists.
 */
export interface WorkflowSendDeps {
  readonly resolvePostMortemDeps?: (runId: string) => PostMortemStageChatDeps;
}

function hasPayloadProperty(args: WorkflowToolArgs): boolean {
  return args.text !== undefined || args.response !== undefined || args.message !== undefined;
}

function promptPayloadFromArgs(args: WorkflowToolArgs): unknown {
  if (args.response !== undefined) return args.response;
  if (args.text !== undefined) return args.text;
  return args.message;
}

function textPayloadFromArgs(args: WorkflowToolArgs): string | undefined {
  if (args.text !== undefined) return args.text;
  if (typeof args.response === "string") return args.response;
  if (args.message !== undefined) return args.message;
  return undefined;
}

function brokerAnswerFromArgs(args: WorkflowToolArgs): StageInputAnswer {
  if (args.response !== undefined) {
    const coerced = coerceStageInputAnswer(args.response);
    if (hasStageInputAnswerContent(coerced)) return coerced;
  }
  const text = textPayloadFromArgs(args);
  return text !== undefined ? { text } : {};
}

type WorkflowSendToolResult = Extract<WorkflowToolResult, { action: "send" }>;

function workflowSendResult(
  runId: string,
  stageId: string,
  delivery: WorkflowSendToolResult["delivery"],
  status: WorkflowSendToolResult["status"],
  message: string,
): WorkflowSendToolResult {
  return { action: "send", runId, stageId, delivery, status, message };
}

async function deliverStageUserMessage(
  handle: StageControlHandle,
  text: string,
  deliverAs?: "steer" | "followUp",
): Promise<StageUserMessageDeliveryAction> {
  if (handle.sendUserMessage !== undefined) return handle.sendUserMessage(text, { deliverAs });
  if (!handle.isStreaming) {
    await handle.prompt(text);
    return "prompt";
  }
  if (deliverAs === "steer") {
    await handle.steer(text);
    return "steer";
  }
  await handle.followUp(text);
  return "followUp";
}

function deliveryMessage(delivery: StageUserMessageDeliveryAction): string {
  if (delivery === "prompt") return "Prompt started for stage.";
  if (delivery === "steer") return "Steered live stage.";
  if (delivery === "followUp") return "Follow-up queued for stage.";
  return "Message handled by stage extension.";
}

export async function workflowSendAction(
  args: WorkflowToolArgs,
  deps: WorkflowSendDeps = {},
): Promise<WorkflowSendToolResult> {
  const target = resolveToolRunTarget(args, "No active run to message.");
  const requestedDelivery = args.delivery ?? "auto";
  if (target.kind === "all") {
    return workflowSendResult("--all", "", requestedDelivery, "noop", "Send requires a single run.");
  }
  if (target.kind === "ambiguous") {
    return workflowSendResult(target.target, "", requestedDelivery, "noop", ambiguousRunMessage(target.target, target.matches));
  }
  if (target.kind === "not_found") {
    return workflowSendResult(target.target, "", requestedDelivery, "noop", target.message);
  }
  const stage = resolveToolStageTarget(target.runId, args.stageId);
  if (!stage.ok || stage.stageId === undefined) {
    return workflowSendResult(
      target.runId,
      "",
      requestedDelivery,
      "noop",
      stage.ok ? "Stage id, prefix, or name is required." : stage.message,
    );
  }
  const stageRunId = stage.runId ?? target.runId;
  const run = store.runs().find((r) => r.id === stageRunId);
  const snapshot = run?.stages.find((s) => s.id === stage.stageId);
  const brokerPrompt = stageUiBroker.peekStagePrompt(stageRunId, stage.stageId);
  const targetsBrokerPrompt =
    brokerPrompt !== undefined &&
    (args.promptId === undefined || args.promptId === brokerPrompt.id) &&
    (requestedDelivery === "answer" || args.promptId !== undefined || requestedDelivery === "auto");
  if (targetsBrokerPrompt && brokerPrompt !== undefined) {
    if (!hasPayloadProperty(args)) {
      return workflowSendResult(stageRunId, stage.stageId, "answer", "noop", "Send requires text, response, or message.");
    }
    const ok = stageUiBroker.answerStagePrompt(stageRunId, stage.stageId, brokerAnswerFromArgs(args), {
      answerSource: "workflow_tool",
    });
    return workflowSendResult(
      stageRunId,
      stage.stageId,
      "answer",
      ok ? "ok" : "noop",
      ok ? `Answered input request ${brokerPrompt.id}.` : `No matching pending input request ${brokerPrompt.id}.`,
    );
  }
  const customPrompt = snapshot?.status === "awaiting_input" && snapshot.promptFootprint?.kind === "custom"
    ? snapshot.promptFootprint
    : undefined;
  const targetsCustomPrompt =
    customPrompt !== undefined &&
    (args.promptId === undefined || args.promptId === customPrompt.id) &&
    (requestedDelivery === "answer" || args.promptId !== undefined || requestedDelivery === "auto");
  if (targetsCustomPrompt && customPrompt !== undefined) {
    return workflowSendResult(
      stageRunId,
      stage.stageId,
      "answer",
      "noop",
      `Custom UI prompt ${customPrompt.id} requires the interactive workflow graph; arbitrary ctx.ui.custom<T> results cannot be answered through workflow send.`,
    );
  }
  const targetsPrompt =
    requestedDelivery === "answer" ||
    args.promptId !== undefined ||
    (requestedDelivery === "auto" && snapshot?.pendingPrompt !== undefined);
  if (targetsPrompt) {
    const promptId = args.promptId ?? snapshot?.pendingPrompt?.id;
    if (promptId === undefined) {
      return workflowSendResult(stageRunId, stage.stageId, "answer", "noop", "No pending prompt to answer.");
    }
    if (!hasPayloadProperty(args)) {
      return workflowSendResult(stageRunId, stage.stageId, "answer", "noop", "Send requires text, response, or message.");
    }
    if (stageUiBroker.wasStagePromptResolved(stageRunId, stage.stageId, promptId)) {
      return workflowSendResult(stageRunId, stage.stageId, "answer", "ok", `Input request ${promptId} was already answered.`);
    }
    const ok = store.resolveStagePendingPrompt(stageRunId, stage.stageId, promptId, promptPayloadFromArgs(args), {
      answerSource: "workflow_tool",
    });
    return workflowSendResult(
      stageRunId,
      stage.stageId,
      "answer",
      ok ? "ok" : "noop",
      ok ? `Answered prompt ${promptId}.` : `No matching pending prompt ${promptId}.`,
    );
  }
  const text = textPayloadFromArgs(args);
  if (text === undefined) {
    return workflowSendResult(stageRunId, stage.stageId, requestedDelivery, "noop", "Send requires text, response, or message.");
  }
  let handle: StageControlHandle | undefined = stageControlRegistry.get(stageRunId, stage.stageId);
  if (handle === undefined && deps.resolvePostMortemDeps !== undefined && snapshot !== undefined) {
    const revived = ensurePostMortemStageHandle(stageRunId, snapshot, deps.resolvePostMortemDeps(stageRunId));
    if (revived.ok) handle = revived.handle;
  }
  if (handle === undefined) {
    return workflowSendResult(stageRunId, stage.stageId, requestedDelivery, "noop", "No live handle for stage.");
  }
  // A completed post-mortem handle is not live execution: its handle-level
  // resume()/pause() reject by contract. Return a structured noop with guidance
  // instead of letting that rejection cross the tool boundary. Failed handles
  // remain eligible for their existing recoverable execution-resume semantics.
  const isTerminalPostMortemStage = handle.status === "completed";
  if (requestedDelivery === "resume" && handle.status !== "paused" && !isTerminalPostMortemStage) {
    return workflowSendResult(stageRunId, stage.stageId, "resume", "noop", "Stage is not paused; no resume message was delivered.");
  }
  if (handle.status === "paused" && requestedDelivery !== "resume" && requestedDelivery !== "auto") {
    return workflowSendResult(stageRunId, stage.stageId, requestedDelivery, "noop", "Stage is paused; resume it before sending a new message.");
  }
  if (requestedDelivery === "resume" || (requestedDelivery === "auto" && handle.status === "paused")) {
    if (isTerminalPostMortemStage) {
      return workflowSendResult(stageRunId, stage.stageId, "resume", "noop", "Cannot resume a terminal post-mortem stage; use delivery \"followUp\" or \"prompt\" to continue its retained conversation.");
    }
    const resumedDelivery = await handle.resume(text);
    if (resumedDelivery !== undefined && resumedDelivery !== "prompt") {
      return workflowSendResult(stageRunId, stage.stageId, resumedDelivery, "ok", deliveryMessage(resumedDelivery));
    }
    if (resumedDelivery === "prompt") {
      return workflowSendResult(stageRunId, stage.stageId, "prompt", "ok", "Resumed stage and started prompt.");
    }
    const hasResumeMessage = text.trim().length > 0;
    return workflowSendResult(
      stageRunId,
      stage.stageId,
      "resume",
      "ok",
      hasResumeMessage ? "Resumed interrupted stage with message." : "Resumed stage.",
    );
  }
  if (requestedDelivery === "steer") {
    if (isTerminalPostMortemStage) {
      return workflowSendResult(stageRunId, stage.stageId, "steer", "noop", "Cannot steer a terminal post-mortem stage; use delivery \"followUp\" or \"prompt\" to continue its retained conversation.");
    }
    const delivery = await deliverStageUserMessage(handle, text, "steer");
    return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
  }
  if (requestedDelivery === "auto" && handle.isStreaming && !isTerminalPostMortemStage) {
    const delivery = await deliverStageUserMessage(handle, text, "steer");
    return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
  }
  if (requestedDelivery === "prompt") {
    const delivery = await deliverStageUserMessage(handle, text);
    const message = delivery === "prompt" ? "Prompt sent to stage." : deliveryMessage(delivery);
    return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", message);
  }
  const delivery = await deliverStageUserMessage(handle, text, "followUp");
  return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
}
