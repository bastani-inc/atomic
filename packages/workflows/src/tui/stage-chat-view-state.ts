import { ChatSessionHost, type ChatSessionHostStyle } from "@bastani/atomic";
import { Editor, type EditorComponent } from "@earendil-works/pi-tui";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { resolveStageChatViewportRows } from "./stage-chat-layout.js";
import { createPromptCardState } from "./prompt-card.js";
import {
  hideMountedCustomUi,
  releaseMountedCustomUi,
  showCustomUi,
} from "./stage-chat-view-custom-ui.js";
import { editorRuleColor } from "./stage-chat-view-footer-status.js";
import {
  blankLine,
  cursorBlock,
  editorThemeFromGraphTheme,
  paint,
  setEditorBorderColor,
  setEditorPlaceholder,
} from "./stage-chat-view-render-helpers.js";
import {
  HEADER_ROWS,
  SEP_ROWS,
  VIEW_LINE_COUNT,
  isReadOnlyArchiveStatus,
  type NoticeEntry,
  type StageChatDetachMetadata,
  type StageChatViewContext,
  type StageChatViewOpts,
} from "./stage-chat-view-types.js";
import { noticeRow, noticeSummary } from "./stage-chat-view-transcript.js";
import { applyStageChatLiveHandleEvent } from "./stage-chat-view-live-events.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import {
  isTerminalOrNonStreamingStageChatStatus,
  isTerminalStageChatState,
  isTerminalStageChatTransition,
} from "./stage-chat-view-status.js";

export function initializeStageChatView(
  ctx: StageChatViewContext,
  opts: StageChatViewOpts,
): void {
  ctx.store = opts.store;
  ctx.theme = opts.graphTheme;
  ctx.runId = opts.runId;
  ctx.stageId = opts.stageId;
  ctx.workflowName = opts.workflowName;
  ctx.handle = opts.handle;
  ctx.onDetach = opts.onDetach;
  ctx.onClose = opts.onClose;
  ctx.requestRender = opts.requestRender;
  ctx.requestFocus = opts.requestFocus;
  ctx.focusHoldTimer = undefined;
  ctx.getViewportRows = opts.getViewportRows;
  ctx.piTui = opts.piTui;
  ctx.piTheme = opts.piTheme;
  ctx.piKeybindings = opts.piKeybindings;
  ctx.piEditorFactory = opts.piEditorFactory;
  ctx.stageUiBroker = opts.stageUiBroker ?? stageUiBroker;
  ctx.canSubmitPrompt = opts.canSubmitPrompt;
  ctx.mountedCustomUi = null;
  ctx.mountingRequestId = null;
  ctx.promptState = null;
  ctx.promptEditor = null;
  ctx.promptEditorPromptId = null;
  ctx.promptEditorSubmitFromEnter = false;
  ctx.promptScrollOffset = 0;
  ctx.promptMaxScroll = 0;
  ctx.localPaused = false;
  ctx.mouseScrollCaptureEnabled = true;
  ctx.lastObservedStageStatus = undefined;
  ctx.lastObservedRunStatus = undefined;
  ctx.seenNoticeIds = new Set<string>();
  ctx._unsubscribeStore = null;
  ctx._unsubscribeHandle = null;
  ctx._unregisterStageUiHost = null;
  installFocusHold(ctx);
  ctx.chatHost = createChatHost(ctx, opts);
  ctx._unregisterStageUiHost = ctx.stageUiBroker.registerHost(ctx.runId, ctx.stageId, {
    showCustomUi: (request) => {
      void showCustomUi(ctx, request);
    },
    hideCustomUi: (request) => {
      hideMountedCustomUi(ctx, request);
    },
  });

  snapshotMessagesFromHandle(ctx);
  const initialRun = currentRun(ctx);
  const initialStage = initialRun?.stages.find((s) => s.id === ctx.stageId);
  ctx.lastObservedRunStatus = initialRun?.status;
  ctx.lastObservedStageStatus = initialStage?.status;
  snapshotMessagesFromSessionFile(ctx, initialStage);
  absorbStageNotices(ctx, initialStage);
  syncPromptState(ctx, initialStage?.pendingPrompt);
  if (isTerminalStageChatState(initialRun?.status) || isTerminalStageChatState(initialStage?.status)) ctx.chatHost.clearBusyForTerminalWorkflowStage();
  ctx._unsubscribeStore = ctx.store.subscribe(() => handleStoreUpdate(ctx));

  if (ctx.handle) {
    ctx._unsubscribeHandle = ctx.handle.subscribe((event) => applyStageChatLiveHandleEvent(ctx, event));
  }
  ctx.chatHost.syncAnimationTick();
}

