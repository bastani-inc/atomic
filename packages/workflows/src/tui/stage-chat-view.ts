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
 *  - **Running** stage with a live stream: Enter calls `handle.steer(text)`
 *    (interrupt mid-turn). Ctrl+F always queues a follow-up via
 *    `handle.followUp(text)`.
 *  - **Ctrl+P** calls `handle.pause()`; while paused, Enter calls
 *    `handle.resume(text)`.
 *  - **Ctrl+D** detaches (back to graph); **Escape** closes the popup.
 *  - **Blocked** stage: keystrokes absorbed; BLOCKED banner names the
 *    upstream awaiter.
 *  - **Settled** stage (no handle, completed/failed): editor renders in a
 *    disabled visual state and the hint strip collapses to back/close.
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
  ScrollableComponentViewport,
  SessionManager,
  LiveChatEntriesController,
  chatEntriesFromAgentMessages,
  renderChatMessageEntry,
  type AgentSession,
  type AgentSessionEvent,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
  type ChatTranscriptRole,
} from "@bastani/atomic";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import type { StageNotice, StageSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { BOLD, RESET, hexBg, hexToAnsi, lerpColor } from "./color-utils.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

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
  /** Called when the user presses Ctrl+D (back to graph). */
  onDetach: () => void;
  /** Called when the user presses Escape (close the whole popup). */
  onClose: () => void;
  /** Request a host TUI repaint after SDK events mutate local chat state. */
  requestRender?: () => void;
  /** Live pi-tui host objects. When present, stage input uses pi's editor UI. */
  piTui?: TUI;
  piKeybindings?: unknown;
  /** Currently installed host editor factory, inherited from extension `ctx.ui.setEditorComponent()`. */
  piEditorFactory?: (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;
  /** Parent chat rendering settings and extension renderers inherited from the host UI. */
  getChatRenderSettings?: () => Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd" | "markdownTheme">> | undefined;
  /**
   * Optional accessor returning the current terminal row count. The chat
   * surface expands its body band to roughly `viewportRows` minus the fixed
   * header / loader / editor / footer / hint rows so the popup fills the
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
interface BaseEntry {
  readonly role: ChatTranscriptRole;
  readonly text: string;
}
interface UserEntry extends BaseEntry {
  readonly role: "user";
}
interface AssistantEntry extends BaseEntry {
  readonly role: "assistant";
}
interface ThinkingEntry extends BaseEntry {
  readonly role: "thinking";
}
interface SystemEntry extends BaseEntry {
  readonly role: "system";
}
interface ToolEntry extends BaseEntry {
  readonly role: "tool";
  readonly name: string;
  readonly toolCallId?: string;
  readonly args?: string;
  readonly output?: string;
  readonly state: "pending" | "success" | "error";
}
interface NoticeEntry extends BaseEntry {
  readonly role: "notice";
  readonly noticeId: string;
  readonly kind: StageNotice["kind"];
  readonly value: string;
  readonly from?: string;
  readonly meta?: string;
}
type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | SystemEntry
  | ToolEntry
  | NoticeEntry
  | ChatMessageEntry;
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
/** Footer: two dim lines. */
const FOOTER_ROWS = 2;
/** Hint strip: dashed rule + key bindings line. */
const HINTS_ROWS = 2;

/** Spinner glyphs — Braille spinner at 80ms per frame. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pi's Loader advances at 80ms; use the same cadence for embedded stage chats. */
const ANIMATION_FRAME_MS = 80;

const ITALIC = "\x1b[3m";
const FG_RESET = "\x1b[39m";
const WEIGHT_RESET = "\x1b[22m";
const ITALIC_RESET = "\x1b[23m";

// ---------------------------------------------------------------------------
// StageChatView
// ---------------------------------------------------------------------------

export class StageChatView implements Component {
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
  private getChatRenderSettings?: () => Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd" | "markdownTheme">> | undefined;

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
  /** Stable row pointers for the current streaming assistant message. */
  private streamingAssistantIndex: number | undefined;
  private streamingThinkingIndex: number | undefined;
  /** Stable tool-call rows keyed exactly like Pi's `pendingTools` map. */
  private toolEntryIndexes = new Map<string, number>();
  /** User rows optimistically appended by this embedded editor, de-duped on SDK echo. */
  private optimisticUserSignatures = new Set<string>();
  /** Chat-mode repaint driver for Pi-style loaders/spinners. */
  private animationTimer: ReturnType<typeof setInterval> | undefined;
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
    this.liveChat = new LiveChatEntriesController(this.transcript);
    this.editor = this._createEditor(opts.piTui, opts.piKeybindings, opts.piEditorFactory);

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
        if (changed) this.requestRender?.();
      });
    }
    this._syncAnimationTick();
  }

  private _createEditor(
    tui: TUI | undefined,
    keybindings: unknown,
    editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent) | undefined,
  ): EditorComponent | undefined {
    if (!tui || !keybindings) return undefined;
    const editorTheme = editorThemeFromGraphTheme(this.theme);
    const editor = this._createInheritedEditor(tui, editorTheme, keybindings, editorFactory) ??
      new CustomEditor(
        tui,
        editorTheme,
        keybindings as ConstructorParameters<typeof CustomEditor>[2],
        { paddingX: 1, autocompleteMaxVisible: 5 },
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
    editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent) | undefined,
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

  private _snapshotMessagesFromSessionFile(stage: StageSnapshot | undefined): void {
    if (this.transcript.length > 0) return;
    const sessionFile = this.handle?.sessionFile ?? stage?.sessionFile;
    if (sessionFile === undefined) return;

    let messages: readonly AgentSnapshotMessage[];
    try {
      messages = SessionManager.open(sessionFile).buildSessionContext().messages as readonly AgentSnapshotMessage[];
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
        const signature = userMessageSignature(extractMessageText(message.content));
        if (this.optimisticUserSignatures.delete(signature)) return false;
      }
    }
    if (isSharedLiveChatEvent(type)) {
      return this.liveChat.applyEvent(event);
    }
    switch (type) {
      case "agent_start":
        this.sdkBusy = true;
        this.toolEntryIndexes.clear();
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        return true;

      case "agent_end":
        this.sdkBusy = false;
        this.streamingAssistantIndex = undefined;
        this.streamingThinkingIndex = undefined;
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        return true;

      case "message_start":
        return this._handleMessageStart((event as { message?: unknown }).message);

      case "message_update":
        return this._handleMessageUpdate(event);

      case "message_end":
        return this._handleMessageEnd((event as { message?: unknown }).message);

      case "tool_execution_start": {
        const payload = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
        const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        const args = summariseArgs(payload.args);
        this._upsertToolEntry({ toolCallId, name, args, state: "pending" });
        return true;
      }

      case "tool_execution_update": {
        const payload = event as { toolCallId?: unknown; toolName?: unknown; partialResult?: unknown };
        const partialOutput = extractToolResultText(payload.partialResult);
        if (!partialOutput) return false;
        this._upsertToolEntry({
          toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
          name: typeof payload.toolName === "string" ? payload.toolName : "tool",
          output: partialOutput,
          state: "pending",
        });
        return true;
      }

      case "tool_execution_end": {
        const payload = event as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown };
        const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        const output = extractToolResultText(payload.result);
        this._upsertToolEntry({
          toolCallId,
          name: typeof payload.toolName === "string" ? payload.toolName : "tool",
          output,
          state: payload.isError === true ? "error" : "success",
        });
        if (toolCallId) this.toolEntryIndexes.delete(toolCallId);
        return true;
      }

      case "tool_call":
      case "tool_use": {
        const name = String((event as { name?: unknown }).name ?? "tool");
        const args = summariseArgs((event as { input?: unknown }).input);
        this._upsertToolEntry({ name, args, state: "pending" });
        return true;
      }

      case "tool_result": {
        const name = String((event as { name?: unknown }).name ?? "tool");
        const rawOutput = (event as { output?: unknown }).output;
        const output = typeof rawOutput === "string" ? rawOutput : extractMessageText(rawOutput);
        this._upsertToolEntry({
          name,
          output,
          state: Boolean((event as { isError?: unknown }).isError) ? "error" : "success",
        });
        return true;
      }

      case "thinking_delta":
      case "thinking": {
        const delta = String(
          (event as { delta?: unknown }).delta ?? (event as { text?: unknown }).text ?? "",
        );
        if (!delta) return false;
        this._appendTextDelta("thinking", delta);
        return true;
      }

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

  private _handleMessageStart(message: unknown): boolean {
    if (!isMessageLike(message)) return false;
    if (message.role === "assistant") {
      this.streamingAssistantIndex = undefined;
      this.streamingThinkingIndex = undefined;
      return this._updateAssistantFromMessage(message);
    }

    const entry = transcriptEntryFromSnapshotMessage(message as AgentSnapshotMessage);
    if (!entry) return false;
    if (entry.role === "user") {
      const signature = userMessageSignature(entry.text);
      if (this.optimisticUserSignatures.delete(signature)) return false;
    }
    this.transcript.push(entry);
    return true;
  }

  private _handleMessageUpdate(event: AgentSessionEvent): boolean {
    const message = (event as { message?: unknown }).message;
    const hasAssistantSnapshot = isMessageLike(message) && message.role === "assistant";
    const snapshotHasPayload = hasAssistantSnapshot && assistantContentHasRenderablePayload(message.content);
    let changed = false;
    if (hasAssistantSnapshot) {
      changed = this._updateAssistantFromMessage(message) || changed;
    }

    const assistantEvent = (event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } }).assistantMessageEvent;
    const streamType = String(assistantEvent?.type ?? "");
    const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : "";
    // Prefer Pi's full assistant message snapshot when it contains visible
    // payload; use deltas only for delta-only SDK shims/events.
    if (!changed && !snapshotHasPayload && streamType === "text_delta" && delta) {
      this._appendTextDelta("assistant", delta);
      changed = true;
    } else if (!changed && !snapshotHasPayload && streamType === "thinking_delta" && delta) {
      this._appendTextDelta("thinking", delta);
      changed = true;
    }

    return changed;
  }

  private _handleMessageEnd(message: unknown): boolean {
    let changed = false;
    if (isMessageLike(message) && message.role === "assistant") {
      changed = this._updateAssistantFromMessage(message) || changed;
      for (const [toolCallId, index] of this.toolEntryIndexes.entries()) {
        const entry = this.transcript[index];
        if (isLocalToolEntry(entry) && entry.state === "pending") {
          this.transcript[index] = { ...entry, text: entry.text };
        }
        this.toolEntryIndexes.set(toolCallId, index);
      }
    }
    this.streamingAssistantIndex = undefined;
    this.streamingThinkingIndex = undefined;
    return changed || isMessageLike(message);
  }

  private _updateAssistantFromMessage(message: { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown }): boolean {
    const projection = projectAssistantContent(message.content);
    let changed = false;
    if (projection.thinking) {
      changed = this._upsertStreamingText("thinking", projection.thinking) || changed;
    }
    if (projection.text) {
      changed = this._upsertStreamingText("assistant", projection.text) || changed;
    }
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
    if (stopReason === "aborted" || stopReason === "error") {
      const errorText = typeof message.errorMessage === "string" && message.errorMessage
        ? message.errorMessage
        : stopReason === "aborted"
        ? "Operation aborted"
        : "Unknown error";
      changed = this._failPendingToolEntries(errorText) || changed;
      if (!projection.toolCalls.length) {
        changed = this._upsertStreamingText("system", stopReason === "error" ? `Error: ${errorText}` : errorText) || changed;
      }
    }
    for (const toolCall of projection.toolCalls) {
      changed = this._upsertToolEntry(toolCall) || changed;
    }
    return changed;
  }

  private _upsertStreamingText(
    role: "assistant" | "thinking" | "system",
    text: string,
  ): boolean {
    if (!text) return false;
    if (role === "system") {
      this._upsertTextLastByRole("system", text);
      return true;
    }
    const index = role === "assistant" ? this.streamingAssistantIndex : this.streamingThinkingIndex;
    if (index !== undefined && isLocalTextRoleEntry(this.transcript[index], role)) {
      if (this.transcript[index]?.text === text) return false;
      this.transcript[index] = { role, text } as TranscriptEntry;
      return true;
    }
    this.transcript.push({ role, text } as TranscriptEntry);
    const nextIndex = this.transcript.length - 1;
    if (role === "assistant") this.streamingAssistantIndex = nextIndex;
    else this.streamingThinkingIndex = nextIndex;
    return true;
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

  private _upsertTextLastByRole(
    role: "user" | "assistant" | "thinking" | "system",
    text: string,
  ): void {
    const last = this.transcript[this.transcript.length - 1];
    if (isLocalTextRoleEntry(last, role)) {
      this.transcript[this.transcript.length - 1] = { role, text } as TranscriptEntry;
    } else {
      this.transcript.push({ role, text } as TranscriptEntry);
    }
  }

  private _appendTextDelta(
    role: "assistant" | "thinking",
    delta: string,
  ): void {
    const index = role === "assistant" ? this.streamingAssistantIndex : this.streamingThinkingIndex;
    if (index !== undefined && isLocalTextRoleEntry(this.transcript[index], role)) {
      const current = this.transcript[index];
      this.transcript[index] = { role, text: current.text + delta } as TranscriptEntry;
      return;
    }
    this.transcript.push({ role, text: delta } as TranscriptEntry);
    const nextIndex = this.transcript.length - 1;
    if (role === "assistant") this.streamingAssistantIndex = nextIndex;
    else this.streamingThinkingIndex = nextIndex;
  }

  private _failPendingToolEntries(errorText: string): boolean {
    let changed = false;
    for (const [toolCallId, index] of this.toolEntryIndexes.entries()) {
      const entry = this.transcript[index];
      if (!isLocalToolEntry(entry) || entry.state !== "pending") continue;
      changed = this._upsertToolEntry({
        toolCallId,
        name: entry.name,
        output: errorText,
        state: "error",
      }) || changed;
    }
    this.toolEntryIndexes.clear();
    return changed;
  }

  private _upsertToolEntry(update: {
    toolCallId?: string;
    name: string;
    args?: string;
    output?: string;
    state: "pending" | "success" | "error";
  }): boolean {
    const mappedIndex = update.toolCallId ? this.toolEntryIndexes.get(update.toolCallId) : undefined;
    const index = mappedIndex ?? findToolEntryIndex(this.transcript, update.toolCallId, update.name);
    const existing = index !== undefined && index >= 0 ? this.transcript[index] : undefined;
    const previous = isLocalToolEntry(existing) ? existing : undefined;
    const output = update.output || previous?.output;
    const name = previous?.name ?? update.name;
    const args = update.args ?? previous?.args;
    const summary = output ? truncateToWidth(output.replace(/\s+/g, " "), 80) : "";
    const next: ToolEntry = {
      role: "tool",
      name,
      toolCallId: previous?.toolCallId ?? update.toolCallId,
      args,
      output,
      state: update.state,
      text: summary
        ? `← ${name} ${summary}`
        : args
        ? `→ ${name} ${args}`
        : `→ ${name}`,
    };
    if (previous && shallowToolEntryEqual(previous, next)) return false;
    if (index !== undefined && index >= 0) {
      this.transcript[index] = next;
      if (next.toolCallId) this.toolEntryIndexes.set(next.toolCallId, index);
    } else {
      this.transcript.push(next);
      if (next.toolCallId) this.toolEntryIndexes.set(next.toolCallId, this.transcript.length - 1);
    }
    return true;
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
    return this.liveChat.pendingToolIds().length > 0 ||
      this.transcript.some((entry) => isLocalToolEntry(entry) && entry.state === "pending");
  }

  private _syncAnimationTick(): void {
    const shouldAnimate = this._isStreaming() || (this.sdkBusy && this._hasPendingToolEntries());
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

  private _isBlocked(): boolean {
    return this._currentStage()?.status === "blocked";
  }

  private _isSettled(stage: StageSnapshot | undefined): boolean {
    if (!stage) return !this.handle;
    return stage.status === "completed" || stage.status === "failed";
  }

  // -------------------------------------------------------------------------
  // Top-level render — composes header / body / loader / editor / footer / hints
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(40, width);
    const stage = this._currentStage();
    const blocked = this._isBlocked();
    const settled = this._isSettled(stage);
    const streaming = this._isStreaming() && !blocked && !settled;
    const paused = this.localPaused || stage?.status === "paused";

    const headerLines = this._renderHeader(w, stage);
    const sepLines = [this._sepRule(w)];
    const loaderLines = streaming ? this._renderLoader(w, stage) : [];
    // When the loader sits above the editor, the loader's bottom rule and
    // the editor's top rule collapse into a single shared divider — matches
    // the mockup's `pi-loader` + `pi-editor` stack and saves one row.
    const editorLines = this._renderEditor(w, {
      paused,
      streaming,
      settled,
      blocked,
      omitTopRule: loaderLines.length > 0,
    });
    const hintsLines = this._renderHints(w, { paused, streaming, settled });

    const fixed =
      HEADER_ROWS +
      SEP_ROWS +
      loaderLines.length +
      editorLines.length +
      FOOTER_ROWS +
      HINTS_ROWS;
    const totalRows = this._viewLineCount();
    const bodyBudget = Math.max(1, totalRows - fixed);
    this.bodyViewport.setVisibleRows(bodyBudget);
    if (blocked) this.bodyViewport.scrollToBottom();
    const bodyLines = blocked
      ? this._renderBlockedBody(w, bodyBudget, stage)
      : this._renderBody(w, bodyBudget, stage, { paused, streaming, settled });
    const footerLines = this._renderFooter(w, stage, { paused, streaming, settled });

    const lines = [
      ...headerLines,
      ...sepLines,
      ...bodyLines,
      ...loaderLines,
      ...editorLines,
      ...footerLines,
      ...hintsLines,
    ];
    while (lines.length < totalRows) lines.push(this._blank(w));
    if (lines.length > totalRows) lines.length = totalRows;
    return lines;
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  private _renderHeader(width: number, stage: StageSnapshot | undefined): string[] {
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

    const leftW = visibleWidth(this.workflowName) + visibleWidth(stageName) + visibleWidth("  STAGE   /  ") + 1;
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
      running: { fg: t.accent, bg: blendBg(t.bg, t.accent, 0.18), label: "running" },
      paused: { fg: t.warning, bg: blendBg(t.bg, t.warning, 0.18), label: "paused" },
      blocked: { fg: t.warning, bg: blendBg(t.bg, t.warning, 0.18), label: "blocked" },
      completed: { fg: t.success, bg: blendBg(t.bg, t.success, 0.18), label: "completed" },
      failed: { fg: t.error, bg: blendBg(t.bg, t.error, 0.18), label: "failed" },
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

  private _renderBlockedBody(width: number, budget: number, stage: StageSnapshot | undefined): string[] {
    const t = this.theme;
    const upstream = stage?.blockedByStageId ?? "upstream stage";
    const lines: string[] = [];
    // Yellow banner — uses the same chrome vocabulary as paused/completed.
    lines.push(...this._bannerLines(width, "warning", "↑", "BLOCKED", `waiting on ${upstream}`));
    lines.push(this._blank(width));
    lines.push(
      ...new Text(
        paint("This stage is waiting for the upstream stage to resume.", t.textMuted),
        2,
        0,
      ).render(width),
    );
    lines.push(
      ...new Text(
        paint("Press ", t.textMuted) +
          paint("Ctrl+D", t.accent, { bold: true }) +
          paint(" to return to the graph.", t.textMuted),
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
    stage: StageSnapshot | undefined,
    flags: { paused: boolean; streaming: boolean; settled: boolean },
  ): string[] {
    // Empty + not paused + not settled + not streaming → welcome panel.
    const transcriptEmpty = this.transcript.length === 0;
    if (transcriptEmpty && !flags.paused && !flags.settled && !flags.streaming) {
      return this._fitToBudget(this._renderWelcome(width, stage), budget, width);
    }

    const components: Component[] = [];
    if (flags.paused) {
      components.push(
        this._banner(
          "warning",
          "❚❚",
          "PAUSED",
          "stopped between turns · type to resume, or Ctrl+P to release without input",
        ),
      );
      components.push(new Spacer(1));
    } else if (flags.settled && stage?.status === "completed") {
      components.push(this._banner("success", "✓", "COMPLETED", this._completedMeta(stage)));
      components.push(new Spacer(1));
    } else if (flags.settled && stage?.status === "failed") {
      components.push(
        this._banner(
          "error",
          "✗",
          "FAILED",
          stage?.error?.replace(/\s+/g, " ") ?? "stage exited with an error",
        ),
      );
      components.push(new Spacer(1));
    }

    // Base chat body: delegate transcript composition to the Pi-style
    // transcript component so the attached stage chat uses the same message
    // spacing and coding-agent message widgets as the main interactive chat.
    if (this.transcript.length > 0) {
      components.push(
        new ChatTranscriptComponent(this.transcript, (entry) => this._renderEntry(entry)),
      );
    }

    // Stream a static status message (e.g. "pausing…") as a dim trailing row.
    if (this.statusMessage) {
      components.push(new Spacer(1));
      components.push(new Text(paint(this.statusMessage, this.theme.dim), 2, 0));
    }

    this.bodyViewport.setComponents(components);
    return this.bodyViewport.render(width);
  }

  private _fitToBudget(lines: string[], budget: number, width: number): string[] {
    if (lines.length >= budget) return lines.slice(lines.length - budget);
    const out = lines.slice();
    while (out.length < budget) out.push(this._blank(width));
    return out;
  }

  // -------------------------------------------------------------------------
  // Welcome panel — first attach, no transcript yet
  // -------------------------------------------------------------------------

  private _renderWelcome(width: number, stage: StageSnapshot | undefined): string[] {
    const t = this.theme;
    const sessionId = this.handle?.sessionId ?? stage?.sessionId;
    const sessionFile = this.handle?.sessionFile ?? stage?.sessionFile;
    const status = stage?.status ?? "pending";

    const out: string[] = [];
    out.push(...new Spacer(1).render(width));
    out.push(centred(paint("▎", t.mauve, { bold: true }), width));
    out.push(
      centred(
        paint("Attached to ", t.text) +
          paint(this.workflowName, t.textMuted) +
          paint(" / ", t.dim) +
          paint(stage?.name ?? "stage", t.text, { bold: true }),
        width,
      ),
    );
    out.push(...new Spacer(1).render(width));
    const sub =
      "This stage is idle. Press ↵ to send the first prompt — the SDK session " +
      "will be created on submit. The workflow body keeps running in the " +
      "background; closing this overlay does not kill the run.";
    out.push(...new Text(paint(sub, t.textMuted), 4, 0).render(width));
    out.push(...new Spacer(1).render(width));

    const grid: Array<[string, string]> = [
      ["session", sessionId ? shortenId(sessionId) : "(not yet realised)"],
      ["status", status],
    ];
    if (sessionFile) grid.push(["session file", shortenFile(sessionFile)]);
    for (const [k, v] of grid) {
      const row = paint(k.padEnd(13), t.dim) + paint(v, t.text);
      out.push(...new Text(row, 8, 0).render(width));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Transcript entry → pi/coding-agent Component. Stage chat deliberately uses
  // the same exported message/tool components as the main interactive chat
  // instead of maintaining parallel workflow-specific bubbles.
  // -------------------------------------------------------------------------

  private _renderEntry(entry: TranscriptEntry): Component {
    if (isChatMessageEntry(entry)) {
      return renderChatMessageEntry(entry, this._chatMessageRenderOptions());
    }
    switch (entry.role) {
      case "user":
        return renderChatMessageEntry(
          { role: "user", kind: "user", text: entry.text },
          this._chatMessageRenderOptions(),
        );
      case "assistant":
        return renderChatMessageEntry(
          { role: "assistant", kind: "assistant", message: assistantMessageForText(entry.text) },
          this._chatMessageRenderOptions(),
        );
      case "thinking":
        return renderChatMessageEntry(
          { role: "assistant", kind: "assistant", message: assistantMessageForThinking(entry.text) },
          this._chatMessageRenderOptions(),
        );
      case "tool":
        return renderChatMessageEntry(this._toolEntryToChatMessage(entry), this._chatMessageRenderOptions());
      case "notice":
        return this._noticeRow(entry);
      case "system":
        return renderChatMessageEntry(
          { role: "system", kind: "system", text: entry.text },
          this._chatMessageRenderOptions(),
        );
    }
  }

  private _toolEntryToChatMessage(entry: ToolEntry): ChatMessageEntry {
    const toolCallId = entry.toolCallId ?? `workflow-${entry.name}`;
    return {
      role: "tool",
      kind: "tool",
      toolName: entry.name,
      toolCallId,
      args: toolArgsForRender(entry),
      isPartial: entry.state === "pending",
      result:
        entry.state !== "pending" || entry.output
          ? {
              role: "toolResult",
              toolCallId,
              toolName: entry.name,
              content: entry.output ? [{ type: "text", text: entry.output }] : [],
              isError: entry.state === "error",
              timestamp: Date.now(),
            }
          : undefined,
    };
  }

  private _chatMessageRenderOptions(): ChatMessageRenderOptions {
    const inherited = this.getChatRenderSettings?.();
    return {
      ...inherited,
      ui: this._toolTui(),
      cwd: process.cwd(),
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
    const fg = kind === "warning" ? t.warning : kind === "success" ? t.success : t.error;
    const bg = blendBg(t.bg, fg, 0.10);
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
  // Loader — top rule + spinner row + bottom rule
  // -------------------------------------------------------------------------

  private _renderLoader(width: number, stage: StageSnapshot | undefined): string[] {
    const t = this.theme;
    const rule = hexToAnsi(t.border) + "─".repeat(width) + RESET;
    const dur = stageDurationText(stage);
    const msg = `Working${dur ? "  · " + dur : ""}`;
    const escapeHint = paint("Esc", t.text, { bold: true }) + " " + paint("interrupt", t.dim);
    const left = " " + paint(spinnerFrame(), t.accent, { bold: true }) + "  " + paint(msg, t.textMuted) + " ";
    const leftW = visibleWidth(spinnerFrame()) + 4 + visibleWidth(msg);
    const rightW = visibleWidth("Esc interrupt");
    const gap = Math.max(1, width - leftW - rightW - 2);
    const body = left + " ".repeat(gap) + escapeHint + " ";
    // No closing rule — the editor's top rule (or the editor's body when
    // `omitTopRule: true`) sits directly underneath and provides the divider.
    return [rule, body];
  }

  // -------------------------------------------------------------------------
  // Editor — top rule + ` ❯ … ` + bottom rule
  // -------------------------------------------------------------------------

  private _renderEditor(
    width: number,
    flags: {
      paused: boolean;
      streaming: boolean;
      settled: boolean;
      blocked: boolean;
      /**
       * When `true`, drop the editor's top rule — the loader directly above
       * already paints a horizontal rule and we don't want a doubled border.
       */
      omitTopRule: boolean;
    },
  ): string[] {
    const t = this.theme;
    // Disabled (settled or blocked) uses surface1 rules + dim placeholder.
    const disabled = flags.settled || flags.blocked || !this.handle;
    if (!disabled && this.editor) {
      return this.editor.render(width);
    }
    const ruleHex = disabled ? t.borderDim : t.border;
    const rule = hexToAnsi(ruleHex) + "─".repeat(width) + RESET;

    const glyphHex = disabled ? t.dim : t.accent;
    const placeholder = flags.blocked
      ? "blocked · upstream stage owns the prompt"
      : flags.settled || !this.handle
      ? "read-only · stage has no live handle"
      : flags.paused
      ? "type to resume, or Ctrl+P to release without input…"
      : flags.streaming
      ? "type to steer the current turn… (queues with ↵)"
      : "type a message…";

    const value = this.inputBuffer
      ? paint(truncateToWidth(this.inputBuffer, Math.max(8, width - 6)), t.text) + paint("▌", t.text)
      : paint(placeholder, t.dim, { italic: true });

    const tag = flags.streaming
      ? paint("streaming", t.accent, { bold: true })
      : flags.paused
      ? paint("paused", t.warning, { bold: true })
      : flags.settled
      ? paint("settled", t.success, { bold: true })
      : paint("idle", t.dim);
    const tagWidth = visibleWidth(stripAnsi(tag));
    const left = " " + paint("❯", glyphHex, { bold: true }) + "  " + value;
    const valueWidth = visibleWidth(this.inputBuffer || placeholder);
    const leftWidth = 1 + 1 + 2 + valueWidth + (this.inputBuffer ? 1 : 0);
    const gap = Math.max(1, width - leftWidth - tagWidth - 2);
    const body = left + " ".repeat(gap) + tag + " ";
    return flags.omitTopRule ? [body, rule] : [rule, body, rule];
  }

  // -------------------------------------------------------------------------
  // Footer — two dim lines mirroring Pi's FooterComponent
  // -------------------------------------------------------------------------

  private _renderFooter(
    width: number,
    stage: StageSnapshot | undefined,
    flags: { paused: boolean; streaming: boolean; settled: boolean },
  ): string[] {
    const t = this.theme;
    const sessionId = this.handle?.sessionId ?? stage?.sessionId;
    const messages = this.handle?.messages.length ?? this.transcript.length;
    const dur = stageDurationText(stage) ?? "";

    // Top line — left: workflow / stage tag; right: session id
    const lTop = paint(`pi-workflows/${this.workflowName}/${stage?.name ?? "stage"}`, t.dim);
    const rTop = sessionId
      ? paint("session ", t.dim) + paint(shortenId(sessionId), t.textMuted)
      : paint("session not yet realised", t.dim);
    const top = layoutRow(width, " ", " " + lTop, rTop + " ", t);

    // Bottom line — left: messages / duration; right: caption
    const history = this.bodyViewport.getMaxScroll() > 0
      ? this.bodyViewport.getScrollFromBottom() > 0
        ? ` · history ↑${this.bodyViewport.getScrollFromBottom()}`
        : " · history bottom"
      : "";
    const lBot =
      paint(`◇ ${messages} messages`, t.dim) +
      (dur ? "  " + paint(`· ${dur}`, t.dim) : "") +
      paint(history, t.dim);
    const rBot = flags.streaming
      ? paint("streaming · live", t.accent)
      : flags.paused
      ? paint("paused · ready to resume", t.warning)
      : flags.settled && stage?.status === "completed"
      ? paint("completed · session persisted", t.success)
      : flags.settled && stage?.status === "failed"
      ? paint("failed · see error", t.error)
      : paint(this.statusMessage || "idle · awaiting input", t.dim);
    const bot = layoutRow(width, " ", " " + lBot, rBot + " ", t);
    return [top, bot];
  }

  // -------------------------------------------------------------------------
  // Hints — dashed rule + key bindings
  // -------------------------------------------------------------------------

  private _renderHints(
    width: number,
    flags: { paused: boolean; streaming: boolean; settled: boolean },
  ): string[] {
    const t = this.theme;
    const dash = hexToAnsi(t.borderDim) + "╌".repeat(width) + RESET;
    const hints = this._hintSet(flags);
    const sep = paint(" · ", t.dim);
    const rendered = hints
      .map(({ key, label, emphasis }) =>
        paint(key, t.text, { bold: true }) +
        " " +
        paint(label, emphasis ? t.textMuted : t.dim, emphasis ? { bold: true } : {}),
      )
      .join(sep);
    const tagPlain = `pi-workflows/${this.workflowName}`;
    const renderedW = visibleWidth(stripAnsi(rendered));
    const tagW = visibleWidth(tagPlain);
    // Right-side tag is "nice to have". When the hint line + tag overflows
    // the chrome, drop the tag — the hints are the load-bearing affordance.
    if (renderedW + tagW + 3 > width) {
      const gap = Math.max(1, width - renderedW - 1);
      return [dash, " " + rendered + " ".repeat(gap)];
    }
    const tag = paint(tagPlain, t.dim);
    const gap = Math.max(1, width - renderedW - tagW - 2);
    return [dash, " " + rendered + " ".repeat(gap) + tag + " "];
  }

  private _hintSet(flags: {
    paused: boolean;
    streaming: boolean;
    settled: boolean;
  }): Array<{ key: string; label: string; emphasis?: boolean }> {
    const historyHint = { key: "PgUp/PgDn", label: "history" };
    if (flags.settled) {
      return [
        historyHint,
        { key: "Ctrl+D", label: "back to graph", emphasis: true },
        { key: "Esc", label: "close" },
      ];
    }
    if (flags.paused) {
      return [
        { key: "↵", label: "resume with message", emphasis: true },
        { key: "Ctrl+P", label: "resume empty" },
        historyHint,
        { key: "Ctrl+D", label: "back" },
        { key: "Esc", label: "close" },
      ];
    }
    if (flags.streaming) {
      return [
        { key: "↵", label: "steer", emphasis: true },
        { key: "Ctrl+F", label: "follow-up", emphasis: true },
        { key: "Ctrl+P", label: "pause" },
        historyHint,
        { key: "Ctrl+D", label: "back" },
        { key: "Esc", label: "interrupt" },
      ];
    }
    return [
      { key: "↵", label: "send", emphasis: true },
      { key: "Ctrl+F", label: "follow-up" },
      { key: "Ctrl+P", label: "pause" },
      historyHint,
      { key: "Ctrl+D", label: "back" },
      { key: "Esc", label: "close" },
    ];
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private _completedMeta(stage: StageSnapshot | undefined): string {
    const dur = stageDurationText(stage);
    const parts: string[] = ["stage settled"];
    if (dur) parts.push(dur);
    if (stage?.sessionFile) parts.push(`session ${shortenFile(stage.sessionFile)}`);
    return parts.join(" · ");
  }

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
    if (data === "\x04") {
      this.onDetach();
      return true;
    }
    if (data === "\x1b") {
      if (this._isStreaming() && !this._isBlocked()) {
        void this._pause();
      } else {
        this.onClose();
      }
      return true;
    }
    const blocked = this._isBlocked();
    if (data === "\x10") {
      if (blocked) return true;
      void this._pause();
      return true;
    }
    if (data === "\x06") {
      if (blocked) return true;
      void this._submit("followUp");
      return true;
    }
    if (this.editor) {
      if (blocked) return true;
      this.editor.handleInput(data);
      return true;
    }
    if (data === "\r" || data === "\n") {
      if (blocked) return true;
      void this._submit("auto");
      return true;
    }
    if (data === "\x7f" || data === "\b") {
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
      this.statusMessage = "paused";
    } catch (err) {
      this.statusMessage = `pause failed: ${err instanceof Error ? err.message : String(err)}`;
      this.localPaused = false;
    } finally {
      this._syncAnimationTick();
      this.requestRender?.();
    }
  }

  private async _submit(mode: "auto" | "followUp", submittedText?: string): Promise<void> {
    const text = (submittedText ?? this.inputBuffer).trim();
    if (!text) return;
    this.inputBuffer = "";
    this.editor?.setText("");
    if (!this.handle) {
      this.statusMessage = "no live handle on this stage";
      this.transcript.push({
        role: "system",
        text: "(no live handle — message dropped)",
      });
      this.requestRender?.();
      return;
    }
    this.liveChat.appendUserText(text);
    this.bodyViewport.scrollToBottom();
    this.optimisticUserSignatures.add(userMessageSignature(text));
    this.requestRender?.();
    try {
      if (this.localPaused) {
        this.sdkBusy = true;
        this._syncAnimationTick();
        await this.handle.resume(text);
        this.localPaused = false;
        this.statusMessage = "resumed";
        this.requestRender?.();
        return;
      }
      if (mode === "followUp") {
        await this.handle.followUp(text);
        return;
      }
      if (this.handle.isStreaming) {
        await this.handle.steer(text);
      } else {
        this.sdkBusy = true;
        this._syncAnimationTick();
        await this.handle.ensureAttached();
        await this.handle.prompt(text);
      }
    } catch (err) {
      this.sdkBusy = false;
      this.statusMessage = err instanceof Error ? err.message : String(err);
      this._syncAnimationTick();
      this.requestRender?.();
    }
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
    this.editor = undefined;
  }

  // ---- Test seams ----
  get _inputBuffer(): string {
    return this.inputBuffer;
  }
  get _transcript(): ReadonlyArray<
    TranscriptEntry & {
      readonly text: string;
      readonly toolCallId: string;
      readonly state: string;
      readonly output: string;
    }
  > {
    return this.transcript.flatMap((entry) => transcriptDebugEntries(entry)) as ReadonlyArray<
      TranscriptEntry & {
        readonly text: string;
        readonly toolCallId: string;
        readonly state: string;
        readonly output: string;
      }
    >;
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

type AssistantComponentMessage = Extract<ChatMessageEntry, { kind: "assistant" }>["message"];

function transcriptDebugEntries(entry: TranscriptEntry): Array<TranscriptEntry & {
  readonly text: string;
  readonly toolCallId: string;
  readonly state: string;
  readonly output: string;
}> {
  if (isChatMessageEntry(entry) && entry.kind === "assistant") {
    const entries: Array<TranscriptEntry & { text: string; toolCallId: string; state: string; output: string }> = [];
    const thinking = extractThinkingText(entry.message.content);
    const text = extractMessageText(entry.message.content);
    if (thinking) entries.push({ role: "thinking", text: thinking, toolCallId: "", state: "", output: "" } as TranscriptEntry & { text: string; toolCallId: string; state: string; output: string });
    if (text || entries.length === 0) entries.push({ ...entry, text, toolCallId: "", state: "", output: "" });
    return entries;
  }
  return [{
    ...entry,
    text: transcriptDebugText(entry),
    toolCallId: transcriptDebugToolCallId(entry),
    state: transcriptDebugToolState(entry),
    output: transcriptDebugToolOutput(entry),
  } as TranscriptEntry & { text: string; toolCallId: string; state: string; output: string }];
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
  if (isChatMessageEntry(entry) && entry.kind === "tool") return entry.toolCallId;
  if ("toolCallId" in entry && typeof entry.toolCallId === "string") return entry.toolCallId;
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
  if (isChatMessageEntry(entry) && entry.kind === "tool") return entry.result ? extractToolResultText(entry.result) : "";
  if ("output" in entry && typeof entry.output === "string") return entry.output;
  return "";
}

function isSharedLiveChatEvent(type: string): boolean {
  return type === "message_start" ||
    type === "message_update" ||
    type === "message_end" ||
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end";
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
  return "kind" in entry && entry.role !== "notice";
}

function isLocalToolEntry(entry: TranscriptEntry | undefined): entry is ToolEntry {
  return entry?.role === "tool" && !("kind" in entry);
}

function isLocalTextRoleEntry<T extends "user" | "assistant" | "thinking" | "system">(
  entry: TranscriptEntry | undefined,
  role: T,
): entry is Extract<TranscriptEntry, { role: T; text: string }> {
  return entry?.role === role && !("kind" in entry) && "text" in entry;
}

function assistantMessageForText(text: string): AssistantComponentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as AssistantComponentMessage;
}

function assistantMessageForThinking(text: string): AssistantComponentMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: text }],
    stopReason: "stop",
  } as AssistantComponentMessage;
}

function toolArgsForRender(entry: ToolEntry): Record<string, unknown> {
  if (!entry.args) return {};
  if (entry.name === "bash") {
    return { command: entry.args.replace(/^command=/, "") };
  }
  return { input: entry.args };
}

function isMessageLike(message: unknown): message is { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown } {
  return message !== null && typeof message === "object" && "role" in message;
}

function isUserMessageLike(message: unknown): message is { role: "user"; content?: unknown } {
  return isMessageLike(message) && message.role === "user";
}

function userMessageSignature(text: string): string {
  return text.trim();
}

interface AssistantProjection {
  text: string;
  thinking: string;
  toolCalls: Array<{ toolCallId?: string; name: string; args?: string; state: "pending" }>;
}

function assistantContentHasRenderablePayload(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (typeof item === "string") return item.length > 0;
    if (item == null || typeof item !== "object") return false;
    const obj = item as { type?: unknown; text?: unknown; thinking?: unknown };
    return (obj.type === "text" && typeof obj.text === "string" && obj.text.length > 0) ||
      (obj.type === "thinking" && typeof obj.thinking === "string" && obj.thinking.length > 0) ||
      obj.type === "toolCall";
  });
}

function projectAssistantContent(content: unknown): AssistantProjection {
  const projection: AssistantProjection = { text: "", thinking: "", toolCalls: [] };
  if (!Array.isArray(content)) {
    projection.text = typeof content === "string" ? content : "";
    return projection;
  }
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === "string") {
      textParts.push(item);
      continue;
    }
    if (typeof item !== "object") continue;
    const obj = item as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      args?: unknown;
    };
    if (obj.type === "text" && typeof obj.text === "string") {
      textParts.push(obj.text);
      continue;
    }
    if (obj.type === "thinking" && typeof obj.thinking === "string") {
      thinkingParts.push(obj.thinking);
      continue;
    }
    if (obj.type === "toolCall") {
      const name = typeof obj.name === "string" ? obj.name : "tool";
      const toolCallId = typeof obj.id === "string" ? obj.id : undefined;
      const args = summariseArgs(obj.arguments ?? obj.args);
      projection.toolCalls.push({ toolCallId, name, args, state: "pending" });
    }
  }
  projection.text = textParts.join("");
  projection.thinking = thinkingParts.join("\n\n");
  return projection;
}

