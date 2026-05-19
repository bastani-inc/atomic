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
 *  - workflow notices remain lightweight workflow-specific rows because they
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
  ChatTranscriptComponent,
  CustomEditor,
  FooterComponent,
  ScrollableComponentViewport,
  SessionManager,
  LiveChatEntriesController,
  UsageMeterComponent,
  WorkingStatusComponent,
  pickWhimsicalWorkingMessage,
  renderChatMessageEntry,
  type AgentSession,
  type AgentSessionEvent,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
  type ReadonlyFooterDataProvider,
} from "@bastani/atomic";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  Component,
  EditorComponent,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import type { StageNotice, StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import type { GraphTheme } from "./graph-theme.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { BOLD, RESET, hexBg, hexToAnsi, lerpColor } from "./color-utils.js";
import { matchesKey, truncateToWidth, visibleWidth } from "./text-helpers.js";

// ---------------------------------------------------------------------------
// Options & types
// ---------------------------------------------------------------------------

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
  onDetach: () => void;
  /** Called when the user presses Escape (close the whole popup). */
  onClose: () => void;
  /** Request a host TUI repaint after SDK events mutate local chat state. */
  requestRender?: () => void;
  /** Live pi-tui host objects. When present, stage input uses pi's editor UI. */
  piTui?: TUI;
  piKeybindings?: unknown;
  /** Currently installed host editor factory, inherited from extension `ctx.ui.setEditorComponent()`. */
  piEditorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: unknown,
  ) => EditorComponent;
  /** Parent chat rendering settings and extension renderers inherited from the host UI. */
  getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd" | "markdownTheme">>
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
}

/**
 * Transcript model. Every variant carries a flat `.text` summary so consumers
 * that read `_transcript` (tests, future serialisers) can recover the
 * canonical user-visible string without knowing about the Pi-box payload.
 */
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