function installFocusHold(ctx: StageChatViewContext): void {
  if (!ctx.requestFocus) return;
  ctx.focusHoldTimer = setInterval(() => {
    // Hold focus on the overlay whenever there is something to interact with:
    // a mounted custom UI (ask_user_question / readiness gate) must stay
    // answerable even mid-turn, and an idle composer should keep focus. During
    // a pure streaming continuation (no custom UI mounted) we leave focus alone
    // so we never reclaim it out from under the agent's live output.
    if (ctx.mountedCustomUi !== null || !isStreaming(ctx)) ctx.requestFocus?.();
  }, 150);
}

function createChatHost(
  ctx: StageChatViewContext,
  opts: StageChatViewOpts,
): ChatSessionHost<NoticeEntry> {
  return new ChatSessionHost<NoticeEntry>({
    style: chatHostStyle(ctx),
    commands: {
      ensureAttached: async () => {
        await liveHandle(ctx)?.ensureAttached();
      },
      prompt: async (text) => {
        const handle = liveHandle(ctx);
        if (!handle) throw new Error("no live handle on this stage");
        await handle.prompt(text);
      },
      steer: async (text) => {
        const handle = liveHandle(ctx);
        if (!handle) throw new Error("no live handle on this stage");
        await handle.steer(text);
      },
      followUp: async (text) => {
        const handle = liveHandle(ctx);
        if (!handle) throw new Error("no live handle on this stage");
        await handle.followUp(text);
      },
      interrupt: async () => {
        const handle = liveHandle(ctx);
        if (!handle) return;
        const status = currentStage(ctx)?.status ?? handle.status;
        if (status === "pending" || status === "running" || status === "awaiting_input") {
          await handle.pause();
          return;
        }
        await handle.agentSession?.abort();
      },
      resume: async (message) => {
        const handle = liveHandle(ctx);
        if (!handle) throw new Error("no live handle on this stage");
        ctx.localPaused = true;
        await handle.resume(message);
        ctx.localPaused = false;
      },
      runBash: async (request) => {
        const handle = liveHandle(ctx);
        if (!handle) throw new Error("no live handle on this stage");
        await handle.ensureAttached();
        const agentSession = handle.agentSession;
        if (!agentSession) throw new Error("no live agent session on this stage");
        return agentSession.executeBash(request.command, request.onChunk, {
          excludeFromContext: request.excludeFromContext,
        });
      },
      abortBash: async () => {
        liveHandle(ctx)?.agentSession?.abortBash();
      },
      abortCompaction: async () => {
        liveHandle(ctx)?.agentSession?.abortCompaction();
      },
      handleSlashCommand: async (text) => handleSlashCommand(ctx, text),
    },
    isBashRunning: () => liveHandle(ctx)?.agentSession?.isBashRunning === true,
    requestRender: opts.requestRender,
    getAgentSession: () => liveHandle(ctx)?.agentSession,
    isStreaming: () => isLiveHandleStreaming(ctx),
    isPaused: () => isPaused(ctx),
    isDisabled: () => isBlocked(ctx) || !liveHandle(ctx),
    tui: opts.piTui,
    keybindings: opts.piKeybindings,
    editorFactory: opts.piEditorFactory,
    editorTheme: editorThemeFromGraphTheme(ctx.theme),
    getChatRenderSettings: opts.getChatRenderSettings,
    footerData: opts.footerData,
    renderExtraEntry: (entry) => noticeRow(entry, ctx.theme),
  });
}

