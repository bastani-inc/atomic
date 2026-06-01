/**
 * StageChatView — attached workflow-stage chat surface.
 *
 * The overlay keeps workflow-specific chrome for stage metadata / controls, but
 * the chat body now delegates to packages/coding-agent's exported interactive
 * components instead of maintaining parallel workflow message widgets:
 *  - user rows use `UserMessageComponent`
 *  - assistant/thinking rows use `AssistantMessageComponent`
 *  - tool rows use `ToolExecutionComponent` and built-in tool renderers
 *  - input reuses the host's custom editor factory when one is installed,
 *    otherwise `CustomEditor`; tests/headless fall back to the historical
 *    one-line editor
 *  - workflow notices render as compact workflow-specific cards because they
 *    are not coding-agent chat messages
 *
 * Behaviour:
 *  - **Idle** stage (empty transcript, not streaming, not settled): welcome
 *    panel describing the attached stage. Enter sends `handle.prompt(text)`.
 *  - **Running** stage with a live stream: Enter queues a Pi-style steering
 *    message (interrupt mid-turn) without adding a premature transcript row.
 *    Ctrl+F queues a follow-up the same way.
 *  - **Escape** mirrors the main coding-agent chat interrupt path for active
 *    live stages: it requests a controlled pause/abort while keeping the
 *    composer active. While paused, Enter calls `handle.resume(text)`.
 *  - **Ctrl+D** detaches (back to graph), or closes the popup while paused;
 *    **Escape** closes the popup when idle.
 *  - **Blocked** stage: keystrokes absorbed; BLOCKED banner names the
 *    upstream awaiter.
 *  - **Settled** stage with a live handle remains a normal chat session:
 *    Enter sends `handle.prompt(text)` and Escape interrupts any active
 *    post-stage response without mutating workflow dependencies.
 *
 * cross-ref:
 *  - ui/stage-chat-mockup.html (canonical visual)
 *  - DESIGN.md §5 (Components — pill / box / banner vocabulary)
 *  - src/runs/foreground/stage-control-registry.ts (StageControlHandle)
 *  - src/shared/store-types.ts (StageSnapshot.notices, StageNotice)
 *  - https://pi.dev/docs/latest/tui (canonical Pi-tui component contract)
 *  - node_modules/@earendil-works/pi-tui/src/components/{box,text,spacer}.ts
 */

