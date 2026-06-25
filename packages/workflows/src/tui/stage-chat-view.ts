/**
 * StageChatView — attached workflow-stage chat surface.
 *
 * This file is the compatibility facade for the historical
 * `src/tui/stage-chat-view.js` import path. The implementation is split by
 * responsibility into sibling `stage-chat-view-*` modules so each authored
 * source file stays under the repository file-length gate while preserving the
 * same public class, options, detach metadata, and test seams.
 *
 * Behaviour:
 *  - Idle stage (empty transcript, not streaming, not settled): Enter prompts.
 *  - Running live stages: Enter steers, Ctrl+F queues a follow-up, Escape uses
 *    the host chat interrupt path.
 *  - Paused stages: Enter resumes with composer text; Ctrl+D returns to graph.
 *  - Blocked and read-only archive stages absorb mutation keystrokes.
 *  - Workflow notices and prompt/custom UI panels keep workflow-specific chrome.
 *
 * cross-ref:
 *  - ui/stage-chat-mockup.html (canonical visual)
 *  - DESIGN.md §5 (Components — pill / box / banner vocabulary)
 *  - src/runs/foreground/stage-control-registry.ts (StageControlHandle)
 *  - src/shared/store-types.ts (StageSnapshot.notices, StageNotice)
 *  - https://pi.dev/docs/latest/tui (canonical Pi-tui component contract)
 */

import type { Component, Focusable } from "@earendil-works/pi-tui";
import { fitStageChatFrame, planStageChatFrame } from "./stage-chat-layout.js";
import {
  renderBlockedBody,
  renderPausedBody,
  renderPromptBody,
  renderReadOnlyArchiveBody,
} from "./stage-chat-view-archive-history.js";
import { renderCustomUi } from "./stage-chat-view-custom-ui.js";
import {
  renderFooterWithOrchestratorReturnHint,
  renderHeader,
  sepRule,
} from "./stage-chat-view-footer-status.js";
import { handleStageChatInput } from "./stage-chat-view-input.js";
import { blankLine, takeRows } from "./stage-chat-view-render-helpers.js";
import {
  currentStage,
  disposeStageChatView,
  initializeStageChatView,
  invalidateStageChatView,
  isBlocked,
  isPaused,
  isReadOnlyArchive,
  syncPromptState,
  viewLineCount,
} from "./stage-chat-view-state.js";
import { transcriptDebugEntries } from "./stage-chat-view-transcript.js";
import {
  HEADER_ROWS,
  SEP_ROWS,
  type StageChatViewContext,
  type StageChatViewOpts,
  type TranscriptDebugEntry,
} from "./stage-chat-view-types.js";

export type {
  StageChatDetachMetadata,
  StageChatDetachReason,
  StageChatViewOpts,
} from "./stage-chat-view-types.js";

export class StageChatView implements Component, Focusable {
  focused = true;
  private store!: StageChatViewContext["store"];
  private theme!: StageChatViewContext["theme"];
  private runId!: StageChatViewContext["runId"];
  private stageId!: StageChatViewContext["stageId"];
  private workflowName!: StageChatViewContext["workflowName"];
  private handle!: StageChatViewContext["handle"];
  private onDetach!: StageChatViewContext["onDetach"];
  private onClose!: StageChatViewContext["onClose"];
  private requestRender!: StageChatViewContext["requestRender"];
  private requestFocus!: StageChatViewContext["requestFocus"];
  private focusHoldTimer!: StageChatViewContext["focusHoldTimer"];
  private getViewportRows!: StageChatViewContext["getViewportRows"];
  private piTui!: StageChatViewContext["piTui"];
  private piTheme!: StageChatViewContext["piTheme"];
  private piKeybindings!: StageChatViewContext["piKeybindings"];
  private piEditorFactory!: StageChatViewContext["piEditorFactory"];
  private chatHost!: StageChatViewContext["chatHost"];
  private stageUiBroker!: StageChatViewContext["stageUiBroker"];
  private canSubmitPrompt!: StageChatViewContext["canSubmitPrompt"];
  private mountedCustomUi!: StageChatViewContext["mountedCustomUi"];
  private mountingRequestId!: StageChatViewContext["mountingRequestId"];
  private promptState!: StageChatViewContext["promptState"];
  private promptEditor!: StageChatViewContext["promptEditor"];
  private promptEditorPromptId!: StageChatViewContext["promptEditorPromptId"];
  private promptEditorSubmitFromEnter!: StageChatViewContext["promptEditorSubmitFromEnter"];
  private promptScrollOffset!: StageChatViewContext["promptScrollOffset"];
  private promptMaxScroll!: StageChatViewContext["promptMaxScroll"];
  private localPaused!: StageChatViewContext["localPaused"];
  private seenNoticeIds!: StageChatViewContext["seenNoticeIds"];
  private _unsubscribeStore!: StageChatViewContext["_unsubscribeStore"];
  private _unsubscribeHandle!: StageChatViewContext["_unsubscribeHandle"];
  private _unregisterStageUiHost!: StageChatViewContext["_unregisterStageUiHost"];

  constructor(opts: StageChatViewOpts) {
    initializeStageChatView(this._ctx(), opts);
  }

