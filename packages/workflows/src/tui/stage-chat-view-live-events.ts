import type { AgentSessionEvent } from "@bastani/atomic";
import type { StageSnapshot } from "../shared/store-types.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";
import { isTerminalStageChatState } from "./stage-chat-view-status.js";

export function applyStageChatLiveHandleEvent(
  ctx: StageChatViewContext,
  event: AgentSessionEvent,
): void {
  ctx.chatHost.applyAgentEvent(event);
  if (!shouldCleanupAfterLiveEvent(ctx, event)) return;
  const hadAnimationTick = ctx.chatHost.hasAnimationTick();
  ctx.chatHost.clearBusyForTerminalWorkflowStage();
  if (hadAnimationTick !== ctx.chatHost.hasAnimationTick()) ctx.requestRender?.();
}

function shouldCleanupAfterLiveEvent(
  ctx: StageChatViewContext,
  event: AgentSessionEvent,
): boolean {
  if (!isToolExecutionLiveEvent(event)) return false;
  if (!isCurrentRunOrStageTerminal(ctx)) return false;
  return !ctx.chatHost.isStreaming();
}

function isCurrentRunOrStageTerminal(ctx: StageChatViewContext): boolean {
  const run = ctx.store.snapshot().runs.find((candidate) => candidate.id === ctx.runId);
  const stage = run?.stages.find((candidate: StageSnapshot) => candidate.id === ctx.stageId);
  return isTerminalStageChatState(run?.status) || isTerminalStageChatState(stage?.status);
}

function isToolExecutionLiveEvent(event: AgentSessionEvent): boolean {
  const type = String((event as { type?: unknown }).type ?? "");
  return type === "tool_execution_start" || type === "tool_execution_update";
}
