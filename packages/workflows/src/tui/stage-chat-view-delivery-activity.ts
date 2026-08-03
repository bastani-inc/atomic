/**
 * Maps workflow-owned stage delivery lifecycle facts onto the attached chat's
 * existing Working lifecycle.
 *
 * A workflow definition that auto-sends to its own retained stage starts a real
 * backend turn well before the public `agent_start` reaches this view. Without
 * this bridge the pane sits with `sdkBusy=false` and no requested render while
 * the model is already running, so it looks idle.
 *
 * Starting the host's ordinary lifecycle here — rather than synthesising an SDK
 * event — keeps `agent_start`, `turn_start`, `turn_end`, `agent_end`, retry,
 * fallback, compaction, and terminal cleanup in charge of everything after
 * startup, and lets a settled delivery that never produced a turn clean up.
 *
 * cross-ref: src/runs/foreground/stage-delivery-activity.ts
 */
import type { StageDeliveryActivityEvent } from "../runs/foreground/stage-delivery-activity.js";
import { isTerminalStageChatState } from "./stage-chat-view-status.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

export function subscribeStageChatDeliveryActivity(ctx: StageChatViewContext): (() => void) | null {
	const handle = ctx.handle;
	if (!handle?.subscribeDeliveryActivity) return null;
	return handle.subscribeDeliveryActivity((event) => {
		applyStageChatDeliveryActivityEvent(ctx, event);
	});
}

export function applyStageChatDeliveryActivityEvent(
	ctx: StageChatViewContext,
	event: StageDeliveryActivityEvent,
): void {
	if (event.type === "delivery_start") {
		// Replaces any lifecycle this same delivery id already owned; the map keeps
		// one live token per delivery so settlement stays correlated. A start that
		// arrives after terminal cleanup is fresh authorization for a retained
		// post-mortem turn, so it also lifts the stale-start fence.
		ctx.terminalLifecycleFenced = false;
		ctx.deliveryLifecycles.set(event.deliveryId, ctx.chatHost.beginExternalPromptLifecycle());
		return;
	}
	if (!ctx.deliveryLifecycles.has(event.deliveryId)) return;
	const generation = ctx.deliveryLifecycles.get(event.deliveryId);
	ctx.deliveryLifecycles.delete(event.deliveryId);
	// A pre-turn compaction reasserts one lifecycle and hands the same token to
	// every lease still open, so several deliveries can alias one generation.
	// Only the last owner may settle it; otherwise the first lease to finish
	// would stop Working while another accepted delivery is still running.
	// Distinct generations — including stale ones — keep reaching the host's own
	// generation fence exactly as before.
	if (!ownsStageChatLifecycleGeneration(ctx, generation)) {
		ctx.chatHost.settleExternalPromptLifecycle(generation);
	}
	// The map is the reference count: overlapping leases keep authorization open,
	// and the last one to settle on a finished stage restores stale-start
	// suppression. Otherwise the fence stayed open forever after the first
	// post-terminal delivery and a late start could repaint a settled chat.
	if (!hasActiveStageChatDelivery(ctx) && isStageChatContextTerminal(ctx)) {
		ctx.terminalLifecycleFenced = true;
	}
}

/** True while another still-active delivery references this exact lifecycle token. */
function ownsStageChatLifecycleGeneration(ctx: StageChatViewContext, generation: number | undefined): boolean {
	for (const active of ctx.deliveryLifecycles.values()) {
		if (active === generation) return true;
	}
	return false;
}

/** True while at least one admitted delivery still owns this chat's Working period. */
export function hasActiveStageChatDelivery(ctx: StageChatViewContext): boolean {
	return ctx.deliveryLifecycles.size > 0;
}

/** True when the last observed run or stage status is terminal. */
export function isStageChatContextTerminal(ctx: StageChatViewContext): boolean {
	return isTerminalStageChatState(ctx.lastObservedRunStatus) || isTerminalStageChatState(ctx.lastObservedStageStatus);
}

/**
 * Restore delivery-owned Working after a temporary overlay ended.
 *
 * A pre-turn `compaction_end` clears busy state and the Working lifecycle even
 * though the accepted delivery has not started its turn yet, so the pane would
 * sit idle until the public `agent_start`. Reassertion preserves factual status
 * text, so a compaction error still outranks ordinary Working.
 */
export function reconcileStageChatDeliveryLifecycle(ctx: StageChatViewContext): void {
	if (!hasActiveStageChatDelivery(ctx)) return;
	if (ctx.chatHost.isStreaming() && ctx.chatHost.hasAnimationTick()) return;
	const generation = ctx.chatHost.reassertExternalPromptLifecycle();
	for (const deliveryId of [...ctx.deliveryLifecycles.keys()]) {
		ctx.deliveryLifecycles.set(deliveryId, generation);
	}
}

/**
 * Drop every delivery lease admitted before a workflow terminal transition and
 * arm the stale-start fence.
 *
 * Those turns can no longer authorize activity on this chat, and keeping them
 * would let a queued late `agent_start` restart Working on a finished stage. A
 * settlement for a dropped id is then an ordinary unknown settlement.
 *
 * The fence is armed only by an observed transition. A chat that mounts onto an
 * already-terminal stage never cleaned up in-flight work, so a later
 * `agent_start` there is genuine retained-session work and stays visible.
 */
export function invalidateStageChatDeliveryLifecycles(ctx: StageChatViewContext): void {
	ctx.deliveryLifecycles.clear();
	ctx.terminalLifecycleFenced = true;
}