function chatHostStyle(ctx: StageChatViewContext): ChatSessionHostStyle {
  return {
    dim: (text) => paint(text, ctx.theme.dim),
    text: (text) => paint(text, ctx.theme.text),
    textMuted: (text) => paint(text, ctx.theme.textMuted),
    accent: (text) => paint(text, ctx.theme.accent),
    accentBold: (text) => paint(text, ctx.theme.accent, { bold: true }),
    rule: (hex, text) => hexToAnsi(hex) + text + RESET,
    cursor: () => cursorBlock(),
    blank: (width) => blankLine(width),
    editorRuleColor: (disabled, agentSession, state) =>
      editorRuleColor(ctx, disabled, agentSession, state),
  };
}

function handleStoreUpdate(ctx: StageChatViewContext): void {
  const run = currentRun(ctx);
  const stage = run?.stages.find((s) => s.id === ctx.stageId);
  const currentRunStatus = run?.status;
  const currentStageStatus = stage?.status;
  let changed = false;
  if (stage && stage.status === "paused" && !ctx.localPaused) {
    ctx.localPaused = true;
    changed = true;
  } else if (stage && stage.status === "running" && ctx.localPaused) {
    ctx.localPaused = false;
    changed = true;
  }
  changed = absorbStageNotices(ctx, stage) || changed;
  const promptChanged = syncPromptState(ctx, stage?.pendingPrompt);
  changed = promptChanged || changed;
  if (promptChanged && ctx.promptState && canSubmitPrompt(ctx, ctx.promptState.prompt.id)) {
    ctx.requestFocus?.();
  }
  if (isTerminalStageChatTransition(ctx.lastObservedStageStatus, currentStageStatus) || isTerminalStageChatTransition(ctx.lastObservedRunStatus, currentRunStatus)) {
    ctx.chatHost.clearBusyForTerminalWorkflowStage();
    changed = true;
  }
  ctx.lastObservedRunStatus = currentRunStatus;
  ctx.lastObservedStageStatus = currentStageStatus;
  const hadAnimationTick = ctx.chatHost.hasAnimationTick();
  ctx.chatHost.syncAnimationTick();
  if (changed || hadAnimationTick !== ctx.chatHost.hasAnimationTick()) ctx.requestRender?.();
}

function snapshotMessagesFromHandle(ctx: StageChatViewContext): void {
  const handle = liveHandle(ctx);
  if (!handle) return;
  ctx.chatHost.appendMessages(handle.messages);
}

function snapshotMessagesFromSessionFile(
  ctx: StageChatViewContext,
  stage: StageSnapshot | undefined,
): void {
  ctx.chatHost.loadSessionFile(liveHandle(ctx)?.sessionFile ?? stage?.sessionFile);
}

function absorbStageNotices(
  ctx: StageChatViewContext,
  stage: StageSnapshot | undefined,
): boolean {
  const notices = stage?.notices;
  if (!notices) return false;
  let changed = false;
  for (const n of notices) {
    if (ctx.seenNoticeIds.has(n.id)) continue;
    ctx.seenNoticeIds.add(n.id);
    changed = true;
    ctx.chatHost.appendExtraEntry({
      role: "notice",
      noticeId: n.id,
      kind: n.kind,
      value: n.to,
      from: n.from,
      meta: n.meta,
      text: noticeSummary(n),
    });
  }
  return changed;
}

export function currentRun(ctx: StageChatViewContext): RunSnapshot | undefined {
  return ctx.store.snapshot().runs.find((r) => r.id === ctx.runId);
}

export function currentStage(ctx: StageChatViewContext): StageSnapshot | undefined {
  return currentRun(ctx)?.stages.find((s) => s.id === ctx.stageId);
}

export function syncPromptState(
  ctx: StageChatViewContext,
  prompt: PendingPrompt | undefined,
): boolean {
  if (!prompt) {
    const hadLivePrompt =
      ctx.promptState !== null ||
      ctx.promptEditor !== null ||
      ctx.promptEditorPromptId !== null;
    if (!hadLivePrompt) return false;
    ctx.promptState = null;
    disposePromptEditor(ctx);
    resetPromptScroll(ctx);
    return true;
  }
  if (!ctx.promptState || ctx.promptState.prompt.id !== prompt.id) {
    ctx.promptState = createPromptCardState(prompt);
    seedPromptTextState(ctx, prompt);
    resetPromptEditor(ctx, prompt);
    resetPromptScroll(ctx);
    return true;
  }
  return false;
}