function shallowToolEntryEqual(a: ToolEntry, b: ToolEntry): boolean {
  return a.role === b.role &&
    a.text === b.text &&
    a.name === b.name &&
    a.toolCallId === b.toolCallId &&
    a.args === b.args &&
    a.output === b.output &&
    a.state === b.state;
}

function transcriptEntryFromSnapshotMessage(
  message: AgentSnapshotMessage,
): TranscriptEntry | undefined {
  switch (message.role) {
    case "user": {
      const text = extractMessageText(message.content);
      return text ? { role: "user", text } : undefined;
    }
    case "assistant": {
      const text = extractMessageText(message.content);
      return text ? { role: "assistant", text } : undefined;
    }
    case "toolResult": {
      const output = extractMessageText(message.content);
      const summary = output ? truncateToWidth(output.replace(/\s+/g, " "), 80) : "";
      return {
        role: "tool",
        name: message.toolName,
        output,
        state: message.isError ? "error" : "success",
        text: summary ? `← ${message.toolName} ${summary}` : `← ${message.toolName}`,
      };
    }
    case "bashExecution": {
      const state =
        message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0)
          ? "error"
          : "success";
      const summary = message.output ? truncateToWidth(message.output.replace(/\s+/g, " "), 80) : "";
      return {
        role: "tool",
        name: "bash",
        args: truncateToWidth(message.command.replace(/\s+/g, " "), 60),
        output: message.output,
        state,
        text: summary ? `← bash ${summary}` : `→ bash ${message.command}`,
      };
    }
    case "custom": {
      if (!message.display) return undefined;
      const text = extractMessageText(message.content);
      return text ? { role: "system", text } : undefined;
    }
    case "branchSummary": {
      const text = `Branch summary: ${message.summary}`;
      return { role: "system", text };
    }
    case "compactionSummary": {
      const text = `Compaction summary: ${message.summary}`;
      return { role: "system", text };
    }
    default:
      // The SDK message union is extensible. Snapshot unknown roles must be
      // skipped here instead of being cast into `TranscriptEntry`; `_renderBody`
      // only flattens the closed set of components returned by `_renderEntry`.
      return undefined;
  }
}

function extractThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null || typeof item !== "object") continue;
    const thinking = (item as { type?: unknown; thinking?: unknown }).thinking;
    if ((item as { type?: unknown }).type === "thinking" && typeof thinking === "string") parts.push(thinking);
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
    else if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return extractMessageText(content);
}

function findToolEntryIndex(
  entries: readonly TranscriptEntry[],
  toolCallId: string | undefined,
  name: string,
): number {
  if (toolCallId !== undefined) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (isLocalToolEntry(entry) && entry.toolCallId === toolCallId) return i;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isLocalToolEntry(entry) && entry.name === name && entry.state === "pending") return i;
  }
  return -1;
}

function summariseArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncateToWidth(input.replace(/\s+/g, " "), 60);
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  const head = keys[0]!;
  const value = obj[head];
  const summary = typeof value === "string" ? value : JSON.stringify(value);
  const formatted = `${head}=${summary}`;
  return truncateToWidth(formatted.replace(/\s+/g, " "), 60);
}

function noticeSummary(n: StageNotice): string {
  const base = `~ ${n.kind} → ${n.to}`;
  return n.from ? `${base} (was ${n.from})` : base;
}

function stageDurationText(stage: StageSnapshot | undefined): string {
  if (!stage?.startedAt) return "";
  const end = stage.endedAt ?? Date.now();
  const ms = Math.max(0, end - stage.startedAt);
  return formatDuration(ms);
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

function shortenFile(path: string): string {
  if (path.length <= 36) return path;
  // Keep the basename and an ellipsis prefix so the user can still recognise
  // which session file we're pointing at.
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "…" + path.slice(-35);
  return "…" + path.slice(Math.max(slash - 12, 0));
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
  const selected = (text: string): string => hexBg(t.backgroundPanel) + hexToAnsi(t.text) + text + RESET;
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

function centred(content: string, width: number): string {
  const w = visibleWidth(stripAnsi(content));
  if (w >= width) return content;
  const left = Math.floor((width - w) / 2);
  const right = width - w - left;
  return " ".repeat(left) + content + " ".repeat(right);
}

/**
 * Compose a two-column row of `${prefix}${left}…${right}` padded to width.
 * Used by the footer to lay out left/right slabs without losing ANSI runs.
 */
function layoutRow(
  width: number,
  _prefix: string,
  left: string,
  right: string,
  _theme: GraphTheme,
): string {
  const lw = visibleWidth(stripAnsi(left));
  const rw = visibleWidth(stripAnsi(right));
  const gap = Math.max(1, width - lw - rw);
  return left + " ".repeat(gap) + right;
}

/**
 * Approximate a tinted background by mixing the base canvas with a saturated
 * hue at low alpha. Used for status pills and tool-bar tints. Returns a hex
 * colour the renderer can feed to `hexBg`.
 */
function blendBg(baseHex: string, tintHex: string, alpha: number): string {
  return lerpColor(baseHex, tintHex, Math.max(0, Math.min(1, alpha)));
}
