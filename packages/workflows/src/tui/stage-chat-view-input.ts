import {
  defaultResponseFor,
  handlePromptCardInput,
  isPromptEscapeInput,
} from "./prompt-card.js";
import { isKeybindingsLike } from "./keybindings-adapter.js";
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
  isBlocked,
  isReadOnlyArchive,
  isStreaming,
  promptPageSize,
  recordCurrentPromptDraft,
  resolvePromptResponse,
  syncPromptState,
} from "./stage-chat-view-state.js";

export function handleStageChatInput(
  ctx: StageChatViewContext,
  data: string,
): boolean {
  if (ctx.mountedCustomUi) {
    return handleMountedCustomUiInput(ctx, data);
  }
  const stage = currentStage(ctx);
  syncPromptState(ctx, stage?.pendingPrompt);
  const readOnlyArchive = isReadOnlyArchive(ctx, stage);
  const readOnlyPromptArchive = readOnlyArchive && stage?.promptFootprint !== undefined;
  if (matchesKey(data, Key.ctrl("d"))) {
    if (!ctx.promptState && ctx.chatHost.hasInputText()) return ctx.chatHost.handleInput(data);
    recordCurrentPromptDraft(ctx);
    ctx.onDetach();
    return true;
  }
  if (ctx.promptState) {
    if (handlePromptScrollInput(ctx, data, ctx.promptEditor === null)) return true;
    handlePromptInput(ctx, data);
    return true;
  }
  if (readOnlyPromptArchive && handlePromptScrollInput(ctx, data, true)) {
    return true;
  }
  if (ctx.chatHost.handleScrollInput(data)) return true;
  if (matchesKey(data, Key.escape)) {
    if (
      isStreaming(ctx) ||
      ctx.chatHost.isBashRunning() ||
      ctx.chatHost.isEditingBashCommand()
    ) {
      return ctx.chatHost.handleInput(data);
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
  if (matchesKey(data, Key.ctrl("d"))) {
    // Detach stops *viewing* the stage; it does not cancel a pending human-input
    // request. Release the local display only — the request stays pending and
    // is re-displayed when the user re-attaches.
    releaseMountedCustomUi(ctx);
    ctx.onDetach();
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
  const wheelDeltaRows = mouseWheelDeltaRows(data);
  if (wheelDeltaRows !== 0) {
    scrollPromptBy(ctx, wheelDeltaRows);
    return true;
  }
  if (isMouseSequence(data)) return true;
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

function mouseWheelDeltaRows(data: string): number {
  const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
  if (sgr) return wheelDeltaForButtonCode(Number.parseInt(sgr[1]!, 10));
  if (data.startsWith("\x1b[M") && data.length >= 6) {
    return wheelDeltaForButtonCode(data.charCodeAt(3) - 32);
  }
  return 0;
}

function wheelDeltaForButtonCode(code: number): number {
  if ((code & 64) === 0) return 0;
  const direction = code & 3;
  if (direction === 0) return -PROMPT_SCROLL_STEP_ROWS;
  if (direction === 1) return PROMPT_SCROLL_STEP_ROWS;
  return 0;
}

function isMouseSequence(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M");
}