function resetPromptScroll(ctx: StageChatViewContext): void {
  ctx.promptScrollOffset = 0;
  ctx.promptMaxScroll = 0;
}

function promptSeedText(ctx: StageChatViewContext, prompt: PendingPrompt): string {
  const draft = ctx.store.getStagePromptDraft(ctx.runId, ctx.stageId, prompt.id);
  if (draft !== undefined) return draft;
  return typeof prompt.initial === "string" ? prompt.initial : "";
}

function seedPromptTextState(ctx: StageChatViewContext, prompt: PendingPrompt): void {
  if (prompt.kind !== "input" && prompt.kind !== "editor") return;
  if (!ctx.promptState || ctx.promptState.prompt.id !== prompt.id) return;
  const seed = promptSeedText(ctx, prompt);
  ctx.promptState.rawText = seed;
  ctx.promptState.caret = seed.length;
}

function recordPromptDraft(
  ctx: StageChatViewContext,
  promptId: string,
  text: string,
): void {
  ctx.store.recordStagePromptDraft(ctx.runId, ctx.stageId, promptId, text);
}

export function recordCurrentPromptDraft(ctx: StageChatViewContext): void {
  const state = ctx.promptState;
  if (!state) return;
  const prompt = state.prompt;
  if (prompt.kind !== "input" && prompt.kind !== "editor") return;
  const text = ctx.promptEditor && ctx.promptEditorPromptId === prompt.id
    ? ctx.promptEditor.getText()
    : state.rawText;
  recordPromptDraft(ctx, prompt.id, text);
}

function resetPromptEditor(ctx: StageChatViewContext, prompt: PendingPrompt): void {
  disposePromptEditor(ctx);
  if ((prompt.kind !== "input" && prompt.kind !== "editor") || !ctx.piTui) return;
  const editor = ctx.piEditorFactory
    ? ctx.piEditorFactory(ctx.piTui, editorThemeFromGraphTheme(ctx.theme), ctx.piKeybindings)
    : new Editor(ctx.piTui, editorThemeFromGraphTheme(ctx.theme), { paddingX: 0 });
  editor.setText(ctx.promptState?.prompt.id === prompt.id ? ctx.promptState.rawText : promptSeedText(ctx, prompt));
  setEditorPlaceholder(editor, "Type your response…");
  setEditorBorderColor(editor, (text) => hexToAnsi(ctx.theme.accent) + text + RESET);
  editor.onChange = (text: string) => {
    if (ctx.promptState?.prompt.id !== prompt.id) return;
    ctx.promptState.rawText = text;
    ctx.promptState.caret = text.length;
    recordPromptDraft(ctx, prompt.id, text);
    ctx.requestRender?.();
  };
  editor.onSubmit = (text: string) => {
    resolvePromptResponse(ctx, prompt.id, text, {
      suppressNextGraphSubmit: ctx.promptEditorSubmitFromEnter,
    });
  };
  ctx.promptEditor = editor;
  ctx.promptEditorPromptId = prompt.id;
}

function disposePromptEditor(ctx: StageChatViewContext): void {
  const editor = ctx.promptEditor;
  ctx.promptEditor = null;
  ctx.promptEditorPromptId = null;
  const disposable = editor as (EditorComponent & { dispose?: () => void }) | null;
  disposable?.dispose?.();
}

export function resolvePromptResponse(
  ctx: StageChatViewContext,
  promptId: string,
  response: unknown,
  metadata: StageChatDetachMetadata = {},
): void {
  const prompt = ctx.promptState?.prompt;
  if (!prompt || prompt.id !== promptId) return;
  if (!canSubmitPrompt(ctx, promptId)) {
    ctx.requestRender?.();
    return;
  }
  ctx.promptState = null;
  disposePromptEditor(ctx);
  resetPromptScroll(ctx);
  const resolved = ctx.store.resolveStagePendingPrompt(ctx.runId, ctx.stageId, prompt.id, response);
  ctx.requestRender?.();
  if (resolved) ctx.onDetach("prompt-resolved", metadata);
}

