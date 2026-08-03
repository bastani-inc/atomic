import type { AgentSessionEvent } from "@bastani/atomic";
import {
	hasActiveStageChatDelivery,
	reconcileStageChatDeliveryLifecycle,
} from "./stage-chat-view-delivery-activity.js";
import { isTerminalStageChatState } from "./stage-chat-view-status.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

export function applyStageChatLiveHandleEvent(ctx: StageChatViewContext, event: AgentSessionEvent): void {
	const staleTerminalStart = isStaleTerminalLifecycleStart(ctx, event);
	ctx.chatHost.applyAgentEvent(event);
	if (staleTerminalStart) {
		retainTerminalCleanup(ctx);
		return;
	}
	if (isCompactionEndEvent(event)) reconcileStageChatDeliveryLifecycle(ctx);
	if (!shouldCleanupAfterLiveEvent(ctx, event)) return;
	retainTerminalCleanup(ctx);
}

function retainTerminalCleanup(ctx: StageChatViewContext): void {
	const hadAnimationTick = ctx.chatHost.hasAnimationTick();
	ctx.chatHost.clearBusyForTerminalWorkflowStage();
	if (hadAnimationTick !== ctx.chatHost.hasAnimationTick()) ctx.requestRender?.();
}

/**
 * A turn start queued before the stage finished must not repaint Working on a
 * settled stage.
 *
 * The fence is armed only when this chat actually observed a terminal
 * transition and cleaned up in-flight work. Work admitted after that carries
 * its own authorization and is left alone: a live workflow delivery lease
 * (including one replayed at attach time), or a prompt this chat submitted
 * itself, which is already busy by the time its `agent_start` arrives.
 * `turn_start` is guarded too, otherwise it would restart the lifecycle a
 * suppressed `agent_start` just stopped.
 */
function isStaleTerminalLifecycleStart(ctx: StageChatViewContext, event: AgentSessionEvent): boolean {
	if (!ctx.terminalLifecycleFenced) return false;
	const type = String((event as { type?: unknown }).type ?? "");
	if (type !== "agent_start" && type !== "turn_start") return false;
	if (hasActiveStageChatDelivery(ctx)) return false;
	if (ctx.chatHost.isStreaming()) return false;
	return isCurrentRunOrStageTerminal(ctx);
}

function isCompactionEndEvent(event: AgentSessionEvent): boolean {
	return String((event as { type?: unknown }).type ?? "") === "compaction_end";
}

function shouldCleanupAfterLiveEvent(ctx: StageChatViewContext, event: AgentSessionEvent): boolean {
	if (!isToolExecutionLiveEvent(event)) return false;
	if (ctx.chatHost.isStreaming()) return false;
	return isCurrentRunOrStageTerminal(ctx);
}

function isCurrentRunOrStageTerminal(ctx: StageChatViewContext): boolean {
	return isTerminalStageChatState(ctx.lastObservedRunStatus) || isTerminalStageChatState(ctx.lastObservedStageStatus);
}

function isToolExecutionLiveEvent(event: AgentSessionEvent): boolean {
	const type = String((event as { type?: unknown }).type ?? "");
	return type === "tool_execution_start" || type === "tool_execution_update";
}