import {
  ChatSessionHost,
  type ChatSessionHostStyle,
  type AgentSession,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
  type ReadonlyFooterDataProvider,
} from "@bastani/atomic";
import { Box, Editor, Text } from "@earendil-works/pi-tui";
import type {
  Component,
  EditorComponent,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import {
  mountStageCustomUi,
  stageUiBroker,
  type MountedStageCustomUi,
  type StageCustomUiRequest,
  type StageUiBroker,
} from "../shared/stage-ui-broker.js";
import type { PendingPrompt, StageNotice, StageSnapshot, StageStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { isKeybindingsLike, type KeybindingsLike } from "./keybindings-adapter.js";
import { BOLD, RESET, hexBg, hexToAnsi, lerpColor } from "./color-utils.js";
import { renderWorkflowNoticeCard, type WorkflowNoticeTone } from "./workflow-notice-card.js";
import { Key, matchesKey, visibleWidth } from "./text-helpers.js";
import {
  fitStageChatFrame,
  planStageChatFrame,
  resolveStageChatViewportRows,
} from "./stage-chat-layout.js";
import {
  createPromptCardState,
  defaultResponseFor,
  handlePromptCardInput,
  isPromptEscapeInput,
  renderPromptCard,
  type PromptCardState,
} from "./prompt-card.js";
import { renderRoundedBoxLines } from "./chat-surface.js";

// ---------------------------------------------------------------------------
// Options & types
// ---------------------------------------------------------------------------

function isReadOnlyArchiveStatus(status: StageStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export interface StageChatViewOpts {
  store: Store;
  graphTheme: GraphTheme;
  runId: string;
  stageId: string;
  /** The workflow display name, used in the title chrome `<workflow> / <stage>`. */
  workflowName: string;
  /**
   * Live stage-control handle when available. When absent the chat is
   * inspect-only (settled stage with no live handle).
   */
  handle?: StageControlHandle;
  /** Called when the user presses Ctrl+D outside a paused stage (back to graph). */
  onDetach: (reason?: StageChatDetachReason, metadata?: StageChatDetachMetadata) => void;
  /** Called when the user presses Escape (close the whole popup). */
  onClose: () => void;
  /** Request a host TUI repaint after SDK events mutate local chat state. */
  requestRender?: () => void;
  /**
   * Re-assert overlay keyboard focus. Showing a stage custom UI (e.g. the
   * readiness gate) must make the overlay the focused pi-tui component again,
   * otherwise key events keep going elsewhere and the UI looks frozen (#1120).
   */
  requestFocus?: () => void;
  /** Live pi-tui host objects. When present, stage input uses pi's editor UI. */
  piTui?: TUI;
  piTheme?: unknown;
  piKeybindings?: unknown;
  /** Currently installed host editor factory, inherited from extension `ctx.ui.setEditorComponent()`. */
  piEditorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: unknown,
  ) => EditorComponent;
  /** Parent chat rendering settings and extension renderers inherited from the host UI. */
  getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  /** Parent footer data provider inherited from the host UI for core footer/usage rendering. */
  footerData?: ReadonlyFooterDataProvider;
  /**
   * Optional accessor returning the current terminal row count. The chat
   * surface expands its body band to roughly `viewportRows` minus the fixed
   * header / loader / editor / footer rows so the popup fills the
   * terminal under pi-tui's `width: "100%" / maxHeight: "100%"` geometry.
   * Returning `undefined` falls back to the constant 32-row frame.
   */
  getViewportRows?: () => number | undefined;
  /** Broker that routes stage-local custom UI, such as ask_user_question, into this node. */
  stageUiBroker?: StageUiBroker;
  /**
   * Ownership guard for prompt submission. The attach shell uses this to ensure
   * stale/hidden/non-active stage-chat instances cannot settle a prompt unless
   * the user is currently attached to this exact workflow node.
   */
  canSubmitPrompt?: (runId: string, stageId: string, promptId: string) => boolean;
}

/**
 * Transcript model. Every variant carries a flat `.text` summary so consumers
 * that read `_transcript` (tests, future serialisers) can recover the
 * canonical user-visible string without knowing about the Pi-box payload.
 */
export type StageChatDetachReason = "user" | "prompt-resolved";

export interface StageChatDetachMetadata {
  readonly suppressNextGraphSubmit?: boolean;
}

interface NoticeEntry {
  readonly role: "notice";
  readonly text: string;
  readonly noticeId: string;
  readonly kind: StageNotice["kind"];
  readonly value: string;
  readonly from?: string;
  readonly meta?: string;
}
type TranscriptEntry = NoticeEntry | ChatMessageEntry;
type AgentSnapshotMessage = AgentSession["messages"][number];

// ---------------------------------------------------------------------------
// Frame budget
// ---------------------------------------------------------------------------

/**
 * Default line budget used when the host doesn't surface terminal dimensions
 * (direct unit renders, lightweight test mocks). The mounted overlay
 * overrides this by passing `getViewportRows()`.
 */
const VIEW_LINE_COUNT = 32;
const PROMPT_SCROLL_STEP_ROWS = 4;

/** Header strip — `  STAGE  wf / stage   <meta>   ● status` without a leading marker glyph. */
const HEADER_ROWS = 1;
/** Single dim rule between header and body. */
const SEP_ROWS = 1;
const ITALIC = "\x1b[3m";
const FG_RESET = "\x1b[39m";
const WEIGHT_RESET = "\x1b[22m";
const ITALIC_RESET = "\x1b[23m";

// ---------------------------------------------------------------------------
// StageChatView
// ---------------------------------------------------------------------------

export class StageChatView implements Component, Focusable {
  focused = true;
  private store: Store;
  private theme: GraphTheme;
  private runId: string;
  private stageId: string;
  private workflowName: string;
  private handle: StageControlHandle | undefined;
  private onDetach: (reason?: StageChatDetachReason, metadata?: StageChatDetachMetadata) => void;
  private onClose: () => void;
  private requestRender: (() => void) | undefined;
  private requestFocus: (() => void) | undefined;
  private focusHoldTimer: ReturnType<typeof setInterval> | undefined;
  private getViewportRows?: () => number | undefined;
  private piTui?: TUI;
  private piTheme?: unknown;
  private piKeybindings?: unknown;
  private piEditorFactory?: StageChatViewOpts["piEditorFactory"];
  private chatHost: ChatSessionHost<NoticeEntry>;
  private stageUiBroker: StageUiBroker;
  private canSubmitPrompt?: (runId: string, stageId: string, promptId: string) => boolean;
  private mountedCustomUi: MountedStageCustomUi | null = null;
  private mountingRequestId: string | null = null;
  private promptState: PromptCardState | null = null;
  private promptEditor: EditorComponent | null = null;
  private promptEditorPromptId: string | null = null;
  private promptEditorSubmitFromEnter = false;
  private promptScrollOffset = 0;
  private promptMaxScroll = 0;
  private getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  private footerData?: ReadonlyFooterDataProvider;

  /** True while a pending pause request is in flight (between ctrl+p and resolve). */
  private localPaused = false;
  /** De-dup set so the store subscription doesn't re-append known notices. */
  private seenNoticeIds = new Set<string>();

  private _unsubscribeStore: (() => void) | null = null;
  private _unsubscribeHandle: (() => void) | null = null;
  private _unregisterStageUiHost: (() => void) | null = null;

  constructor(opts: StageChatViewOpts) {
    this.store = opts.store;
    this.theme = opts.graphTheme;
    this.runId = opts.runId;
    this.stageId = opts.stageId;
    this.workflowName = opts.workflowName;
    this.handle = opts.handle;
    this.onDetach = opts.onDetach;
    this.onClose = opts.onClose;
    this.requestRender = opts.requestRender;
    this.requestFocus = opts.requestFocus;
    // Hold overlay keyboard focus against host focus-steals. pi-tui overlays
    // capture focus on show, but any tui.setFocus() elsewhere (the host editor
    // during background workflow activity) steals it, leaving the gate/composer
    // input-dead. Re-claim it on a short interval — only while NOT streaming, so
    // a mid-turn ask_user_question never refocuses during the agent's
    // continuation (which would stall the stream).
    if (opts.requestFocus) {
      this.focusHoldTimer = setInterval(() => {
        // Hold focus on the overlay whenever there is something to interact
        // with: a mounted custom UI (ask_user_question / readiness gate) must
        // stay answerable even mid-turn, and an idle composer should keep focus.
        // During a pure streaming continuation (no custom UI mounted) we leave
        // focus alone so we never reclaim it out from under the agent's live
        // output. requestFocus is idempotent, so this is a no-op whenever the
        // overlay already owns focus.
        if (this.mountedCustomUi !== null || !this._isStreaming()) this.requestFocus?.();
      }, 150);
    }
    this.getViewportRows = opts.getViewportRows;
    this.piTui = opts.piTui;
    this.piTheme = opts.piTheme;
    this.piKeybindings = opts.piKeybindings;
    this.piEditorFactory = opts.piEditorFactory;
    this.getChatRenderSettings = opts.getChatRenderSettings;
    this.footerData = opts.footerData;
    this.stageUiBroker = opts.stageUiBroker ?? stageUiBroker;
    this.canSubmitPrompt = opts.canSubmitPrompt;
    this.chatHost = new ChatSessionHost<NoticeEntry>({
      style: this._chatHostStyle(),
      commands: {
        ensureAttached: async () => {
          await this._liveHandle()?.ensureAttached();
        },
        prompt: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.prompt(text);
        },
        steer: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.steer(text);
        },
        followUp: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.followUp(text);
        },
        interrupt: async () => {
          const handle = this._liveHandle();
          if (!handle) return;
          const status = this._currentStage()?.status ?? handle.status;
          if (status === "pending" || status === "running" || status === "awaiting_input") {
            await handle.pause();
            return;
          }
          await handle.agentSession?.abort();
        },
        resume: async (message) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          this.localPaused = true;
          await handle.resume(message);
          this.localPaused = false;
        },
        runBash: async (request) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.ensureAttached();
          const agentSession = handle.agentSession;
          if (!agentSession) throw new Error("no live agent session on this stage");
          return agentSession.executeBash(request.command, request.onChunk, {
            excludeFromContext: request.excludeFromContext,
          });
        },
        abortBash: async () => {
          this._liveHandle()?.agentSession?.abortBash();
        },
        abortCompaction: async () => {
          this._liveHandle()?.agentSession?.abortCompaction();
        },
        handleSlashCommand: async (text) => this._handleSlashCommand(text),
      },
      isBashRunning: () => this._liveHandle()?.agentSession?.isBashRunning === true,
      requestRender: opts.requestRender,
      getAgentSession: () => this._liveHandle()?.agentSession,
      isStreaming: () => this._liveHandle()?.isStreaming === true,
      isPaused: () => this._isPaused(),
      isDisabled: () => this._isBlocked() || !this._liveHandle(),
      tui: opts.piTui,
      keybindings: opts.piKeybindings,
      editorFactory: opts.piEditorFactory,
      editorTheme: editorThemeFromGraphTheme(this.theme),
      getChatRenderSettings: opts.getChatRenderSettings,
      footerData: opts.footerData,
      renderExtraEntry: (entry) => this._noticeRow(entry),
    });
    this._unregisterStageUiHost = this.stageUiBroker.registerHost(this.runId, this.stageId, {
      showCustomUi: (request) => {
        void this._showCustomUi(request);
      },
      hideCustomUi: (request) => {
        this._hideMountedCustomUi(request);
      },
    });

    // Seed transcript from the live SDK session at attach time, plus any
    // stage notices the workflow body has already recorded.
    this._snapshotMessagesFromHandle();
    const initialStage = this._currentStage();
    this._snapshotMessagesFromSessionFile(initialStage);
    this._absorbStageNotices(initialStage);
    this._syncPromptState(initialStage?.pendingPrompt);

    this._unsubscribeStore = this.store.subscribe(() => {
      const stage = this._currentStage();
      let changed = false;
      if (stage && stage.status === "paused" && !this.localPaused) {
        this.localPaused = true;
        changed = true;
      } else if (stage && stage.status === "running" && this.localPaused) {
        this.localPaused = false;
        changed = true;
      }
      // Pick up notices recorded after attach (workflow body calling
      // `stage.setModel`, `stage.compact`, …) so they thread through the
      // transcript without a special render path.
      changed = this._absorbStageNotices(stage) || changed;
      const promptChanged = this._syncPromptState(stage?.pendingPrompt);
      changed = promptChanged || changed;
      if (promptChanged && this.promptState && this._canSubmitPrompt(this.promptState.prompt.id)) {
        this.requestFocus?.();
      }
      this.chatHost.syncAnimationTick();
      if (changed) this.requestRender?.();
    });

    if (this.handle) {
      this._unsubscribeHandle = this.handle.subscribe((event) => {
        this.chatHost.applyAgentEvent(event);
      });
    }
    this.chatHost.syncAnimationTick();
  }

  private _chatHostStyle(): ChatSessionHostStyle {
    return {
      dim: (text) => paint(text, this.theme.dim),
      text: (text) => paint(text, this.theme.text),
      textMuted: (text) => paint(text, this.theme.textMuted),
      accent: (text) => paint(text, this.theme.accent),
      accentBold: (text) => paint(text, this.theme.accent, { bold: true }),
      rule: (hex, text) => hexToAnsi(hex) + text + RESET,
      cursor: () => cursorBlock(),
      blank: (width) => this._blank(width),
      editorRuleColor: (disabled, agentSession, state) =>
        this._editorRuleColor(disabled, agentSession, state),
    };
  }

  private async _showCustomUi(request: StageCustomUiRequest): Promise<void> {
    this.mountedCustomUi?.component.dispose?.();
    this.mountedCustomUi = null;
    // Track the request currently being mounted. `mountStageCustomUi` is async,
    // so the broker can resolve/reject/abort the request (clearing it via
    // `_hideMountedCustomUi`) before we finish awaiting. Without this guard the
    // post-await assignment below would strand a settled gate as a permanent
    // `mountedCustomUi`, hiding the transcript and crashing on the next
    // keystroke routed into the dead component (readiness gate #1099).
    this.mountingRequestId = request.id;
    if (!this.piTui || this.piTheme === undefined || this.piKeybindings === undefined) {
      this.mountingRequestId = null;
      this.stageUiBroker.reject(
        request,
        new Error("pi-workflows: stage custom UI cannot mount without attached TUI host"),
      );
      return;
    }
    try {
      const mounted = await mountStageCustomUi(
        request,
        this.piTui,
        this.piTheme,
        this.piKeybindings,
        this.stageUiBroker,
        () => {
          if (this.mountedCustomUi?.request.id !== request.id) return;
          this.mountedCustomUi.component.dispose?.();
          this.mountedCustomUi = null;
          this.chatHost.focused = this.focused;
          this.chatHost.scrollToBottom();
          this.requestRender?.();
        },
        () => this._canSubmitPrompt(request.id),
      );
      // Settled or superseded while mounting: drop the freshly-built component
      // instead of showing a gate the broker has already torn down.
      if (this.mountingRequestId !== request.id) {
        mounted.component.dispose?.();
        return;
      }
      this.mountingRequestId = null;
      this.mountedCustomUi = mounted;
      // A freshly-shown custom UI (ask_user_question / readiness gate) must own
      // keyboard focus to be answerable — including a question mounted mid-turn
      // while the agent is "streaming" (it is blocked on this very question, and
      // host focus may have drifted off the overlay during the turn, e.g. after a
      // stay-loop composer submit). requestFocus is idempotent (a no-op when the
      // overlay already owns focus), so this never re-runs a redundant focus
      // transition that would stall the stream (#1120).
      this.requestFocus?.();
      this.requestRender?.();
    } catch (error) {
      if (this.mountingRequestId === request.id) this.mountingRequestId = null;
      this.stageUiBroker.reject(request, error);
    }
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  private _snapshotMessagesFromHandle(): void {
    const handle = this._liveHandle();
    if (!handle) return;
    this.chatHost.appendMessages(handle.messages);
  }

  private _snapshotMessagesFromSessionFile(
    stage: StageSnapshot | undefined,
  ): void {
    this.chatHost.loadSessionFile(this._liveHandle()?.sessionFile ?? stage?.sessionFile);
  }

  private _absorbStageNotices(stage: StageSnapshot | undefined): boolean {
    const notices = stage?.notices;
    if (!notices) return false;
    let changed = false;
    for (const n of notices) {
      if (this.seenNoticeIds.has(n.id)) continue;
      this.seenNoticeIds.add(n.id);
      changed = true;
      this.chatHost.appendExtraEntry({
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

  private _currentStage(): StageSnapshot | undefined {
    const snap = this.store.snapshot();
    const run = snap.runs.find((r) => r.id === this.runId);
    return run?.stages.find((s) => s.id === this.stageId);
  }

  private _syncPromptState(prompt: PendingPrompt | undefined): boolean {
    if (!prompt) {
      const hadLivePrompt =
        this.promptState !== null ||
        this.promptEditor !== null ||
        this.promptEditorPromptId !== null;
      if (!hadLivePrompt) return false;
      this.promptState = null;
      this._disposePromptEditor();
      this._resetPromptScroll();
      return true;
    }
    if (!this.promptState || this.promptState.prompt.id !== prompt.id) {
      this.promptState = createPromptCardState(prompt);
      this._resetPromptEditor(prompt);
      this._resetPromptScroll();
      return true;
    }
    return false;
  }

  private _resetPromptScroll(): void {
    this.promptScrollOffset = 0;
    this.promptMaxScroll = 0;
  }

  private _resetPromptEditor(prompt: PendingPrompt): void {
    this._disposePromptEditor();
    if ((prompt.kind !== "input" && prompt.kind !== "editor") || !this.piTui) return;
    const editor = this.piEditorFactory
      ? this.piEditorFactory(this.piTui, editorThemeFromGraphTheme(this.theme), this.piKeybindings)
      : new Editor(this.piTui, editorThemeFromGraphTheme(this.theme), { paddingX: 0 });
    editor.setText(typeof prompt.initial === "string" ? prompt.initial : "");
    setEditorPlaceholder(editor, "Type your response…");
    setEditorBorderColor(editor, (text) => hexToAnsi(this.theme.accent) + text + RESET);
    editor.onChange = (text: string) => {
      if (this.promptState?.prompt.id !== prompt.id) return;
      this.promptState.rawText = text;
      this.promptState.caret = text.length;
      this.requestRender?.();
    };
    editor.onSubmit = (text: string) => {
      this._resolvePromptResponse(prompt.id, text, {
        suppressNextGraphSubmit: this.promptEditorSubmitFromEnter,
      });
    };
    this.promptEditor = editor;
    this.promptEditorPromptId = prompt.id;
  }

  private _disposePromptEditor(): void {
    const editor = this.promptEditor;
    this.promptEditor = null;
    this.promptEditorPromptId = null;
    const disposable = editor as (EditorComponent & { dispose?: () => void }) | null;
    disposable?.dispose?.();
  }

  private _resolvePromptResponse(
    promptId: string,
    response: unknown,
    metadata: StageChatDetachMetadata = {},
  ): void {
    const prompt = this.promptState?.prompt;
    if (!prompt || prompt.id !== promptId) return;
    if (!this._canSubmitPrompt(promptId)) {
      this.requestRender?.();
      return;
    }
    this.promptState = null;
    this._disposePromptEditor();
    this._resetPromptScroll();
    // A false return means the prompt was already resolved/removed (for
    // example by run abort). The local UI is already stale, so clearing it is
    // the least surprising recovery path, but it must not trigger graph-mode
    // transition side effects for a prompt this view did not actually settle.
    const resolved = this.store.resolveStagePendingPrompt(this.runId, this.stageId, prompt.id, response);
    this.requestRender?.();
    if (resolved) this.onDetach("prompt-resolved", metadata);
  }

  // -------------------------------------------------------------------------
  // Frame sizing
  // -------------------------------------------------------------------------

  /**
   * Number of rows the chat surface paints per frame. The mounted overlay
   * passes `terminal.rows` through `getViewportRows`; direct unit renders
   * fall back to the constant `VIEW_LINE_COUNT` so the legacy 32-row frame
   * still applies to lightweight test mocks.
   */
  private _viewLineCount(): number {
    const reported = this.getViewportRows?.();
    if (typeof reported !== "number" || !Number.isFinite(reported)) {
      return VIEW_LINE_COUNT;
    }
    return resolveStageChatViewportRows(reported, VIEW_LINE_COUNT);
  }

  private _liveHandle(): StageControlHandle | undefined {
    return this.handle?.isDisposed === true ? undefined : this.handle;
  }

  private _isStreaming(): boolean {
    return this.chatHost.isStreaming();
  }

  private _isBlocked(): boolean {
    return this._currentStage()?.status === "blocked";
  }

  private _isPaused(
    stage: StageSnapshot | undefined = this._currentStage(),
  ): boolean {
    return this.localPaused || stage?.status === "paused" || this._liveHandle()?.status === "paused";
  }

  private _isReadOnlyArchive(stage: StageSnapshot | undefined = this._currentStage()): boolean {
    if (this._liveHandle()) return false;
    if (!stage) return true;
    return isReadOnlyArchiveStatus(stage.status) || Boolean(stage.sessionFile);
  }

  private async _handleSlashCommand(text: string): Promise<boolean> {
    const [command, ...rest] = text.trim().split(/\s+/);
    switch (command) {
      case "/compact": {
        const handle = this._liveHandle();
        if (!handle) return false;
        await handle.ensureAttached();
        if (!handle.agentSession) return false;
        await handle.agentSession.compact(rest.join(" ") || undefined);
        return true;
      }
      case "/quit":
      case "/exit":
        this.onClose();
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Top-level render — composes header / body / usage / editor / footer
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(40, width);
    const stage = this._currentStage();
    const blocked = this._isBlocked();

    this.chatHost.focused = this.focused;
    const headerLines = this._renderHeader(w, stage);
    const sepLines = [this._sepRule(w)];
    const customUiActive = this.mountedCustomUi !== null;
    this._syncPromptState(stage?.pendingPrompt);
    const promptActive = !customUiActive && this.promptState !== null;
    const readOnlyArchive = this._isReadOnlyArchive(stage);

    // ask_user_question / readiness-gate custom UI renders as a bottom panel
    // (in the high-priority composer slot) so the live transcript stays visible
    // and scrollable above it — matching the standalone ask_user_question tool.
    // Structured prompt nodes and read-only archives keep their full-body
    // treatment below.
    const customUiLines = customUiActive ? this._renderCustomUi(w) : [];
    const chatChromeHidden = customUiActive || promptActive || readOnlyArchive;
    const pendingLines = chatChromeHidden ? [] : this.chatHost.renderPendingMessages(w);
    const workingLines = chatChromeHidden ? [] : this.chatHost.renderWorkingStatus(w);
    const usageLines = chatChromeHidden ? [] : this.chatHost.renderUsage(w);
    const editorLines = chatChromeHidden ? [] : this.chatHost.renderEditor(w);
    const footerLines = chatChromeHidden ? [] : this.chatHost.renderFooter(w);

    const totalRows = this._viewLineCount();
    const plan = planStageChatFrame({
      viewportRows: totalRows,
      headerRows: HEADER_ROWS,
      separatorRows: SEP_ROWS,
      pendingRows: pendingLines.length,
      workingRows: workingLines.length,
      usageRows: usageLines.length,
      // The custom UI question takes the reserved bottom (composer) slot so the
      // transcript above keeps as much room as possible and the question never
      // clips below the overlay boundary.
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
    if (promptActive) {
      bodyLines = this._renderPromptBody(w, bodyBudget);
    } else if (blocked) {
      bodyLines = this._renderBlockedBody(w, bodyBudget, stage);
    } else if (!readOnlyArchive && this._isPaused(stage)) {
      bodyLines = this._renderPausedBody(w, bodyBudget);
    } else if (readOnlyArchive) {
      bodyLines = this._renderReadOnlyArchiveBody(w, bodyBudget, stage);
    } else {
      // Live transcript. When a custom UI question is active it renders in the
      // composer slot above; the transcript here stays visible and scrollable.
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
    return fitStageChatFrame(lines, totalRows, this._blank(w));
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  private _renderHeader(
    width: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    const t = this.theme;
    const stageName = stage?.name ?? "stage";

    // Left side: `  STAGE  <wf> / <stage>`
    const left =
      paint("   ", t.mauve, { bold: true }) +
      paint("STAGE", t.textMuted, { bold: true }) +
      "  " +
      paint(this.workflowName, t.textMuted) +
      paint(" / ", t.dim) +
      paint(stageName, t.text, { bold: true });

    // Right side: stable session metadata only. Avoid workflow-status chrome
    // in the embedded chat so the surface does not change colour when the
    // workflow stage settles.
    const meta = this._headerMeta(stage);
    const right = meta ? paint(meta, t.dim) + " " : "";

    const leftW =
      visibleWidth(this.workflowName) +
      visibleWidth(stageName) +
      visibleWidth("  STAGE   /  ") +
      1;
    const rightW = visibleWidth(meta) + (meta ? 1 : 0);
    const gap = Math.max(1, width - leftW - rightW);
    return [left + " ".repeat(gap) + right];
  }

  private _headerMeta(stage: StageSnapshot | undefined): string {
    const parts: string[] = [];
    const sid = this.handle?.sessionId ?? stage?.sessionId;
    if (sid) parts.push(`session ${shortenId(sid)}`);
    return parts.join(" · ");
  }

  private _sepRule(width: number): string {
    return hexToAnsi(this.theme.borderDim) + "─".repeat(width) + RESET;
  }

  // -------------------------------------------------------------------------
  // Body — welcome panel / banner + transcript / blocked
  // -------------------------------------------------------------------------

  private _renderReadOnlyArchiveBody(
    width: number,
    budget: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    if (stage?.promptFootprint) {
      return this._renderReadOnlyPromptArchiveBody(width, budget, stage);
    }

    const t = this.theme;
    const calloutRows = 6;
    const transcriptBudget = Math.max(1, budget - calloutRows);
    const lines = this.chatHost.renderBody(width, transcriptBudget);
    const callout: string[] = [];
    callout.push(this._blank(width));
    callout.push(
      ...this._bannerLines(
        width,
        "info",
        "◌",
        "READ-ONLY SESSION",
        stage?.sessionFile ? "archived transcript" : "no live chat session",
      ),
    );
    callout.push(
      ...new Text(
        paint("This node is no longer attached to a live chat session.", t.textMuted),
        2,
        0,
      ).render(width),
    );
    callout.push(
      ...new Text(
        paint("esc", t.accent, { bold: true }) +
          paint(" close", t.textMuted) +
          paint("  ·  ", t.dim) +
          paint("ctrl+d", t.accent, { bold: true }) +
          paint(" return to graph", t.textMuted),
        2,
        0,
      ).render(width),
    );
    lines.push(...callout);
    while (lines.length < budget) lines.push(this._blank(width));
    if (lines.length > budget) lines.length = budget;
    return lines;
  }

  private _renderReadOnlyPromptArchiveBody(
    width: number,
    budget: number,
    stage: StageSnapshot,
  ): string[] {
    const t = this.theme;
    const prompt = stage.promptFootprint;
    if (!prompt) return this._fitBodyLines([], width, budget);

    const innerWidth = Math.max(2, width - 2);
    const bodyLines: string[] = [];
    const messageBox = new Box(2, 1);
    messageBox.addChild(new Text(paint(prompt.message, t.text), 0, 0));
    bodyLines.push(...messageBox.render(innerWidth));
    bodyLines.push(...new Text(paint("prompt type", t.textMuted, { bold: true }) + paint(`  ${prompt.kind}`, t.text), 2, 0).render(innerWidth));

    if (prompt.kind === "select" && prompt.choices && prompt.choices.length > 0) {
      bodyLines.push(...new Text(paint("choices", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
      for (const choice of prompt.choices) {
        bodyLines.push(...new Text(paint("• ", t.dim) + paint(choice, t.text), 4, 0).render(innerWidth));
      }
    } else if (prompt.kind === "confirm") {
      bodyLines.push(...new Text(paint("choices", t.textMuted, { bold: true }) + paint("  yes / no", t.text), 2, 0).render(innerWidth));
    }

    if ((prompt.kind === "input" || prompt.kind === "editor") && prompt.initial && prompt.initial.length > 0) {
      bodyLines.push(...new Text(paint("initial value shown", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
      bodyLines.push(...new Text(paint(prompt.initial, t.dim), 4, 0).render(innerWidth));
    }

    const answer = this._readOnlyPromptAnswer(stage, prompt);
    bodyLines.push("");
    bodyLines.push(...new Text(paint("your response", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
    bodyLines.push(...new Text(paint(answer, answer.startsWith("(") ? t.dim : t.text), 4, 0).render(innerWidth));
    bodyLines.push("");
    bodyLines.push(...new Text(
      paint("esc", t.accent, { bold: true }) +
        paint(" close", t.textMuted) +
        paint("  ·  ", t.dim) +
        paint("ctrl+d", t.accent, { bold: true }) +
        paint(" return to graph", t.textMuted),
      2,
      0,
    ).render(innerWidth));

    const title = stage.status === "skipped" ? "QUESTION SKIPPED" : "QUESTION ASKED";
    const cardLines = renderRoundedBoxLines({
      title,
      bodyLines,
      width,
      theme: t,
      accent: t.border,
    });
    return this._fitPromptBodyLines(cardLines, width, budget);
  }

  private _readOnlyPromptAnswer(stage: StageSnapshot, prompt: PendingPrompt): string {
    const answer = this.store.getStagePromptAnswer(this.runId, stage.id);
    if (answer && answer.promptId === prompt.id) {
      return formatReadOnlyPromptAnswer(answer.value, prompt.kind);
    }
    switch (stage.promptAnswerState) {
      case "ambiguous":
        return "(response replay is ambiguous)";
      case "unavailable":
        return "(response unavailable)";
      case "available":
        return "(response no longer in live memory)";
      default:
        return "(no response saved)";
    }
  }

  private _renderPausedBody(width: number, budget: number): string[] {
    const t = this.theme;
    const callout: string[] = [];
    callout.push(this._blank(width));
    callout.push(
      ...this._bannerLines(
        width,
        "warning",
        "❚❚",
        "PAUSED",
        "enter resumes · ctrl+d close",
      ),
    );
    callout.push(
      ...new Text(
        paint("This workflow stage is paused. Type a message below and press Enter to resume.", t.textMuted),
        2,
        0,
      ).render(width),
    );

    const calloutRows = Math.min(callout.length, Math.max(0, budget - 1));
    const transcriptBudget = Math.max(1, budget - calloutRows);
    const lines = this.chatHost.renderBody(width, transcriptBudget);
    lines.push(...callout.slice(0, calloutRows));
    while (lines.length < budget) lines.push(this._blank(width));
    if (lines.length > budget) lines.length = budget;
    return lines;
  }

  private _renderBlockedBody(
    width: number,
    budget: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    const t = this.theme;
    const upstream = stage?.blockedByStageId ?? "upstream stage";
    const lines: string[] = [];
    // Yellow banner — uses the same chrome vocabulary as paused/completed.
    lines.push(
      ...this._bannerLines(
        width,
        "warning",
        "↑",
        "BLOCKED",
        `waiting on ${upstream}`,
      ),
    );
    lines.push(this._blank(width));
    lines.push(
      ...new Text(
        paint(
          "This stage is waiting for the upstream stage to resume.",
          t.textMuted,
        ),
        2,
        0,
      ).render(width),
    );
    lines.push(
      ...new Text(
        paint("ctrl+d", t.accent, { bold: true }) +
          paint(" return to graph", t.textMuted),
        2,
        0,
      ).render(width),
    );
    while (lines.length < budget) lines.push(this._blank(width));
    if (lines.length > budget) lines.length = budget;
    return lines;
  }

  // Natural-height render of the mounted custom UI (no body padding): it is
  // placed in the composer slot so the transcript stays scrollable above it.
  private _renderCustomUi(width: number): string[] {
    const component = this.mountedCustomUi?.component;
    if (!component) return [];
    setComponentFocused(component, this.focused);
    return component.render(width);
  }

  private _renderPromptBody(width: number, budget: number): string[] {
    const primitiveLines = this._renderPrimitivePromptBody(width);
    if (primitiveLines) return this._fitPromptBodyLines(primitiveLines, width, budget);

    const state = this.promptState;
    const lines = state
      ? renderPromptCard({
        state,
        theme: this.theme,
        width,
        cursorOn: this.focused,
      })
      : [];
    return this._fitPromptBodyLines(lines, width, budget);
  }

  private _renderPrimitivePromptBody(width: number): string[] | null {
    const state = this.promptState;
    const editor = this.promptEditor;
    if (!state || !editor) return null;
    setEditorFocused(editor, this.focused);
    setEditorBorderColor(editor, (text) => hexToAnsi(this.theme.accent) + text + RESET);

    const innerWidth = Math.max(2, width - 2);
    const bodyLines: string[] = [];
    const messageBox = new Box(2, 1);
    messageBox.addChild(new Text(paint(state.prompt.message, this.theme.text), 0, 0));
    bodyLines.push(...messageBox.render(innerWidth));
    bodyLines.push(...new Text(paint("response", this.theme.textMuted, { bold: true }), 2, 0).render(innerWidth));
    for (const line of editor.render(Math.max(20, innerWidth - 4))) {
      bodyLines.push("  " + line);
    }
    bodyLines.push("");
    bodyLines.push(...new Text(renderHintsForPrompt(state.prompt.kind, this.theme), 2, 0).render(innerWidth));

    return renderRoundedBoxLines({
      title: "AWAITING INPUT",
      bodyLines,
      width,
      theme: this.theme,
      accent: this.theme.border,
    });
  }

  private _fitPromptBodyLines(lines: readonly string[], width: number, budget: number): string[] {
    this.promptMaxScroll = Math.max(0, lines.length - budget);
    this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScroll));
    const framed = lines.slice(this.promptScrollOffset, this.promptScrollOffset + budget);
    while (framed.length < budget) framed.push(this._blank(width));
    return framed;
  }

  private _fitBodyLines(lines: readonly string[], width: number, budget: number): string[] {
    const framed = lines.slice(0, budget);
    while (framed.length < budget) framed.push(this._blank(width));
    return framed;
  }

  private _noticeRow(entry: NoticeEntry): Component {
    const theme = this.theme;
    return {
      render(width: number): string[] {
        return renderWorkflowNoticeCard({
          ...stageNoticeCard(entry),
          fallbackText: entry.text,
          width,
          theme,
        });
      },
      invalidate() {
        /* notice entries are immutable */
      },
    };
  }

  // -------------------------------------------------------------------------
  // Banners (paused / completed / failed / blocked)
  // -------------------------------------------------------------------------

  private _banner(
    kind: "warning" | "success" | "error" | "info",
    glyph: string,
    label: string,
    meta: string,
  ): Component {
    const t = this.theme;
    const fg =
      kind === "warning"
        ? t.warning
        : kind === "success"
          ? t.success
          : kind === "info"
            ? t.info
            : t.error;
    const bg = blendBg(t.bg, fg, 0.1);
    const head =
      paintOnFill(glyph, fg, { bold: true }) +
      "  " +
      paintOnFill(label, fg, { bold: true }) +
      "  " +
      paintOnFill(stripAnsi(meta), t.dim);
    const box = new Box(2, 0, bgFn(bg));
    box.addChild(new Text(head, 0, 0));
    return box;
  }

  /**
   * Banner rendered directly as string lines. Used by `_renderBlockedBody`
   * which builds its body out of raw rows rather than a Component[] stack.
   */
  private _bannerLines(
    width: number,
    kind: "warning" | "success" | "error" | "info",
    glyph: string,
    label: string,
    meta: string,
  ): string[] {
    return this._banner(kind, glyph, label, meta).render(width);
  }

  private _editorRuleColor(
    disabled: boolean,
    agentSession: AgentSession | undefined,
    state?: { isBashMode: boolean },
  ): string {
    if (disabled) return this.theme.borderDim;
    if (state?.isBashMode) return this.theme.warning;
    const level = agentSession?.state.thinkingLevel ?? "off";
    switch (level) {
      case "minimal":
        return this.theme.borderDim;
      case "low":
        return this.theme.info;
      case "medium":
        return this.theme.accent;
      case "high":
        return this.theme.mauve;
      case "xhigh":
        return this.theme.error;
      case "off":
      default:
        return this.theme.border;
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private _blank(width: number): string {
    return " ".repeat(width);
  }

  wantsMouseScrollTracking(): boolean {
    return true;
  }

  private _promptKeybindings(): KeybindingsLike | undefined {
    return isKeybindingsLike(this.piKeybindings) ? this.piKeybindings : undefined;
  }

  private _canSubmitPrompt(promptId: string): boolean {
    return this.canSubmitPrompt?.(this.runId, this.stageId, promptId) ?? true;
  }

  private _handlePromptInput(data: string): void {
    const state = this.promptState;
    if (!state) return;
    if (this.promptEditor && this.promptEditorPromptId === state.prompt.id) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this._resolvePromptResponse(state.prompt.id, defaultResponseFor(state.prompt), {
          suppressNextGraphSubmit: false,
        });
        return;
      }
      if (isPromptEscapeInput(data)) {
        this.requestRender?.();
        return;
      }
      setEditorFocused(this.promptEditor, this.focused);
      this.promptEditorSubmitFromEnter = matchesKey(data, Key.enter);
      try {
        this.promptEditor.handleInput(data);
      } finally {
        this.promptEditorSubmitFromEnter = false;
      }
      this.requestRender?.();
      return;
    }
    const action = handlePromptCardInput(data, state, this._promptKeybindings());
    if (action.kind === "noop") {
      this.requestRender?.();
      return;
    }
    const prompt = state.prompt;
    const response = action.kind === "submit"
      ? action.response
      : defaultResponseFor(prompt);
    this._resolvePromptResponse(prompt.id, response, {
      suppressNextGraphSubmit: action.kind === "submit" && matchesKey(data, Key.enter),
    });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): boolean {
    if (this.mountedCustomUi) {
      if (!this._canSubmitPrompt(this.mountedCustomUi.request.id)) {
        this.requestRender?.();
        return true;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        // Detach stops *viewing* the stage; it does not cancel a pending
        // human-input request. Release the local display only — the request
        // stays pending (the stage remains awaiting_input) and is re-displayed
        // when the user re-attaches.
        this._releaseMountedCustomUi();
        if (this._isPaused()) this.onClose();
        else this.onDetach();
        return true;
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        // Close hides the overlay; the background run — and its pending
        // human-input request — keep living. Release the local display only.
        this._releaseMountedCustomUi();
        this.onClose();
        return true;
      }
      // Let scroll input (mouse wheel / pageUp / pageDown / home / end) reach
      // the transcript so history stays scrollable while the question is shown,
      // matching the standalone ask_user_question tool. Navigation keys
      // (arrows / enter / typing) fall through to the question component.
      if (this.chatHost.handleScrollInput(data)) {
        this.requestRender?.();
        return true;
      }
      setComponentFocused(this.mountedCustomUi.component, this.focused);
      this.mountedCustomUi.component.handleInput?.(data);
      this.requestRender?.();
      return true;
    }
    const stage = this._currentStage();
    this._syncPromptState(stage?.pendingPrompt);
    const readOnlyArchive = this._isReadOnlyArchive(stage);
    const readOnlyPromptArchive = readOnlyArchive && stage?.promptFootprint !== undefined;
    if (matchesKey(data, Key.ctrl("d"))) {
      if (!this.promptState && this.chatHost.hasInputText()) return this.chatHost.handleInput(data);
      if (this._isPaused()) this.onClose();
      else this.onDetach();
      return true;
    }
    if (this.promptState) {
      if (this._handlePromptScrollInput(data, this.promptEditor === null)) return true;
      this._handlePromptInput(data);
      return true;
    }
    if (readOnlyPromptArchive && this._handlePromptScrollInput(data, true)) {
      return true;
    }
    if (this.chatHost.handleScrollInput(data)) {
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      if (
        this._isStreaming() ||
        this.chatHost.isBashRunning() ||
        this.chatHost.isEditingBashCommand()
      ) {
        return this.chatHost.handleInput(data);
      }
      this.onClose();
      return true;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return true;
    }
    if (readOnlyArchive) return true;
    const blocked = this._isBlocked();
    if (matchesKey(data, Key.ctrl("f"))) {
      if (blocked) return true;
      void this.chatHost.submit("followUp");
      return true;
    }
    if (blocked) return true;
    return this.chatHost.handleInput(data);
  }

  private _handlePromptScrollInput(data: string, includeKeyboard = true): boolean {
    const wheelDeltaRows = this._mouseWheelDeltaRows(data);
    if (wheelDeltaRows !== 0) {
      this._scrollPromptBy(wheelDeltaRows);
      return true;
    }
    if (this._isMouseSequence(data)) return true;
    if (!includeKeyboard) return false;
    if (matchesKey(data, "pageUp")) {
      this._scrollPromptBy(-this._promptPageSize());
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this._scrollPromptBy(this._promptPageSize());
      return true;
    }
    if (!this.promptEditor && matchesKey(data, "home")) {
      this.promptScrollOffset = 0;
      this.requestRender?.();
      return true;
    }
    if (!this.promptEditor && matchesKey(data, "end")) {
      this.promptScrollOffset = this.promptMaxScroll;
      this.requestRender?.();
      return true;
    }
    return false;
  }

  private _scrollPromptBy(deltaRows: number): void {
    this.promptScrollOffset = Math.max(
      0,
      Math.min(this.promptMaxScroll, this.promptScrollOffset + deltaRows),
    );
    this.requestRender?.();
  }

  private _promptPageSize(): number {
    return Math.max(4, this._viewLineCount() - HEADER_ROWS - SEP_ROWS - 2);
  }

  private _mouseWheelDeltaRows(data: string): number {
    const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
    if (sgr) return this._wheelDeltaForButtonCode(Number.parseInt(sgr[1]!, 10));
    if (data.startsWith("\x1b[M") && data.length >= 6) {
      return this._wheelDeltaForButtonCode(data.charCodeAt(3) - 32);
    }
    return 0;
  }

  private _wheelDeltaForButtonCode(code: number): number {
    if ((code & 64) === 0) return 0;
    const direction = code & 3;
    if (direction === 0) return -PROMPT_SCROLL_STEP_ROWS;
    if (direction === 1) return PROMPT_SCROLL_STEP_ROWS;
    return 0;
  }

  private _isMouseSequence(data: string): boolean {
    return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M");
  }

  invalidate(): void {
    this._syncPromptState(this._currentStage()?.pendingPrompt);
  }

  dispose(): void {
    if (this.focusHoldTimer !== undefined) {
      clearInterval(this.focusHoldTimer);
      this.focusHoldTimer = undefined;
    }
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this._unsubscribeHandle?.();
    this._unsubscribeHandle = null;
    this._releaseMountedCustomUi();
    this._disposePromptEditor();
    this._unregisterStageUiHost?.();
    this._unregisterStageUiHost = null;
    this.chatHost.dispose();
  }

  private _hideMountedCustomUi(request: StageCustomUiRequest): void {
    // Signal any in-flight `_showCustomUi` mount for this request to drop its
    // component when it finishes — the broker is already tearing it down.
    if (this.mountingRequestId === request.id) this.mountingRequestId = null;
    const mounted = this.mountedCustomUi;
    if (!mounted || mounted.request.id !== request.id) return;
    this.mountedCustomUi = null;
    mounted.component.dispose?.();
    this.chatHost.focused = this.focused;
    this.chatHost.scrollToBottom();
    // Returning to the composer after a custom UI resolves (e.g. the readiness
    // gate -> "stay") must re-assert overlay focus so the composer accepts
    // input. Guarded for streaming so an answered mid-turn ask_user_question
    // does not refocus during the agent's continuation (would stall it).
    if (!this._isStreaming()) this.requestFocus?.();
    this.requestRender?.();
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
  private _releaseMountedCustomUi(): void {
    this.mountingRequestId = null;
    const mounted = this.mountedCustomUi;
    if (!mounted) return;
    this.mountedCustomUi = null;
    mounted.component.dispose?.();
  }

  // ---- Test seams ----
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

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

interface TranscriptDebugEntry {
  readonly role: string;
  readonly text: string;
  readonly toolCallId: string;
  readonly state: string;
  readonly output: string;
}

function formatReadOnlyPromptAnswer(value: unknown, kind: PendingPrompt["kind"]): string {
  if (kind === "confirm") return value === true ? "yes" : "no";
  if (typeof value === "string") return value.length > 0 ? value : "(empty response)";
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return String(value);
  }
}

function transcriptDebugEntries(entry: TranscriptEntry): TranscriptDebugEntry[] {
  if (isChatMessageEntry(entry) && entry.kind === "assistant") {
    const entries: TranscriptDebugEntry[] = [];
    const thinking = extractThinkingText(entry.message.content);
    const text = extractMessageText(entry.message.content);
    if (thinking)
      entries.push({
        role: "thinking",
        text: thinking,
        toolCallId: "",
        state: "",
        output: "",
      });
    if (text || entries.length === 0)
      entries.push({ ...entry, text, toolCallId: "", state: "", output: "" });
    return entries;
  }
  return [
    {
      ...entry,
      role: entry.role,
      text: transcriptDebugText(entry),
      toolCallId: transcriptDebugToolCallId(entry),
      state: transcriptDebugToolState(entry),
      output: transcriptDebugToolOutput(entry),
    },
  ];
}

function transcriptDebugText(entry: TranscriptEntry): string {
  if ("text" in entry && typeof entry.text === "string") return entry.text;
  if (isChatMessageEntry(entry)) {
    switch (entry.kind) {
      case "assistant":
        return extractMessageText(entry.message.content);
      case "tool":
        return entry.result
          ? extractToolResultText(entry.result)
          : `${entry.toolName} ${typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args ?? {})}`;
      case "bashExecution":
        return entry.message.output || entry.message.command;
      case "user":
      case "system":
        return entry.text;
      case "custom":
        return extractMessageText(entry.message.content);
      case "branchSummary":
      case "compactionSummary":
        return entry.message.summary;
    }
  }
  return "";
}

function transcriptDebugToolCallId(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool")
    return entry.toolCallId;
  if ("toolCallId" in entry && typeof entry.toolCallId === "string")
    return entry.toolCallId;
  return "";
}

function transcriptDebugToolState(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool") {
    if (entry.result?.isError) return "error";
    return entry.isPartial === false ? "success" : "pending";
  }
  if ("state" in entry && typeof entry.state === "string") return entry.state;
  return "";
}

function transcriptDebugToolOutput(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool")
    return entry.result ? extractToolResultText(entry.result) : "";
  if ("output" in entry && typeof entry.output === "string")
    return entry.output;
  return "";
}

function cursorBlock(): string {
  return "\x1b[7m \x1b[0m";
}

function setComponentFocused(component: Component, focused: boolean): void {
  const candidate = component as Component & Partial<Focusable>;
  if ("focused" in candidate) candidate.focused = focused;
}

function setEditorFocused(editor: EditorComponent, focused: boolean): void {
  setComponentFocused(editor, focused);
}

function setEditorPlaceholder(editor: EditorComponent, placeholder: string | undefined): void {
  const candidate = editor as EditorComponent & {
    setPlaceholder?: (value: string | undefined) => void;
  };
  candidate.setPlaceholder?.(placeholder);
}

function setEditorBorderColor(
  editor: EditorComponent,
  borderColor: (text: string) => string,
): void {
  const candidate = editor as EditorComponent & {
    borderColor?: (text: string) => string;
  };
  if ("borderColor" in candidate) candidate.borderColor = borderColor;
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
  return "kind" in entry && entry.role !== "notice";
}

function extractThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null || typeof item !== "object") continue;
    const thinking = (item as { type?: unknown; thinking?: unknown }).thinking;
    if (
      (item as { type?: unknown }).type === "thinking" &&
      typeof thinking === "string"
    )
      parts.push(thinking);
  }
  return parts.join("\n\n");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const obj = item as { type?: unknown; text?: unknown };
    if (typeof obj.text === "string") parts.push(obj.text);
    else if (obj.type === "text" && typeof obj.text === "string")
      parts.push(obj.text);
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return extractMessageText(content);
}

function noticeSummary(n: StageNotice): string {
  const base = `~ ${n.kind} → ${n.to}`;
  return n.from ? `${base} (was ${n.from})` : base;
}

function stageNoticeCard(entry: NoticeEntry): {
  title: string;
  glyph: string;
  headline: string;
  tone: WorkflowNoticeTone;
  fields: Array<{ label: string; value: string | undefined; tone?: WorkflowNoticeTone | "text" | "muted" }>;
} {
  switch (entry.kind) {
    case "abort":
      return {
        title: "STAGE ABORTED",
        glyph: "✗",
        headline: "Stage received an abort notice",
        tone: "error",
        fields: stageNoticeFields(entry, "error"),
      };
    case "compaction":
      return {
        title: "STAGE COMPACTION",
        glyph: "✓",
        headline: "Stage context was compacted",
        tone: "success",
        fields: stageNoticeFields(entry, "muted"),
      };
    case "model":
      return {
        title: "STAGE MODEL",
        glyph: "→",
        headline: "Stage model changed",
        tone: "info",
        fields: stageNoticeFields(entry),
      };
    case "thinking":
      return {
        title: "STAGE THINKING",
        glyph: "→",
        headline: "Stage thinking level changed",
        tone: "mauve",
        fields: stageNoticeFields(entry),
      };
    case "tree":
      return {
        title: "STAGE TREE",
        glyph: "◆",
        headline: "Stage branch tree changed",
        tone: "info",
        fields: stageNoticeFields(entry, "muted"),
      };
    case "mcp":
    default:
      return {
        title: "STAGE NOTICE",
        glyph: "◆",
        headline: "Workflow stage notice",
        tone: "info",
        fields: stageNoticeFields(entry, "muted"),
      };
  }
}

function stageNoticeFields(
  entry: NoticeEntry,
  valueTone: WorkflowNoticeTone | "text" | "muted" = "text",
): Array<{ label: string; value: string | undefined; tone?: WorkflowNoticeTone | "text" | "muted" }> {
  return [
    { label: "kind", value: entry.kind, tone: "muted" },
    { label: "value", value: entry.value, tone: valueTone },
    { label: "from", value: entry.from, tone: "muted" },
    { label: "meta", value: entry.meta, tone: "muted" },
  ];
}

function shortenId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function bgFn(hex: string): (text: string) => string {
  const open = hexBg(hex);
  return (text: string) => open + text + RESET;
}

function editorThemeFromGraphTheme(t: GraphTheme): EditorTheme {
  const selected = (text: string): string =>
    hexBg(t.backgroundPanel) + hexToAnsi(t.text) + text + RESET;
  const normal = (text: string): string => hexToAnsi(t.text) + text + RESET;
  return {
    borderColor: (text: string) => hexToAnsi(t.border) + text + RESET,
    selectList: {
      selectedPrefix: selected,
      selectedText: selected,
      description: (text: string) => hexToAnsi(t.dim) + text + RESET,
      scrollInfo: (text: string) => hexToAnsi(t.dim) + text + RESET,
      noMatch: (text: string) => hexToAnsi(t.warning) + text + RESET,
      normal,
    },
  } as EditorTheme;
}

function takeRows(lines: readonly string[], rows: number): string[] {
  return lines.slice(0, rows);
}

interface PaintOpts {
  bold?: boolean;
  italic?: boolean;
  bg?: string;
}

function paint(text: string, fg: string, opts: PaintOpts = {}): string {
  if (!text) return "";
  let out = hexToAnsi(fg);
  if (opts.bold) out += BOLD;
  if (opts.italic) out += ITALIC;
  if (opts.bg) out = hexBg(opts.bg) + out;
  return out + text + RESET;
}

function renderHintsForPrompt(kind: PendingPrompt["kind"], theme: GraphTheme): string {
  if (kind === "input" || kind === "editor") {
    return `${paint("enter", theme.textMuted, { bold: true })} Submit · ${paint("ctrl+c", theme.textMuted, { bold: true })} Skip`;
  }
  return `${paint("enter", theme.textMuted, { bold: true })} Select · ${paint("ctrl+c", theme.textMuted, { bold: true })} Skip`;
}

/**
 * Foreground styling for text that will be wrapped by a `Box` background.
 * A normal `RESET` would also clear the parent background, so close only the
 * inline foreground/weight/italic state and let `bgFn()` reset the row at end.
 */
function paintOnFill(text: string, fg: string, opts: PaintOpts = {}): string {
  if (!text) return "";
  let out = hexToAnsi(fg);
  if (opts.bold) out += BOLD;
  if (opts.italic) out += ITALIC;
  let close = FG_RESET;
  if (opts.bold) close += WEIGHT_RESET;
  if (opts.italic) close += ITALIC_RESET;
  return out + text + close;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Approximate a tinted background by mixing the base canvas with a saturated
 * hue at low alpha. Used for status pills and tool-bar tints. Returns a hex
 * colour the renderer can feed to `hexBg`.
 */
function blendBg(baseHex: string, tintHex: string, alpha: number): string {
  return lerpColor(baseHex, tintHex, Math.max(0, Math.min(1, alpha)));
}
