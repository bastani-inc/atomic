import {
  defaultResponseFor,
  handlePromptCardInput,
  isPromptEscapeInput,
} from "./prompt-card.js";
import { APP_ACTION, isKeybindingsLike, matchesAction } from "./keybindings-adapter.js";
import {
  parseTerminalMouseInput,
  terminalMouseWheelDirection,
} from "./mouse-input.js";
import {
  setComponentFocused,
  setEditorFocused,
} from "./stage-chat-view-render-helpers.js";
import {
  PROMPT_SCROLL_STEP_ROWS,
  type StageChatViewContext,
} from "./stage-chat-view-types.js";
import { Key, matchesKey } from "./text-helpers.js";
import { releaseMountedCustomUi } from "./stage-chat-view-custom-ui.js";
import {
  canSubmitPrompt,
  currentStage,
  isAbortableStreamingSession,
  isBlocked,
  isReadOnlyArchive,
  promptPageSize,
  recordCurrentPromptDraft,
  resolvePromptResponse,
  syncPromptState,
} from "./stage-chat-view-state.js";

export function handleStageChatInput(
  ctx: StageChatViewContext,
  data: string,
): boolean {
  if (matchesKey(data, Key.ctrl("x"))) {
    if (ctx.mountedCustomUi) releaseMountedCustomUi(ctx);
    else {
      const stage = currentStage(ctx);
      syncPromptState(ctx, stage?.pendingPrompt);
      recordCurrentPromptDraft(ctx);
    }
    ctx.onDetach();
    return true;
  }
  if (matchesKey(data, Key.ctrl("t"))) {
    ctx.mouseScrollCaptureEnabled = !ctx.mouseScrollCaptureEnabled;
    ctx.requestRender?.();
    return true;
  }
  if (ctx.mountedCustomUi) {
    return handleMountedCustomUiInput(ctx, data);
  }
  const stage = currentStage(ctx);
  syncPromptState(ctx, stage?.pendingPrompt);
  const readOnlyArchive = isReadOnlyArchive(ctx, stage);
  const readOnlyPromptArchive = readOnlyArchive && stage?.promptFootprint !== undefined;

  if (ctx.promptState) {
    if (handlePromptScrollInput(ctx, data, ctx.promptEditor === null)) return true;
    handlePromptInput(ctx, data);
    return true;
  }
  if (handleToolsExpandInput(ctx, data)) return true;
  if (readOnlyPromptArchive && handlePromptScrollInput(ctx, data, true)) {
    return true;
  }
  if (ctx.chatHost.handleScrollInput(data)) return true;
  if (matchesKey(data, Key.escape)) {
    if (
      ctx.chatHost.isCompacting() ||
      ctx.chatHost.isBashRunning() ||
      ctx.chatHost.isEditingBashCommand()
    ) {
      return ctx.chatHost.handleInput(data);
    }
    if (isAbortableStreamingSession(ctx)) {
      void ctx.chatHost.interrupt();
      return true;
    }
    ctx.onClose();
    return true;
  }
  if (matchesKey(data, Key.ctrl("c"))) {
    ctx.onClose();
    return true;
  }
  if (readOnlyArchive) return true;
  const blocked = isBlocked(ctx);
  if (matchesKey(data, Key.ctrl("f"))) {
    if (blocked) return true;
    void ctx.chatHost.submit("followUp");
    return true;
  }
  if (blocked) return true;
  return ctx.chatHost.handleInput(data);
}

function handleToolsExpandInput(ctx: StageChatViewContext, data: string): boolean {
  const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
  if (!matchesAction(keybindings, data, APP_ACTION.toolsExpand)) return false;
  const expanded = ctx.getToolsExpanded?.() === true;
  ctx.setToolsExpanded?.(!expanded);
  ctx.chatHost.invalidate();
  ctx.requestRender?.();
  return true;
}