  render(width: number): string[] {
    const ctx = this._ctx();
    const w = Math.max(40, width);
    const stage = currentStage(ctx);
    const blocked = isBlocked(ctx);

    this.chatHost.focused = this.focused;
    const headerLines = renderHeader(ctx, w, stage);
    const sepLines = [sepRule(ctx, w)];
    const customUiActive = this.mountedCustomUi !== null;
    syncPromptState(ctx, stage?.pendingPrompt);
    const promptActive = !customUiActive && this.promptState !== null;
    const readOnlyArchive = isReadOnlyArchive(ctx, stage);

    const customUiLines = customUiActive ? renderCustomUi(ctx, w) : [];
    const chatChromeHidden = customUiActive || promptActive || readOnlyArchive;
    const pendingLines = chatChromeHidden ? [] : this.chatHost.renderPendingMessages(w);
    const workingLines = chatChromeHidden ? [] : this.chatHost.renderWorkingStatus(w);
    const usageLines = chatChromeHidden ? [] : this.chatHost.renderUsage(w);
    const editorLines = chatChromeHidden ? [] : this.chatHost.renderEditor(w);
    const footerLines = chatChromeHidden
      ? []
      : renderFooterWithOrchestratorReturnHint(ctx, w, this.chatHost.renderFooter(w));

    const totalRows = viewLineCount(ctx);
    const plan = planStageChatFrame({
      viewportRows: totalRows,
      headerRows: HEADER_ROWS,
      separatorRows: SEP_ROWS,
      pendingRows: pendingLines.length,
      workingRows: workingLines.length,
      usageRows: usageLines.length,
      editorRows: customUiActive ? customUiLines.length : editorLines.length,
      footerRows: footerLines.length,
    });
    const visiblePendingLines = takeRows(pendingLines, plan.pendingRows);
    const visibleWorkingLines = takeRows(workingLines, plan.workingRows);
    const visibleUsageLines = takeRows(usageLines, plan.usageRows);
    const editorSlotLines = customUiActive ? customUiLines : editorLines;
    const visibleEditorLines = takeRows(editorSlotLines, plan.editorRows);
    const visibleFooterLines = takeRows(footerLines, plan.footerRows);
    const bodyBudget = plan.bodyRows;
    if (blocked) this.chatHost.scrollToBottom();

    let bodyLines: string[];
    if (bodyBudget <= 0) {
      bodyLines = [];
    } else if (promptActive) {
      bodyLines = renderPromptBody(ctx, w, bodyBudget);
    } else if (blocked) {
      bodyLines = renderBlockedBody(ctx, w, bodyBudget, stage);
    } else if (!readOnlyArchive && isPaused(ctx, stage)) {
      bodyLines = renderPausedBody(ctx, w, bodyBudget);
    } else if (readOnlyArchive) {
      bodyLines = renderReadOnlyArchiveBody(ctx, w, bodyBudget, stage);
    } else {
      bodyLines = this.chatHost.renderBody(w, bodyBudget);
    }

    const lines = [
      ...headerLines,
      ...sepLines,
      ...bodyLines,
      ...visiblePendingLines,
      ...visibleWorkingLines,
      ...visibleUsageLines,
      ...visibleEditorLines,
      ...visibleFooterLines,
    ];
    return fitStageChatFrame(lines, totalRows, blankLine(w));
  }

  wantsMouseScrollTracking(): boolean {
    return true;
  }

  handleInput(data: string): boolean {
    return handleStageChatInput(this._ctx(), data);
  }

  invalidate(): void {
    invalidateStageChatView(this._ctx());
  }

  dispose(): void {
    disposeStageChatView(this._ctx());
  }

  private _ctx(): StageChatViewContext {
    // Helper modules operate on the same runtime object; these reads keep the
    // private fields visible to noUnusedLocals while preserving the historical
    // non-public TypeScript surface of StageChatView.
    void this.store;
    void this.theme;
    void this.runId;
    void this.stageId;
    void this.workflowName;
    void this.handle;
    void this.onDetach;
    void this.onClose;
    void this.requestRender;
    void this.requestFocus;
    void this.focusHoldTimer;
    void this.getViewportRows;
    void this.piTui;
    void this.piTheme;
    void this.piKeybindings;
    void this.piEditorFactory;
    void this.stageUiBroker;
    void this.canSubmitPrompt;
    void this.mountingRequestId;
    void this.promptEditor;
    void this.promptEditorPromptId;
    void this.promptEditorSubmitFromEnter;
    void this.promptScrollOffset;
    void this.promptMaxScroll;
    void this.seenNoticeIds;
    void this._unsubscribeStore;
    void this._unsubscribeHandle;
    void this._unregisterStageUiHost;
    return this as unknown as StageChatViewContext;
  }

  get _inputBuffer(): string {
    return this.chatHost.inputText();
  }

  get _transcript(): ReadonlyArray<TranscriptDebugEntry> {
    return this.chatHost.entries().flatMap((entry) => transcriptDebugEntries(entry));
  }

  get _statusMessage(): string {
    return this.chatHost.statusText();
  }

  get _isLocalPaused(): boolean {
    return this.localPaused;
  }

  get _hasAnimationTick(): boolean {
    return this.chatHost.hasAnimationTick();
  }

  get _bodyScrollFromBottom(): number {
    return this.chatHost.bodyScrollFromBottom();
  }

  get _lastBodyMaxScroll(): number {
    return this.chatHost.bodyMaxScroll();
  }
}
