import {
  mountStageCustomUi,
  type StageCustomUiRequest,
} from "../shared/stage-ui-broker.js";
import { embedOrchestratorReturnHintInWidget } from "./stage-chat-view-footer-status.js";
import { setComponentFocused } from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

export async function showCustomUi(
  ctx: StageChatViewContext,
  request: StageCustomUiRequest,
): Promise<void> {
  ctx.mountedCustomUi?.component.dispose?.();
  ctx.mountedCustomUi = null;
  // Track the request currently being mounted. `mountStageCustomUi` is async,
  // so the broker can resolve/reject/abort the request (clearing it via
  // `hideMountedCustomUi`) before we finish awaiting. Without this guard the
  // post-await assignment below would strand a settled gate as a permanent
  // `mountedCustomUi`, hiding the transcript and crashing on the next
  // keystroke routed into the dead component (readiness gate #1099).
  ctx.mountingRequestId = request.id;
  if (!ctx.piTui || ctx.piTheme === undefined || ctx.piKeybindings === undefined) {
    ctx.mountingRequestId = null;
    ctx.stageUiBroker.reject(
      request,
      new Error("atomic-workflows: stage custom UI cannot mount without attached TUI host"),
    );
    return;
  }
  if (request.options?.overlay === true) {
    ctx.mountingRequestId = null;
    ctx.stageUiBroker.reject(
      request,
      new Error(
        "atomic-workflows: ctx.ui.custom overlay mode is unavailable in the workflow graph viewer",
      ),
    );
    return;
  }
  try {
    const mounted = await mountStageCustomUi(
      request,
      ctx.piTui,
      ctx.piTheme,
      ctx.piKeybindings,
      ctx.stageUiBroker,
      () => {
        if (ctx.mountedCustomUi?.request.id !== request.id) return;
        ctx.mountedCustomUi.component.dispose?.();
        ctx.mountedCustomUi = null;
        ctx.chatHost.focused = ctx.focused;
        ctx.chatHost.scrollToBottom();
        ctx.requestRender?.();
      },
      () => canSubmitPrompt(ctx, request.id),
    );
    // Settled or superseded while mounting: drop the freshly-built component
    // instead of showing a gate the broker has already torn down.
    if (ctx.mountingRequestId !== request.id) {
      mounted.component.dispose?.();
      return;
    }
    ctx.mountingRequestId = null;
    ctx.mountedCustomUi = mounted;
    // A freshly-shown custom UI (ask_user_question / readiness gate) must own
    // keyboard focus to be answerable — including a question mounted mid-turn
    // while the agent is "streaming" (it is blocked on this very question, and
    // host focus may have drifted off the overlay during the turn, e.g. after a
    // stay-loop composer submit). requestFocus is idempotent (a no-op when the
    // overlay already owns focus), so this never re-runs a redundant focus
    // transition that would stall the stream (#1120).
    ctx.requestFocus?.();
    ctx.requestRender?.();
  } catch (error) {
    if (ctx.mountingRequestId === request.id) ctx.mountingRequestId = null;
    ctx.stageUiBroker.reject(request, error);
  }
}

export function renderCustomUi(ctx: StageChatViewContext, width: number): string[] {
  const component = ctx.mountedCustomUi?.component;
  if (!component) return [];
  setComponentFocused(component, ctx.focused);
  return embedOrchestratorReturnHintInWidget(ctx, component.render(width), width);
}

export function hideMountedCustomUi(
  ctx: StageChatViewContext,
  request: StageCustomUiRequest,
): void {
  // Signal any in-flight `showCustomUi` mount for this request to drop its
  // component when it finishes — the broker is already tearing it down.
  if (ctx.mountingRequestId === request.id) ctx.mountingRequestId = null;
  const mounted = ctx.mountedCustomUi;
  if (!mounted || mounted.request.id !== request.id) return;
  ctx.mountedCustomUi = null;
  mounted.component.dispose?.();
  ctx.chatHost.focused = ctx.focused;
  ctx.chatHost.scrollToBottom();
  // Returning to the composer after a custom UI resolves (e.g. the readiness
  // gate -> "stay") must re-assert overlay focus so the composer accepts
  // input. Guarded for streaming so an answered mid-turn ask_user_question
  // does not refocus during the agent's continuation (would stall it).
  if (!ctx.chatHost.isStreaming()) ctx.requestFocus?.();
  ctx.requestRender?.();
}

/**
 * Stop displaying the mounted stage custom UI locally, WITHOUT settling its
 * broker request. Detaching / closing / disposing the attached chat stops
 * viewing the stage; it never cancels a pending human-input request. The
 * request stays pending (the stage remains awaiting_input) so re-attaching
 * re-displays it. The request is settled only by the user answering (broker
 * resolve) or the run aborting (its AbortSignal -> broker reject) — those are
 * the single chokepoints for ending a human-input request.
 */
export function releaseMountedCustomUi(ctx: StageChatViewContext): void {
  ctx.mountingRequestId = null;
  const mounted = ctx.mountedCustomUi;
  if (!mounted) return;
  ctx.mountedCustomUi = null;
  mounted.component.dispose?.();
}

function canSubmitPrompt(ctx: StageChatViewContext, promptId: string): boolean {
  return ctx.canSubmitPrompt?.(ctx.runId, ctx.stageId, promptId) ?? true;
}