export function viewLineCount(ctx: StageChatViewContext): number {
  const reported = ctx.getViewportRows?.();
  if (typeof reported !== "number" || !Number.isFinite(reported)) {
    return VIEW_LINE_COUNT;
  }
  return resolveStageChatViewportRows(reported, VIEW_LINE_COUNT);
}

export { isTerminalOrNonStreamingStageChatStatus } from "./stage-chat-view-status.js";

export function liveHandle(ctx: StageChatViewContext) {
  return ctx.handle?.isDisposed === true ? undefined : ctx.handle;
}

export function isLiveHandleStreaming(ctx: StageChatViewContext): boolean {
  const handle = liveHandle(ctx);
  if (!handle) return false;
  if (isTerminalOrNonStreamingStageChatStatus(currentRun(ctx)?.status)) return false;
  if (isTerminalOrNonStreamingStageChatStatus(currentStage(ctx)?.status)) return false;
  if (isTerminalOrNonStreamingStageChatStatus(handle.status)) return false;
  return handle.isStreaming === true;
}

export function isStreaming(ctx: StageChatViewContext): boolean {
  return ctx.chatHost.isStreaming();
}

export function isAbortableStreamingSession(ctx: StageChatViewContext): boolean {
  return isLiveHandleStreaming(ctx) || liveHandle(ctx)?.agentSession?.isStreaming === true;
}

export function isBlocked(ctx: StageChatViewContext): boolean {
  return currentStage(ctx)?.status === "blocked";
}

export function isPaused(
  ctx: StageChatViewContext,
  stage: StageSnapshot | undefined = currentStage(ctx),
): boolean {
  return ctx.localPaused || stage?.status === "paused" || liveHandle(ctx)?.status === "paused";
}

export function isReadOnlyArchive(
  ctx: StageChatViewContext,
  stage: StageSnapshot | undefined = currentStage(ctx),
): boolean {
  if (liveHandle(ctx)) return false;
  if (!stage) return true;
  return isReadOnlyArchiveStatus(stage.status) || Boolean(stage.sessionFile);
}

async function handleSlashCommand(ctx: StageChatViewContext, text: string): Promise<boolean> {
  const [command, ...rest] = text.trim().split(/\s+/);
  switch (command) {
    case "/compact": {
      if (rest.length > 0) return true;
      const handle = liveHandle(ctx);
      if (!handle) return false;
      await handle.ensureAttached();
      if (!handle.agentSession) return false;
      await handle.agentSession.compact();
      return true;
    }
    case "/quit":
      ctx.onClose();
      return true;
    default:
      return false;
  }
}

export function canSubmitPrompt(ctx: StageChatViewContext, promptId: string): boolean {
  return ctx.canSubmitPrompt?.(ctx.runId, ctx.stageId, promptId) ?? true;
}

export function invalidateStageChatView(ctx: StageChatViewContext): void {
  ctx.chatHost.invalidate();
  syncPromptState(ctx, currentStage(ctx)?.pendingPrompt);
}

export function disposeStageChatView(ctx: StageChatViewContext): void {
  if (ctx.focusHoldTimer !== undefined) {
    clearInterval(ctx.focusHoldTimer);
    ctx.focusHoldTimer = undefined;
  }
  ctx._unsubscribeStore?.();
  ctx._unsubscribeStore = null;
  ctx._unsubscribeHandle?.();
  ctx._unsubscribeHandle = null;
  releaseMountedCustomUi(ctx);
  disposePromptEditor(ctx);
  ctx._unregisterStageUiHost?.();
  ctx._unregisterStageUiHost = null;
  ctx.chatHost.dispose();
}

export function promptPageSize(ctx: StageChatViewContext): number {
  return Math.max(4, viewLineCount(ctx) - HEADER_ROWS - SEP_ROWS - 2);
}