function handleMountedCustomUiInput(
  ctx: StageChatViewContext,
  data: string,
): boolean {
  const mounted = ctx.mountedCustomUi;
  if (!mounted) return false;
  if (!canSubmitPrompt(ctx, mounted.request.id)) {
    ctx.requestRender?.();
    return true;
  }

  if (matchesKey(data, Key.ctrl("c"))) {
    // Close hides the overlay; the background run — and its pending human-input
    // request — keep living. Release the local display only.
    releaseMountedCustomUi(ctx);
    ctx.onClose();
    return true;
  }
  // Let scroll input reach the transcript so history stays scrollable while the
  // question is shown, matching the standalone ask_user_question tool.
  if (ctx.chatHost.handleScrollInput(data)) {
    ctx.requestRender?.();
    return true;
  }

  const component = mounted.component;
  setComponentFocused(component, ctx.focused);
  component.handleInput?.(data);
  ctx.requestRender?.();
  return true;
}

function handlePromptInput(ctx: StageChatViewContext, data: string): void {
  const state = ctx.promptState;
  if (!state) return;
  if (ctx.promptEditor && ctx.promptEditorPromptId === state.prompt.id) {
    if (matchesKey(data, Key.ctrl("c"))) {
      resolvePromptResponse(ctx, state.prompt.id, defaultResponseFor(state.prompt), {
        suppressNextGraphSubmit: false,
      });
      return;
    }
    if (isPromptEscapeInput(data)) {
      ctx.requestRender?.();
      return;
    }
    setEditorFocused(ctx.promptEditor, ctx.focused);
    ctx.promptEditorSubmitFromEnter = matchesKey(data, Key.enter);
    try {
      ctx.promptEditor.handleInput(data);
    } finally {
      ctx.promptEditorSubmitFromEnter = false;
    }
    ctx.requestRender?.();
    return;
  }
  const keybindings = isKeybindingsLike(ctx.piKeybindings) ? ctx.piKeybindings : undefined;
  const action = handlePromptCardInput(data, state, keybindings);
  const prompt = state.prompt;
  if (prompt.kind === "input" || prompt.kind === "editor") {
    ctx.store.recordStagePromptDraft(ctx.runId, ctx.stageId, prompt.id, state.rawText);
  }
  if (action.kind === "noop") {
    ctx.requestRender?.();
    return;
  }
  const response = action.kind === "submit"
    ? action.response
    : defaultResponseFor(prompt);
  resolvePromptResponse(ctx, prompt.id, response, {
    suppressNextGraphSubmit: action.kind === "submit" && matchesKey(data, Key.enter),
  });
}

function handlePromptScrollInput(
  ctx: StageChatViewContext,
  data: string,
  includeKeyboard = true,
): boolean {
  const mouse = parseTerminalMouseInput(data);
  const wheelDirection = mouse ? terminalMouseWheelDirection(mouse) : null;
  const wheelDeltaRows = wheelDirection === "up"
    ? -PROMPT_SCROLL_STEP_ROWS
    : wheelDirection === "down"
      ? PROMPT_SCROLL_STEP_ROWS
      : 0;
  if (wheelDeltaRows !== 0) {
    scrollPromptBy(ctx, wheelDeltaRows);
    return true;
  }
  if (mouse) return true;
  if (!includeKeyboard) return false;
  if (matchesKey(data, "pageUp")) {
    scrollPromptBy(ctx, -promptPageSize(ctx));
    return true;
  }
  if (matchesKey(data, "pageDown")) {
    scrollPromptBy(ctx, promptPageSize(ctx));
    return true;
  }
  if (!ctx.promptEditor && matchesKey(data, "home")) {
    ctx.promptScrollOffset = 0;
    ctx.requestRender?.();
    return true;
  }
  if (!ctx.promptEditor && matchesKey(data, "end")) {
    ctx.promptScrollOffset = ctx.promptMaxScroll;
    ctx.requestRender?.();
    return true;
  }
  return false;
}

function scrollPromptBy(ctx: StageChatViewContext, deltaRows: number): void {
  ctx.promptScrollOffset = Math.max(
    0,
    Math.min(ctx.promptMaxScroll, ctx.promptScrollOffset + deltaRows),
  );
  ctx.requestRender?.();
}
