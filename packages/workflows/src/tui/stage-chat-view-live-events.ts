import type { AgentSessionEvent } from "@bastani/atomic";
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
  if (ctx.chatHost.isStreaming()) return false;
  return isCurrentRunOrStageTerminal(ctx);
}

function isCurrentRunOrStageTerminal(ctx: StageChatViewContext): boolean {
  return (
    isTerminalStageChatState(ctx.lastObservedRunStatus) ||
    isTerminalStageChatState(ctx.lastObservedStageStatus)
  );
}

function isToolExecutionLiveEvent(event: AgentSessionEvent): boolean {
  const type = String((event as { type?: unknown }).type ?? "");
  return type === "tool_execution_start" || type === "tool_execution_update";
}