/** Header strip — `▎ STAGE  wf / stage   <meta>   ● status` */
const HEADER_ROWS = 1;
/** Single dim rule between header and body. */
const SEP_ROWS = 1;
/** Spinner glyphs — Braille spinner at 80ms per frame. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pi's Loader advances at 80ms; use the same cadence for embedded stage chats. */
const ANIMATION_FRAME_MS = 80;
const STREAMING_RENDER_THROTTLE_MS = 80;
const STREAMING_TEXT_TAIL_LINES = 240;
const STREAMING_TEXT_TAIL_CHARS = 16_000;

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
  private onDetach: () => void;
  private onClose: () => void;
  private requestRender: (() => void) | undefined;
  private getViewportRows?: () => number | undefined;
  private editor: EditorComponent | undefined;
  private getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd" | "markdownTheme">>
    | undefined;
  private footerData?: ReadonlyFooterDataProvider;

  private inputBuffer = "";
  private transcript: TranscriptEntry[] = [];
  private statusMessage = "";
  /** True while a pending pause request is in flight (between ctrl+p and resolve). */
  private localPaused = false;
  /** De-dup set so the store subscription doesn't re-append known notices. */
  private seenNoticeIds = new Set<string>();
  /** Wall-clock at construction, used to colour the spinner frame stably. */
  private attachedAt = Date.now();
  /** True after SDK `agent_start` until `agent_end`; mirrors Pi's working-loader lifecycle. */
  private sdkBusy = false;
  /** Pi-style per-turn working message, populated from coding-agent's message picker. */
  private workingMessage: string | undefined;
  /** User rows optimistically appended by this embedded editor, de-duped on SDK echo. */
  private optimisticUserSignatures = new Set<string>();
  /** Pending steering messages emitted by AgentSession queue updates. */
  private pendingSteeringMessages: readonly string[] = [];
  /** Pending follow-up messages emitted by AgentSession queue updates. */
  private pendingFollowUpMessages: readonly string[] = [];
  /** Chat-mode repaint driver for Pi-style loaders/spinners. */
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  /** Coalesces high-frequency SDK deltas while the fixed overlay is streaming. */
  private renderThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Scrollable fixed-height body viewport for attached chat history. */
  private bodyViewport = new ScrollableComponentViewport();
  private liveChat: LiveChatEntriesController;

  private _unsubscribeStore: (() => void) | null = null;
  private _unsubscribeHandle: (() => void) | null = null;

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
    this.getViewportRows = opts.getViewportRows;
    this.getChatRenderSettings = opts.getChatRenderSettings;
    this.footerData = opts.footerData;
    this.liveChat = new LiveChatEntriesController(this.transcript);
    this.editor = this._createEditor(
      opts.piTui,
      opts.piKeybindings,
      opts.piEditorFactory,
    );

    // Seed transcript from the live SDK session at attach time, plus any
    // stage notices the workflow body has already recorded.
    this._snapshotMessagesFromHandle();
    const initialStage = this._currentStage();
    this._snapshotMessagesFromSessionFile(initialStage);
    this._absorbStageNotices(initialStage);

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
      this._syncAnimationTick();
      if (changed) this.requestRender?.();
    });

    if (this.handle) {
      this._unsubscribeHandle = this.handle.subscribe((event) => {
        const changed = this._appendEvent(event);
        this._syncAnimationTick();
        if (changed) this._requestEventRender();
      });
    }
    this._syncAnimationTick();
  }

  private _createEditor(
    tui: TUI | undefined,
    keybindings: unknown,
    editorFactory:
      | ((
          tui: TUI,
          theme: EditorTheme,
          keybindings: unknown,
        ) => EditorComponent)
      | undefined,
  ): EditorComponent | undefined {
    if (!tui || !keybindings) return undefined;
    const editorTheme = editorThemeFromGraphTheme(this.theme);
    const editor =
      this._createInheritedEditor(
        tui,
        editorTheme,
        keybindings,
        editorFactory,
      ) ??
      new CustomEditor(
        tui,
        editorTheme,
        keybindings as ConstructorParameters<typeof CustomEditor>[2],
        { paddingX: 0, autocompleteMaxVisible: 5 },
      );
    editor.onChange = (text) => {
      this.inputBuffer = text;
    };
    editor.onSubmit = (text) => {
      void this._submit("auto", text);
    };
    return editor;
  }

  private _createInheritedEditor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: unknown,
    editorFactory:
      | ((
          tui: TUI,
          theme: EditorTheme,
          keybindings: unknown,
        ) => EditorComponent)
      | undefined,
  ): EditorComponent | undefined {
    if (!editorFactory) return undefined;
    try {
      return editorFactory(tui, editorTheme, keybindings);
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  private _snapshotMessagesFromHandle(): void {
    if (!this.handle) return;
    this.liveChat.appendMessages(this.handle.messages);
  }

  private _snapshotMessagesFromSessionFile(
    stage: StageSnapshot | undefined,
  ): void {
    if (this.transcript.length > 0) return;
    const sessionFile = this.handle?.sessionFile ?? stage?.sessionFile;
    if (sessionFile === undefined) return;

    let messages: readonly AgentSnapshotMessage[];
    try {
      messages = SessionManager.open(sessionFile).buildSessionContext()
        .messages as readonly AgentSnapshotMessage[];
    } catch {
      return;
    }

    this.liveChat.appendMessages(messages);
  }

  private _appendEvent(event: AgentSessionEvent): boolean {
    // Shared live transcript ingestion covers assistant/user/custom messages
    // and tool start/update/end rows. StageChatView keeps workflow-only status
    // events (pause, compaction captions, animation state) locally.
    const type = String((event as { type?: unknown }).type ?? "");
    if (type === "message_start") {
      const message = (event as { message?: unknown }).message;
      if (isUserMessageLike(message)) {
        const signature = userMessageSignature(
          extractMessageText(message.content),
        );
        if (this.optimisticUserSignatures.delete(signature)) return false;
      }
    }
    if (isSharedLiveChatEvent(type)) {
      const changed = this.liveChat.applyEvent(event);
      const toolCallEvent = assistantToolCallEvent(event);
      const changedByToolCall = toolCallEvent !== undefined
        ? this.liveChat.applyEvent(toolCallEvent)
        : false;
      return changed || changedByToolCall;
    }
    switch (type) {
      case "agent_start":
        this.sdkBusy = true;
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        return true;

      case "agent_end":
        this.sdkBusy = false;
        this.workingMessage = undefined;
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        return true;

      case "turn_start":
        this.workingMessage = pickWhimsicalWorkingMessage();
        return true;

      case "turn_end":
        this.workingMessage = undefined;
        return true;

      case "queue_update": {
        const queue = event as Extract<AgentSessionEvent, { type: "queue_update" }>;
        this.pendingSteeringMessages = queue.steering;
        this.pendingFollowUpMessages = queue.followUp;
        return true;
      }

      // Compatibility with older/headless shims that predate the SDK's
      // tool_execution_* events. Project these shims into coding-agent's live
      // controller rather than maintaining a second workflow tool renderer.
      case "tool_call":
      case "tool_use":
        return this.liveChat.applyEvent(legacyToolStartEvent(event));

      case "tool_result":
        return this.liveChat.applyEvent(legacyToolResultEvent(event));

      case "thinking_delta":
      case "thinking":
        return this.liveChat.applyEvent(legacyThinkingEvent(event));

      case "compaction_start":
        this.sdkBusy = true;
        this.statusMessage = "compacting context…";
        return true;

      case "compaction_end":
        this.sdkBusy = false;
        this.statusMessage = "";
        return true;

      case "auto_retry_start":
        this.sdkBusy = true;
        this.statusMessage = "retrying…";
        return true;

      case "auto_retry_end":
        this.statusMessage = "";
        return true;

      default:
        return false;
    }
  }

  private _absorbStageNotices(stage: StageSnapshot | undefined): boolean {
    const notices = stage?.notices;
    if (!notices) return false;
    let changed = false;
    for (const n of notices) {
      if (this.seenNoticeIds.has(n.id)) continue;
      this.seenNoticeIds.add(n.id);
      changed = true;
      this.transcript.push({
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
    return Math.max(VIEW_LINE_COUNT, Math.floor(reported));
  }

  private _isStreaming(): boolean {
    return this.sdkBusy || Boolean(this.handle?.isStreaming);
  }

  private _hasPendingToolEntries(): boolean {
    return this.liveChat.pendingToolIds().length > 0;
  }

  private _syncAnimationTick(): void {
    const shouldAnimate =
      this._isStreaming() || (this.sdkBusy && this._hasPendingToolEntries());
    if (shouldAnimate && !this.animationTimer) {
      this.animationTimer = setInterval(() => {
        this.requestRender?.();
      }, ANIMATION_FRAME_MS);
      this.animationTimer.unref?.();
      return;
    }
    if (!shouldAnimate && this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  private _requestEventRender(): void {
    if (!this._isStreaming()) {
      this.requestRender?.();
      return;
    }
    if (this.renderThrottleTimer) return;
    this.renderThrottleTimer = setTimeout(() => {
      this.renderThrottleTimer = undefined;
      this.requestRender?.();
    }, STREAMING_RENDER_THROTTLE_MS);
    this.renderThrottleTimer.unref?.();
  }

  private _isBlocked(): boolean {
    return this._currentStage()?.status === "blocked";
  }

  private _isPaused(
    stage: StageSnapshot | undefined = this._currentStage(),
  ): boolean {
    return this.localPaused || stage?.status === "paused";
  }

  // -------------------------------------------------------------------------
  // Top-level render — composes header / body / usage / editor / footer
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(40, width);
    const stage = this._currentStage();
    const blocked = this._isBlocked();
    const streaming = this._isStreaming() && !blocked;

    const headerLines = this._renderHeader(w, stage);
    const sepLines = [this._sepRule(w)];
    const pendingLines = this._renderPendingMessages(w);
    const workingLines = this._renderWorkingStatus(w, stage, { streaming });
    const usageLines = this._renderUsage(w);
    const editorLines = this._renderEditor(w, blocked);
    const footerLines = this._renderFooter(w);

    const fixed =
      HEADER_ROWS +
      SEP_ROWS +
      pendingLines.length +
      workingLines.length +
      usageLines.length +
      editorLines.length +
      footerLines.length;
    const totalRows = this._viewLineCount();
    const bodyBudget = Math.max(1, totalRows - fixed);
    this.bodyViewport.setVisibleRows(bodyBudget);
    if (blocked) this.bodyViewport.scrollToBottom();
    const bodyLines = blocked
      ? this._renderBlockedBody(w, bodyBudget, stage)
      : this._renderBody(w, bodyBudget);
    const lines = [
      ...headerLines,
      ...sepLines,
      ...bodyLines,
      ...pendingLines,
      ...workingLines,
      ...usageLines,
      ...editorLines,
      ...footerLines,
    ];
    while (lines.length < totalRows) lines.push(this._blank(w));
    if (lines.length > totalRows) lines.length = totalRows;
    return lines;
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
    const status = stage?.status ?? (this.handle ? "pending" : "completed");

    // Left side: `▎ STAGE  <wf> / <stage>`
    const left =
      paint(" ▎ ", t.mauve, { bold: true }) +
      paint("STAGE", t.textMuted, { bold: true }) +
      "  " +
      paint(this.workflowName, t.textMuted) +
      paint(" / ", t.dim) +
      paint(stageName, t.text, { bold: true });

    // Right side: stage meta · status pill
    const meta = this._headerMeta(stage);
    const pill = this._statusPill(status);
    const right = (meta ? paint(meta, t.dim) + "  " : "") + pill.styled + " ";

    const leftW =
      visibleWidth(this.workflowName) +
      visibleWidth(stageName) +
      visibleWidth("  STAGE   /  ") +
      1;
    const rightW = visibleWidth(meta) + (meta ? 2 : 0) + pill.width + 1;
    const gap = Math.max(1, width - leftW - rightW);
    return [left + " ".repeat(gap) + right];
  }

  private _headerMeta(stage: StageSnapshot | undefined): string {
    const parts: string[] = [];
    if (stage) {
      const dur = stageDurationText(stage);
      if (dur) parts.push(dur);
    }
    const sid = this.handle?.sessionId ?? stage?.sessionId;
    if (sid) parts.push(`session ${shortenId(sid)}`);
    return parts.join(" · ");
  }

  /**
   * Render an inline ` ● status ` pill with the status colour applied to a
   * tinted background. Matches the mockup's `.status-pill` vocabulary.
   */
  private _statusPill(status: string): { styled: string; width: number } {
    const t = this.theme;
    const map: Record<string, { fg: string; bg: string; label: string }> = {
      pending: { fg: t.dim, bg: blendBg(t.bg, t.dim, 0.18), label: "pending" },
      running: {
        fg: t.accent,
        bg: blendBg(t.bg, t.accent, 0.18),
        label: "running",
      },
      paused: {
        fg: t.warning,
        bg: blendBg(t.bg, t.warning, 0.18),
        label: "paused",
      },
      blocked: {
        fg: t.warning,
        bg: blendBg(t.bg, t.warning, 0.18),
        label: "blocked",
      },
      completed: {
        fg: t.success,
        bg: blendBg(t.bg, t.success, 0.18),
        label: "completed",
      },
      failed: {
        fg: t.error,
        bg: blendBg(t.bg, t.error, 0.18),
        label: "failed",
      },
    };
    const cfg = map[status] ?? map.pending!;
    const body = ` ● ${cfg.label} `;
    return {
      styled: hexBg(cfg.bg) + hexToAnsi(cfg.fg) + BOLD + body + RESET,
      width: visibleWidth(body),
    };
  }

  private _sepRule(width: number): string {
    return hexToAnsi(this.theme.borderDim) + "─".repeat(width) + RESET;
  }

  // -------------------------------------------------------------------------
  // Body — welcome panel / banner + transcript / blocked
  // -------------------------------------------------------------------------

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

  private _renderBody(
    width: number,
    budget: number,
  ): string[] {
    const components: Component[] = [];
    // Base chat body: delegate transcript composition to the Pi-style
    // transcript component so the attached stage chat uses the same message
    // spacing and coding-agent message widgets as the main interactive chat.
    if (this.transcript.length > 0) {
      components.push(
        new ChatTranscriptComponent(this.transcript, (entry) =>
          this._renderEntry(entry),
        ),
      );
    }

    // Stream a static status message (e.g. "pausing…") as a dim trailing row.
    if (this.statusMessage) {
      components.push(new Spacer(1));
      components.push(
        new Text(paint(this.statusMessage, this.theme.dim), 2, 0),
      );
    }

    this.bodyViewport.setComponents(components);
    return this.bodyViewport.render(width);
  }

  // -------------------------------------------------------------------------
  // Transcript entry → pi/coding-agent Component. Stage chat deliberately uses
  // the same exported message/tool components as the main interactive chat
  // instead of maintaining parallel workflow-specific bubbles.
  // -------------------------------------------------------------------------

  private _renderEntry(entry: TranscriptEntry): Component {
    if (isChatMessageEntry(entry)) {
      return renderChatMessageEntry(
        this._streamingWindowedEntry(entry),
        this._chatMessageRenderOptions(),
      );
    }
    return this._noticeRow(entry);
  }

  private _streamingWindowedEntry(entry: ChatMessageEntry): ChatMessageEntry {
    if (!this._isStreaming() || this.bodyViewport.getScrollFromBottom() !== 0) {
      return entry;
    }
    if (entry.kind !== "assistant") return entry;
    const content = entry.message.content.map((item) => {
      if (item.type === "text") {
        return { ...item, text: tailStreamingText(item.text) };
      }
      if (item.type === "thinking") {
        return { ...item, thinking: tailStreamingText(item.thinking) };
      }
      return item;
    });
    return {
      ...entry,
      message: {
        ...entry.message,
        content,
      },
    };
  }

  private _chatMessageRenderOptions(): ChatMessageRenderOptions {
    const inherited = this.getChatRenderSettings?.();
    return {
      ...inherited,
      ui: this._toolTui(),
      cwd: this.handle?.agentSession?.sessionManager.getCwd() ?? process.cwd(),
      showImages: inherited?.showImages ?? true,
    };
  }

  private _toolTui(): TUI {
    return {
      requestRender: () => this.requestRender?.(),
    } as TUI;
  }

  private _noticeRow(entry: NoticeEntry): Component {
    const t = this.theme;
    const fromPart = entry.from ? paint(` (was ${entry.from})`, t.dim) : "";
    const metaPart = entry.meta ? "  " + paint(entry.meta, t.dim) : "";
    const line =
      paint("~ ", t.borderDim) +
      paint(entry.kind, t.mauve, { bold: true }) +
      paint(" → ", t.borderDim) +
      paint(entry.value, t.text) +
      fromPart +
      metaPart;
    return new Text(line, 2, 0);
  }

  // -------------------------------------------------------------------------
  // Banners (paused / completed / failed / blocked)
  // -------------------------------------------------------------------------

  private _banner(
    kind: "warning" | "success" | "error",
    glyph: string,
    label: string,
    meta: string,
  ): Component {
    const t = this.theme;
    const fg =
      kind === "warning" ? t.warning : kind === "success" ? t.success : t.error;
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
    kind: "warning" | "success" | "error",
    glyph: string,
    label: string,
    meta: string,
  ): string[] {
    return this._banner(kind, glyph, label, meta).render(width);
  }

  // -------------------------------------------------------------------------
  // Editor — top rule + ` ❯ … ` + bottom rule
  // -------------------------------------------------------------------------

  private _renderEditor(width: number, blocked: boolean): string[] {
    const t = this.theme;
    // Disabled only when no live chat handle exists or workflow dependencies
    // are blocked. A settled attached stage remains a regular chat session.
    const disabled = blocked || !this.handle;
    const ruleHex = this._editorRuleColor(disabled);
    if (!disabled && this.editor) {
      setEditorFocused(this.editor, this.focused);
      setEditorPlaceholder(this.editor, undefined);
      setEditorBorderColor(this.editor, ruleHex);
      return this.editor.render(width);
    }
    if (this.editor) setEditorFocused(this.editor, false);
    const rule = hexToAnsi(ruleHex) + "─".repeat(width) + RESET;

    const glyphHex = disabled ? t.dim : t.accent;
    const available = Math.max(1, width - 3);
    const value = this.inputBuffer
      ? paint(truncateToWidth(this.inputBuffer, available), t.text) + cursorBlock()
      : disabled
        ? ""
        : cursorBlock();

    const left = paint("❯", glyphHex, { bold: true }) + " " + value;
    const gap = Math.max(0, width - visibleWidth(stripAnsi(left)));
    const body = left + " ".repeat(gap);
    return [rule, body, rule];
  }

  private _editorRuleColor(disabled: boolean): string {
    if (disabled) return this.theme.borderDim;
    const level = this.handle?.agentSession?.state.thinkingLevel ?? "off";
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
  // Working, usage + footer — mirrors the main chat composer stack
  // -------------------------------------------------------------------------

  private _renderWorkingStatus(
    width: number,
    stage: StageSnapshot | undefined,
    flags: { streaming: boolean },
  ): string[] {
    if (!flags.streaming) return [];
    const t = this.theme;
    const dur = stageDurationText(stage);
    const message = this.workingMessage ?? `Working${dur ? "  · " + dur : ""}`;
    return new WorkingStatusComponent({
      spinner: spinnerFrame(),
      message,
      spinnerColor: (text) => paint(text, t.accent, { bold: true }),
      messageColor: (text) => paint(text, t.textMuted),
    }).render(width);
  }

  private _renderPendingMessages(width: number): string[] {
    if (
      this.pendingSteeringMessages.length === 0 &&
      this.pendingFollowUpMessages.length === 0
    ) {
      return [];
    }
    const lines = [this._blank(width)];
    for (const message of this.pendingSteeringMessages) {
      lines.push(...this._pendingMessageLine(width, "Steering", message));
    }
    for (const message of this.pendingFollowUpMessages) {
      lines.push(...this._pendingMessageLine(width, "Follow-up", message));
    }
    return lines;
  }

  private _pendingMessageLine(
    width: number,
    label: "Steering" | "Follow-up",
    message: string,
  ): string[] {
    const text = `${label}: ${message}`;
    return new Text(
      paint(truncateToWidth(text, Math.max(1, width - 2)), this.theme.dim),
      1,
      0,
    ).render(width);
  }

  private _renderUsage(width: number): string[] {
    const agentSession = this.handle?.agentSession;
    if (!agentSession) return [];
    return new UsageMeterComponent(agentSession).render(width);
  }

  private _renderFooter(width: number): string[] {
    const agentSession = this.handle?.agentSession;
    if (agentSession && this.footerData) {
      return new FooterComponent(agentSession, this.footerData).render(width);
    }
    return [];
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

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): boolean {
    if (this.bodyViewport.handleInput(data)) {
      return true;
    }
    if (matchesKey(data, "ctrl+d")) {
      if (this._isPaused()) this.onClose();
      else this.onDetach();
      return true;
    }
    if (matchesKey(data, "escape")) {
      if (this._canPause()) {
        void this._pause();
      } else {
        this.onClose();
      }
      return true;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.onClose();
      return true;
    }
    const blocked = this._isBlocked();
    if (matchesKey(data, "ctrl+f")) {
      if (blocked) return true;
      void this._submit("followUp");
      return true;
    }
    if (this.editor) {
      if (blocked) return true;
      this.editor.handleInput(data);
      return true;
    }
    if (matchesKey(data, "enter")) {
      if (blocked) return true;
      void this._submit("auto");
      return true;
    }
    if (matchesKey(data, "backspace")) {
      if (blocked) return true;
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return true;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      if (blocked) return true;
      this.inputBuffer += data;
      return true;
    }
    return false;
  }

  private _canPause(): boolean {
    if (!this.handle || this.localPaused || this._isBlocked()) return false;
    const stage = this._currentStage();
    if (stage?.status === "paused") return false;
    return this._isStreaming();
  }

  private async _pause(): Promise<void> {
    if (!this.handle) {
      this.statusMessage = "no live handle on this stage";
      this.requestRender?.();
      return;
    }
    this.localPaused = true;
    this.statusMessage = "pausing…";
    this.requestRender?.();
    try {
      await this.handle.pause();
      this.sdkBusy = false;
      this.statusMessage = "";
    } catch (err) {
      this.statusMessage = `pause failed: ${err instanceof Error ? err.message : String(err)}`;
      this.localPaused = false;
    } finally {
      this._syncAnimationTick();
      this.requestRender?.();
    }
  }

  private async _resume(message?: string): Promise<void> {
    if (!this.handle) {
      this.statusMessage = "no live handle on this stage";
      this.requestRender?.();
      return;
    }
    this.localPaused = true;
    this.sdkBusy = true;
    this.statusMessage = "resuming…";
    this._syncAnimationTick();
    this.requestRender?.();
    try {
      await this.handle.resume(message);
      this.localPaused = false;
      this.sdkBusy = false;
      this.statusMessage = "";
    } catch (err) {
      this.sdkBusy = false;
      this.statusMessage = `resume failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this._syncAnimationTick();
      this.requestRender?.();
    }
  }

  private async _submit(
    mode: "auto" | "followUp",
    submittedText?: string,
  ): Promise<void> {
    const text = (submittedText ?? this.inputBuffer).trim();
    if (!text) return;
    this.inputBuffer = "";
    this.editor?.setText("");
    if (!this.handle) {
      this.statusMessage = "no live handle on this stage";
      this.transcript.push({
        role: "system",
        kind: "system",
        text: "(no live handle — message dropped)",
      });
      this.requestRender?.();
      return;
    }
    const isPaused = this._isPaused();
    const isStreaming = this._isStreaming();
    const shouldAppendOptimisticUser = mode === "auto" && !isStreaming;
    if (shouldAppendOptimisticUser) {
      this.liveChat.appendUserText(text);
      this.bodyViewport.scrollToBottom();
      this.optimisticUserSignatures.add(userMessageSignature(text));
    }
    this.requestRender?.();
    try {
      if (isPaused) {
        await this._resume(text);
        return;
      }
      if (mode === "followUp") {
        await this._queueFollowUp(text);
        return;
      }
      if (isStreaming) {
        await this._queueSteer(text);
      } else {
        this.sdkBusy = true;
        this._syncAnimationTick();
        await this.handle.ensureAttached();
        await this.handle.prompt(text);
        this.sdkBusy = false;
        this._syncAnimationTick();
      }
    } catch (err) {
      this.sdkBusy = false;
      this.statusMessage = err instanceof Error ? err.message : String(err);
      this._syncAnimationTick();
      this.requestRender?.();
    }
  }

  private async _queueSteer(text: string): Promise<void> {
    const agentSession = this.handle?.agentSession;
    if (agentSession?.isStreaming) {
      await agentSession.prompt(text, { streamingBehavior: "steer" });
      return;
    }
    await this.handle?.steer(text);
  }

  private async _queueFollowUp(text: string): Promise<void> {
    const agentSession = this.handle?.agentSession;
    if (agentSession?.isStreaming) {
      await agentSession.prompt(text, { streamingBehavior: "followUp" });
      return;
    }
    await this.handle?.followUp(text);
  }

  invalidate(): void {
    // Stateless render reads directly from snapshot + handle.
  }

  dispose(): void {
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this._unsubscribeHandle?.();
    this._unsubscribeHandle = null;
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = undefined;
    }
    this.editor = undefined;
  }

  // ---- Test seams ----
  get _inputBuffer(): string {
    return this.inputBuffer;
  }
  get _transcript(): ReadonlyArray<TranscriptDebugEntry> {
    return this.transcript.flatMap((entry) => transcriptDebugEntries(entry));
  }
  get _statusMessage(): string {
    return this.statusMessage;
  }
  get _isLocalPaused(): boolean {
    return this.localPaused;
  }
  get _hasAnimationTick(): boolean {
    return this.animationTimer !== undefined;
  }
  get _bodyScrollFromBottom(): number {
    return this.bodyViewport.getScrollFromBottom();
  }
  get _lastBodyMaxScroll(): number {
    return this.bodyViewport.getMaxScroll();
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

function setEditorPlaceholder(
  editor: EditorComponent,
  placeholder: string | undefined,
): void {
  const candidate = editor as EditorComponent & {
    setPlaceholder?: (value: string | undefined) => void;
  };
  candidate.setPlaceholder?.(placeholder);
}

function cursorBlock(): string {
  return "\x1b[7m \x1b[0m";
}

function setEditorBorderColor(editor: EditorComponent, hex: string): void {
  const candidate = editor as EditorComponent & {
    borderColor?: (text: string) => string;
  };
  if (candidate.borderColor !== undefined) {
    candidate.borderColor = (text: string) => hexToAnsi(hex) + text + RESET;
  }
}

function setEditorFocused(editor: EditorComponent, focused: boolean): void {
  const candidate = editor as EditorComponent & Partial<Focusable>;
  if ("focused" in candidate) candidate.focused = focused;
}

function isSharedLiveChatEvent(type: string): boolean {
  return (
    type === "message_start" ||
    type === "message_update" ||
    type === "message_end" ||
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end"
  );
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
  return "kind" in entry && entry.role !== "notice";
}

function isMessageLike(message: unknown): message is { role?: unknown; content?: unknown } {
  return message !== null && typeof message === "object" && "role" in message;
}

function isUserMessageLike(
  message: unknown,
): message is { role: "user"; content?: unknown } {
  return isMessageLike(message) && message.role === "user";
}

function userMessageSignature(text: string): string {
  return text.trim();
}

function assistantToolCallEvent(event: AgentSessionEvent): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} | undefined {
  const assistantEvent = (event as {
    assistantMessageEvent?: {
      type?: unknown;
      contentIndex?: unknown;
      partial?: unknown;
      toolCall?: unknown;
    };
  }).assistantMessageEvent;
  const streamType = String(assistantEvent?.type ?? "");
  if (!streamType.startsWith("toolcall_")) return undefined;

  const explicit = toolCallPayload(assistantEvent?.toolCall);
  if (explicit) return explicit;

  const contentIndex = typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : undefined;
  if (contentIndex === undefined) return undefined;
  const partial = assistantEvent?.partial;
  if (!isMessageLike(partial) || partial.role !== "assistant") return undefined;
  const content = partial.content;
  if (!Array.isArray(content)) return undefined;
  return toolCallPayload(content[contentIndex]);
}

function toolCallPayload(value: unknown): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
  if (candidate.type !== "toolCall") return undefined;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return undefined;
  return {
    type: "tool_execution_start",
    toolCallId: candidate.id,
    toolName: candidate.name,
    args: candidate.arguments ?? {},
  };
}

function legacyToolStartEvent(event: AgentSessionEvent): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} {
  const payload = event as { toolCallId?: unknown; name?: unknown; input?: unknown; args?: unknown };
  const toolName = typeof payload.name === "string" ? payload.name : "tool";
  const toolCallId =
    typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: payload.input ?? payload.args ?? {},
  };
}

function legacyToolResultEvent(event: AgentSessionEvent): {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
} {
  const payload = event as {
    toolCallId?: unknown;
    name?: unknown;
    output?: unknown;
    isError?: unknown;
  };
  const toolName = typeof payload.name === "string" ? payload.name : "tool";
  const toolCallId =
    typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
  const output = payload.output;
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result:
      output !== null && typeof output === "object" && "content" in output
        ? output
        : { content: typeof output === "string" ? [{ type: "text", text: output }] : [] },
    isError: payload.isError === true,
  };
}

function legacyThinkingEvent(event: AgentSessionEvent): {
  type: "message_update";
  assistantMessageEvent: { type: "thinking_delta"; delta: string };
  message: { role: "assistant"; content: [] };
} {
  const delta = String(
    (event as { delta?: unknown }).delta ??
      (event as { text?: unknown }).text ??
      "",
  );
  return {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta },
    message: { role: "assistant", content: [] },
  };
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

function tailStreamingText(text: string): string {
  if (
    text.length <= STREAMING_TEXT_TAIL_CHARS &&
    text.split("\n").length <= STREAMING_TEXT_TAIL_LINES
  ) {
    return text;
  }
  const byChars = text.slice(-STREAMING_TEXT_TAIL_CHARS);
  const lines = byChars.split("\n");
  const tail =
    lines.length > STREAMING_TEXT_TAIL_LINES
      ? lines.slice(-STREAMING_TEXT_TAIL_LINES).join("\n")
      : byChars;
  return `[earlier streaming output hidden while attached]\n\n${tail.trimStart()}`;
}

function stageDurationText(stage: StageSnapshot | undefined): string {
  if (!stage) return "";
  const elapsed = elapsedStageMs(stage);
  return elapsed === undefined ? "" : formatDuration(elapsed);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function shortenId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function spinnerFrame(): string {
  const idx = Math.floor(Date.now() / 80) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx]!;
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
