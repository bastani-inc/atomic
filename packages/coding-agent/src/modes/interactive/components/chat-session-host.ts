import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { BashResult } from "../../../core/bash-executor.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { BashExecutionMessage } from "../../../core/messages.ts";
import {
  type Component,
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  Spacer,
  Text,
  matchesKey as tuiMatchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { SessionManager } from "../../../core/session-manager.ts";
import { CustomEditor } from "./custom-editor.ts";
import {
  LiveChatEntriesController,
  renderChatMessageEntry,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
} from "./chat-message-renderer.ts";
import {
  ChatTranscriptComponent,
  ScrollableComponentViewport,
  type ChatTranscriptEntryLike,
} from "./chat-transcript.ts";
import { UsageMeterComponent, FooterComponent } from "./footer.ts";
import { WorkingStatusComponent } from "./working-status.ts";
import {
  combineQueuedMessagesForEditor,
  openExternalEditorForText,
  pasteClipboardImageToEditor,
} from "../chat-input-actions.ts";
import { pickWhimsicalWorkingMessage } from "../whimsical-messages.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_FRAME_MS = 80;
const STREAMING_RENDER_THROTTLE_MS = 80;
const STREAMING_TEXT_TAIL_LINES = 240;
const STREAMING_TEXT_TAIL_CHARS = 16_000;

export interface ChatSessionHostStyle {
  dim(text: string): string;
  text(text: string): string;
  textMuted(text: string): string;
  accent(text: string): string;
  accentBold(text: string): string;
  rule(hex: string, text: string): string;
  cursor(): string;
  blank(width: number): string;
  editorRuleColor(
    disabled: boolean,
    agentSession: AgentSession | undefined,
    state?: { isBashMode: boolean },
  ): string;
}

export interface ChatSessionHostBashRequest {
  command: string;
  excludeFromContext: boolean;
  onChunk: (chunk: string) => void;
}

export interface ChatSessionHostCommands {
  ensureAttached?: () => Promise<void>;
  prompt?: (text: string) => Promise<void>;
  steer?: (text: string) => Promise<void>;
  followUp?: (text: string) => Promise<void>;
  interrupt?: () => Promise<void>;
  resume?: (message?: string) => Promise<void>;
  runBash?: (request: ChatSessionHostBashRequest) => Promise<BashResult>;
  abortBash?: () => void | Promise<void>;
  abortCompaction?: () => void | Promise<void>;
  handleSlashCommand?: (text: string) => Promise<boolean> | boolean;
}

export interface ChatSessionHostOpts<TExtraEntry extends ChatTranscriptEntryLike = never> {
  style: ChatSessionHostStyle;
  commands?: ChatSessionHostCommands;
  requestRender?: () => void;
  getAgentSession?: () => AgentSession | undefined;
  isStreaming?: () => boolean;
  isPaused?: () => boolean;
  isDisabled?: () => boolean;
  isBashRunning?: () => boolean;
  showWarning?: (message: string) => void;
  showStatus?: (message: string) => void;
  actions?: Record<string, () => void | Promise<void>>;
  getActionKeyDisplay?: (action: string) => string;
  getMarkdownTheme?: () => MarkdownTheme;
  tui?: TUI;
  keybindings?: unknown;
  editorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: unknown,
  ) => EditorComponent;
  editorTheme: EditorTheme;
  getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  getCwd?: () => string;
  footerData?: ReadonlyFooterDataProvider;
  renderExtraEntry?: (entry: TExtraEntry) => Component;
}

export type ChatSessionHostEntry<TExtraEntry extends ChatTranscriptEntryLike = never> =
  | ChatMessageEntry
  | TExtraEntry;
type AgentSnapshotMessage = AgentSession["messages"][number];
type CacheKeyPart = string | number | boolean | null;

export class ChatSessionHost<TExtraEntry extends ChatTranscriptEntryLike = never>
  implements Component, Focusable
{
  focused = true;

  private readonly style: ChatSessionHostStyle;
  private readonly commands: ChatSessionHostCommands;
  private readonly requestRender: (() => void) | undefined;
  private readonly getAgentSession: (() => AgentSession | undefined) | undefined;
  private readonly isStreamingOverride: (() => boolean) | undefined;
  private readonly isPaused: (() => boolean) | undefined;
  private readonly isDisabled: (() => boolean) | undefined;
  private readonly isBashRunningOverride: (() => boolean) | undefined;
  private readonly showWarning: ((message: string) => void) | undefined;
  private readonly showStatus: ((message: string) => void) | undefined;
  private readonly actions: Record<string, () => void | Promise<void>> | undefined;
  private readonly getActionKeyDisplay: ((action: string) => string) | undefined;
  private readonly getMarkdownTheme: (() => MarkdownTheme) | undefined;
  private readonly getChatRenderSettings: ChatSessionHostOpts<TExtraEntry>["getChatRenderSettings"];
  private readonly getCwd: (() => string) | undefined;
  private readonly footerData: ReadonlyFooterDataProvider | undefined;
  private readonly renderExtraEntry: ((entry: TExtraEntry) => Component) | undefined;
  private readonly tui: TUI | undefined;

  private inputBuffer = "";
  private transcript: ChatSessionHostEntry<TExtraEntry>[] = [];
  private statusMessage = "";
  private isBashMode = false;
  private localBashRunning = false;
  private sdkBusy = false;
  private workingMessage: string | undefined;
  private pendingSteeringMessages: readonly string[] = [];
  private pendingFollowUpMessages: readonly string[] = [];
  private compactionQueuedMessages: readonly string[] = [];
  private compacting = false;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private renderThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  private bodyViewport = new ScrollableComponentViewport();
  private transcriptComponent: ChatTranscriptComponent<ChatSessionHostEntry<TExtraEntry>>;
  private transcriptRenderSettingsKey = "";
  private renderIdentityIds = new WeakMap<object, number>();
  private nextRenderIdentityId = 1;
  private liveChat: LiveChatEntriesController;
  private editor: EditorComponent | undefined;
  private optimisticUserSignatureCounts = new Map<string, number>();

  constructor(opts: ChatSessionHostOpts<TExtraEntry>) {
    this.style = opts.style;
    this.commands = opts.commands ?? {};
    this.requestRender = opts.requestRender;
    this.getAgentSession = opts.getAgentSession;
    this.isStreamingOverride = opts.isStreaming;
    this.isPaused = opts.isPaused;
    this.isDisabled = opts.isDisabled;
    this.isBashRunningOverride = opts.isBashRunning;
    this.showWarning = opts.showWarning;
    this.showStatus = opts.showStatus;
    this.actions = opts.actions;
    this.getActionKeyDisplay = opts.getActionKeyDisplay;
    this.getMarkdownTheme = opts.getMarkdownTheme;
    this.getChatRenderSettings = opts.getChatRenderSettings;
    this.getCwd = opts.getCwd;
    this.footerData = opts.footerData;
    this.renderExtraEntry = opts.renderExtraEntry;
    this.tui = opts.tui;
    this.liveChat = new LiveChatEntriesController(this.transcript);
    this.transcriptComponent = new ChatTranscriptComponent(
      this.transcript,
      (entry) => this.renderEntry(entry),
      (entry, index) => this.transcriptCacheKey(entry, index),
    );
    this.editor = this.createEditor(
      opts.tui,
      opts.keybindings,
      opts.editorTheme,
      opts.editorFactory,
    );
    this.syncAnimationTick();
  }

  appendMessages(messages: readonly AgentSnapshotMessage[]): void {
    this.liveChat.appendMessages(messages);
  }

  loadSessionFile(sessionFile: string | undefined): void {
    if (this.transcript.length > 0 || sessionFile === undefined) return;
    let messages: readonly AgentSnapshotMessage[];
    try {
      messages = SessionManager.open(sessionFile).buildSessionContext()
        .messages as readonly AgentSnapshotMessage[];
    } catch {
      return;
    }
    this.liveChat.appendMessages(messages);
  }

  appendExtraEntry(entry: TExtraEntry): void {
    this.transcript.push(entry);
  }

  entries(): readonly ChatSessionHostEntry<TExtraEntry>[] {
    return this.transcript;
  }

  private incrementOptimisticUserSignature(signature: string): void {
    this.optimisticUserSignatureCounts.set(
      signature,
      (this.optimisticUserSignatureCounts.get(signature) ?? 0) + 1,
    );
  }

  private decrementOptimisticUserSignature(signature: string): void {
    const count = this.optimisticUserSignatureCounts.get(signature) ?? 0;
    if (count <= 1) this.optimisticUserSignatureCounts.delete(signature);
    else this.optimisticUserSignatureCounts.set(signature, count - 1);
  }

  applyAgentEvent(event: AgentSessionEvent): boolean {
    const type = String((event as { type?: unknown }).type ?? "");
    if (type === "message_start") {
      const message = (event as { message?: unknown }).message;
      if (isUserMessageLike(message)) {
        const signature = userMessageSignature(
          extractMessageText(message.content),
        );
        const count = this.optimisticUserSignatureCounts.get(signature) ?? 0;
        if (count > 0) {
          this.decrementOptimisticUserSignature(signature);
          return false;
        }
      }
    }
    if (isSharedLiveChatEvent(type)) {
      const changed = this.liveChat.applyEvent(event);
      const toolCallEvent = assistantToolCallEvent(event);
      const changedByToolCall = toolCallEvent !== undefined
        ? this.liveChat.applyEvent(toolCallEvent)
        : false;
      this.afterEvent(changed || changedByToolCall);
      return changed || changedByToolCall;
    }
    let changed = false;
    switch (type) {
      case "agent_start":
        this.sdkBusy = true;
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        changed = true;
        break;
      case "agent_end":
        this.sdkBusy = false;
        this.workingMessage = undefined;
        this.liveChat.clearPendingTools();
        this.statusMessage = "";
        changed = true;
        break;
      case "turn_start":
        this.workingMessage = pickWhimsicalWorkingMessage();
        changed = true;
        break;
      case "turn_end":
        this.workingMessage = undefined;
        changed = true;
        break;
      case "queue_update": {
        const queue = event as { steering?: unknown; followUp?: unknown };
        this.pendingSteeringMessages = Array.isArray(queue.steering)
          ? queue.steering.filter((item): item is string => typeof item === "string")
          : [];
        this.pendingFollowUpMessages = Array.isArray(queue.followUp)
          ? queue.followUp.filter((item): item is string => typeof item === "string")
          : [];
        changed = true;
        break;
      }
      case "tool_call":
      case "tool_use":
        changed = this.liveChat.applyEvent(legacyToolStartEvent(event));
        break;
      case "tool_result":
        changed = this.liveChat.applyEvent(legacyToolResultEvent(event));
        break;
      case "thinking_delta":
      case "thinking":
        changed = this.liveChat.applyEvent(legacyThinkingEvent(event));
        break;
      case "compaction_start":
        this.compacting = true;
        this.sdkBusy = true;
        this.statusMessage = "compacting context…";
        changed = true;
        break;
      case "context_compaction_start":
        this.compacting = true;
        this.sdkBusy = true;
        this.statusMessage = "compacting context…";
        changed = true;
        break;
      case "compaction_end": {
        const compaction = event as Extract<AgentSessionEvent, { type: "compaction_end" }>;
        this.compacting = false;
        this.sdkBusy = false;
        this.statusMessage = compaction.errorMessage ?? "";
        if (!compaction.aborted && !compaction.errorMessage && this.compactionQueuedMessages.length > 0) {
          void this.flushCompactionQueue();
        }
        changed = true;
        break;
      }
      case "context_compaction_end": {
        const compaction = event as Extract<AgentSessionEvent, { type: "context_compaction_end" }>;
        this.compacting = false;
        this.sdkBusy = false;
        this.statusMessage = compaction.errorMessage ?? "";
        if (!compaction.aborted && !compaction.errorMessage && this.compactionQueuedMessages.length > 0) {
          void this.flushCompactionQueue();
        }
        changed = true;
        break;
      }
      case "auto_retry_start":
        this.sdkBusy = true;
        this.statusMessage = "retrying…";
        changed = true;
        break;
      case "auto_retry_end": {
        const retry = event as Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
        this.statusMessage = "";
        if (!retry.success) {
          this.sdkBusy = false;
          this.workingMessage = undefined;
        }
        changed = true;
        break;
      }
      default:
        changed = false;
    }
    this.afterEvent(changed);
    return changed;
  }

  render(width: number): string[] {
    return this.renderBody(width, 1);
  }

  invalidate(): void {
    this.transcriptComponent.invalidate();
    this.bodyViewport.invalidate();
    this.editor?.invalidate();
  }

  renderBody(width: number, budget: number): string[] {
    const components: Component[] = [];
    this.transcriptRenderSettingsKey = this.chatRenderSettingsCacheKey();
    if (this.transcript.length > 0) {
      components.push(this.transcriptComponent);
    }
    if (this.statusMessage) {
      components.push(new Spacer(1));
      components.push(new Text(this.style.dim(this.statusMessage), 2, 0));
    }
    this.bodyViewport.setVisibleRows(budget);
    this.bodyViewport.setComponents(components);
    return this.bodyViewport.render(width);
  }

  renderPendingMessages(width: number): string[] {
    if (
      this.pendingSteeringMessages.length === 0 &&
      this.pendingFollowUpMessages.length === 0 &&
      this.compactionQueuedMessages.length === 0
    ) {
      return [];
    }
    const lines = [this.style.blank(width)];
    for (const message of this.pendingSteeringMessages) {
      lines.push(...this.pendingMessageLine(width, "Steering", message));
    }
    for (const message of this.pendingFollowUpMessages) {
      lines.push(...this.pendingMessageLine(width, "Follow-up", message));
    }
    for (const message of this.compactionQueuedMessages) {
      lines.push(...this.pendingMessageLine(width, "Queued", message));
    }
    const hint = this.getActionKeyDisplay?.("app.message.dequeue") ?? "alt+up";
    lines.push(...new Text(this.style.dim(`↳ ${hint} to edit all queued messages`), 1, 0).render(width));
    return lines;
  }

  renderWorkingStatus(width: number): string[] {
    if (!this.isStreaming()) return [];
    const message = this.workingMessage ?? "Working...";
    return new WorkingStatusComponent({
      spinner: spinnerFrame(),
      message,
      spinnerColor: (text) => this.style.accentBold(text),
      messageColor: (text) => this.style.textMuted(text),
    }).render(width);
  }

  renderUsage(width: number): string[] {
    const agentSession = this.getAgentSession?.();
    if (!agentSession) return [];
    return new UsageMeterComponent(agentSession).render(width);
  }

  renderEditor(width: number): string[] {
    const disabled = this.isDisabled?.() === true;
    const agentSession = this.getAgentSession?.();
    const ruleHex = this.style.editorRuleColor(disabled, agentSession, {
      isBashMode: this.isBashMode,
    });
    if (!disabled && this.editor) {
      setEditorFocused(this.editor, this.focused);
      setEditorPlaceholder(this.editor, undefined);
      setEditorBorderColor(this.editor, (text) => this.style.rule(ruleHex, text));
      return this.editor.render(width);
    }
    if (this.editor) setEditorFocused(this.editor, false);
    const rule = this.style.rule(ruleHex, "─".repeat(width));
    const available = Math.max(1, width - 3);
    const value = this.inputBuffer
      ? this.style.text(truncateToWidth(this.inputBuffer, available)) + this.style.cursor()
      : disabled
        ? ""
        : this.style.cursor();
    const left = this.style.accentBold("❯") + " " + value;
    const gap = Math.max(0, width - visibleWidth(stripAnsi(left)));
    const body = left + " ".repeat(gap);
    return [rule, body, rule];
  }

  renderFooter(width: number): string[] {
    const agentSession = this.getAgentSession?.();
    if (agentSession && this.footerData) {
      return new FooterComponent(agentSession, this.footerData).render(width);
    }
    return [];
  }

  handleScrollInput(data: string): boolean {
    return this.bodyViewport.handleInput(data);
  }

  handleInput(data: string): boolean {
    if (this.handleScrollInput(data)) return true;
    if (matchesKey(data, "alt+up")) {
      this.restoreQueuedMessagesToEditor();
      return true;
    }
    if (matchesKey(data, "ctrl+f")) {
      void this.submit("followUp");
      return true;
    }
    if (matchesKey(data, "escape")) {
      if (this.compacting) {
        void this.abortCompaction();
        return true;
      }
      if (this.isStreaming()) {
        void this.interrupt();
        return true;
      }
      if (this.isBashRunning()) {
        void this.abortBash();
        return true;
      }
      if (this.isBashMode) {
        this.setEditorText("");
        this.notifyStatus("Bash mode cleared");
        return true;
      }
    }
    if (this.editor) {
      this.editor.handleInput(data);
      return true;
    }
    if (matchesKey(data, "enter")) {
      void this.submit("auto");
      return true;
    }
    if (matchesKey(data, "backspace")) {
      this.setEditorText(this.inputBuffer.slice(0, -1));
      return true;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.setEditorText(`${this.inputBuffer}${data}`);
      return true;
    }
    return false;
  }

  async interrupt(): Promise<void> {
    try {
      this.restoreQueuedMessagesToEditor();
      this.sdkBusy = false;
      this.workingMessage = undefined;
      await this.commands.interrupt?.();
    } catch (err) {
      this.statusMessage = errorMessage(err);
    } finally {
      this.syncAnimationTick();
      this.requestRender?.();
    }
  }

  async submit(mode: "auto" | "followUp" = "auto", submittedText?: string): Promise<void> {
    const text = (submittedText ?? this.inputBuffer).trim();
    if (!text) return;
    if (text.startsWith("/") && this.commands.handleSlashCommand) {
      const handled = await this.commands.handleSlashCommand(text);
      if (handled) {
        this.setEditorText("");
        this.requestRender?.();
        return;
      }
    }
    if (this.compacting) {
      this.setEditorText("");
      this.compactionQueuedMessages = [...this.compactionQueuedMessages, text];
      this.notifyStatus("Queued message until compaction completes");
      return;
    }
    const bash = parseBashInput(text);
    if (bash?.command) {
      if (this.isBashRunning()) {
        this.notifyWarning("A bash command is already running. esc cancel first.");
        this.setEditorText(text);
        return;
      }
      this.setEditorText("");
      await this.runBashCommand(bash.command, bash.excludeFromContext);
      return;
    }
    this.setEditorText("");
    const isPaused = this.isPaused?.() === true;
    const isStreaming = this.isStreaming();
    const shouldAppendOptimisticUser = mode === "auto" && !isStreaming;
    const optimisticSignature = shouldAppendOptimisticUser
      ? userMessageSignature(text)
      : undefined;
    if (optimisticSignature !== undefined) {
      this.liveChat.appendUserText(text);
      this.bodyViewport.scrollToBottom();
      this.incrementOptimisticUserSignature(optimisticSignature);
    }
    this.requestRender?.();
    try {
      if (isPaused) {
        this.sdkBusy = true;
        this.statusMessage = "resuming…";
        this.syncAnimationTick();
        this.requestRender?.();
        await this.requiredCommand("resume")(text);
        this.sdkBusy = false;
        this.statusMessage = "";
        this.syncAnimationTick();
        return;
      }
      if (mode === "followUp" && isStreaming) {
        await this.queueFollowUp(text);
        return;
      }
      if (isStreaming) {
        await this.queueSteer(text);
      } else {
        this.sdkBusy = true;
        this.syncAnimationTick();
        await this.commands.ensureAttached?.();
        await this.requiredCommand("prompt")(text);
        this.sdkBusy = false;
        this.syncAnimationTick();
      }
    } catch (err) {
      if (optimisticSignature !== undefined) {
        this.decrementOptimisticUserSignature(optimisticSignature);
      }
      this.sdkBusy = false;
      this.statusMessage = errorMessage(err);
      this.syncAnimationTick();
      this.requestRender?.();
    }
  }

  isStreaming(): boolean {
    return this.sdkBusy || this.isStreamingOverride?.() === true;
  }

  isBashRunning(): boolean {
    return this.localBashRunning || this.isBashRunningOverride?.() === true;
  }

  isEditingBashCommand(): boolean {
    return this.isBashMode;
  }

  hasInputText(): boolean {
    return this.inputBuffer.length > 0;
  }

  hasAnimationTick(): boolean {
    return this.animationTimer !== undefined;
  }

  bodyScrollFromBottom(): number {
    return this.bodyViewport.getScrollFromBottom();
  }

  bodyMaxScroll(): number {
    return this.bodyViewport.getMaxScroll();
  }

  inputText(): string {
    return this.inputBuffer;
  }

  statusText(): string {
    return this.statusMessage;
  }

  scrollToBottom(): void {
    this.bodyViewport.scrollToBottom();
  }

  syncAnimationTick(): void {
    const shouldAnimate =
      this.isStreaming() || (this.sdkBusy && this.liveChat.pendingToolIds().length > 0);
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

  dispose(): void {
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

  private createEditor(
    tui: TUI | undefined,
    keybindings: unknown,
    editorTheme: EditorTheme,
    editorFactory: ChatSessionHostOpts<TExtraEntry>["editorFactory"],
  ): EditorComponent | undefined {
    if (!tui || !keybindings) return undefined;
    const editor = this.createInheritedEditor(tui, editorTheme, keybindings, editorFactory) ??
      new CustomEditor(
        tui,
        editorTheme,
        keybindings as ConstructorParameters<typeof CustomEditor>[2],
        { paddingX: 0, autocompleteMaxVisible: 5 },
      );
    editor.onChange = (text) => {
      this.inputBuffer = text;
      this.isBashMode = text.trimStart().startsWith("!");
    };
    editor.onSubmit = (text) => {
      void this.submit("auto", text);
    };
    const actionEditor = editor as EditorComponent & {
      onAction?: (action: string, handler: () => void) => void;
      onEscape?: () => void;
      onPasteImage?: () => void;
    };
    actionEditor.onAction?.("app.message.followUp", () => {
      void this.submit("followUp");
    });
    actionEditor.onAction?.("app.message.dequeue", () => {
      this.restoreQueuedMessagesToEditor();
    });
    actionEditor.onAction?.("app.editor.external", () => {
      this.openExternalEditor();
    });
    if (this.actions) {
      for (const [action, handler] of Object.entries(this.actions)) {
        actionEditor.onAction?.(action, () => {
          void handler();
        });
      }
    }
    const previousPasteImage = actionEditor.onPasteImage;
    actionEditor.onPasteImage = () => {
      previousPasteImage?.();
      void pasteClipboardImageToEditor(
        this.editorAccess(),
        () => this.requestRender?.(),
        { showWarning: (message) => this.notifyWarning(message) },
      );
    };
    const previousEscape = actionEditor.onEscape;
    actionEditor.onEscape = () => {
      if (this.compacting) {
        void this.abortCompaction();
        return;
      }
      if (this.isStreaming()) {
        void this.interrupt();
        return;
      }
      if (this.isBashRunning()) {
        void this.abortBash();
        return;
      }
      if (this.isBashMode) {
        this.setEditorText("");
        this.notifyStatus("Bash mode cleared");
        return;
      }
      previousEscape?.();
    };
    return editor;
  }

  private createInheritedEditor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: unknown,
    editorFactory: ChatSessionHostOpts<TExtraEntry>["editorFactory"],
  ): EditorComponent | undefined {
    if (!editorFactory) return undefined;
    try {
      return editorFactory(tui, editorTheme, keybindings);
    } catch {
      return undefined;
    }
  }

  private editorAccess(): {
    insertTextAtCursor: (text: string) => void;
    getText: () => string;
    setText: (text: string) => void;
  } {
    return {
      insertTextAtCursor: (text: string) => {
        if (this.editor?.insertTextAtCursor) {
          this.editor.insertTextAtCursor(text);
          return;
        }
        this.setEditorText(`${this.inputBuffer}${text}`);
      },
      getText: () => this.inputBuffer,
      setText: (text: string) => this.setEditorText(text),
    };
  }

  private openExternalEditor(): void {
    if (!this.editor) return;
    const host = this.tuiHost();
    if (!host) return;
    const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
    const updated = openExternalEditorForText(currentText, host, {
      showWarning: (message) => this.notifyWarning(message),
    });
    if (updated !== undefined) this.setEditorText(updated);
  }

  private tuiHost(): Pick<TUI, "stop" | "start" | "requestRender"> | undefined {
    return this.tui;
  }

  private setEditorText(text: string): void {
    this.inputBuffer = text;
    this.isBashMode = text.trimStart().startsWith("!");
    this.editor?.setText(text);
  }

  private renderEntry(entry: ChatSessionHostEntry<TExtraEntry>): Component {
    if (isChatMessageEntry(entry)) {
      return renderChatMessageEntry(
        this.streamingWindowedEntry(entry),
        this.chatMessageRenderOptions(),
      );
    }
    if (!this.renderExtraEntry) {
      return new Text("", 0, 0);
    }
    return this.renderExtraEntry(entry);
  }

  private streamingWindowedEntry(entry: ChatMessageEntry): ChatMessageEntry {
    if (!this.isStreaming() || this.bodyViewport.getScrollFromBottom() !== 0) {
      return entry;
    }
    if (entry.kind !== "assistant") return entry;
    const content = entry.message.content.map((item) => {
      if (item.type === "text") return { ...item, text: tailStreamingText(item.text) };
      if (item.type === "thinking") return { ...item, thinking: tailStreamingText(item.thinking) };
      return item;
    });
    return { ...entry, message: { ...entry.message, content } };
  }

  private chatMessageRenderOptions(): ChatMessageRenderOptions {
    const inherited = this.getChatRenderSettings?.();
    return {
      ...inherited,
      ui: this.toolTui(),
      cwd: this.getCwd?.() ?? this.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
      markdownTheme: inherited?.markdownTheme ?? this.getMarkdownTheme?.(),
      showImages: inherited?.showImages ?? true,
    };
  }

  private toolTui(): Pick<TUI, "requestRender"> {
    return { requestRender: () => this.requestRender?.() };
  }

  private chatRenderSettingsCacheKey(): string {
    const inherited = this.getChatRenderSettings?.();
    return cacheKey([
      "settings",
      inherited?.hideThinkingBlock === true,
      inherited?.hiddenThinkingLabel ?? "",
      inherited?.toolOutputExpanded === true,
      inherited?.showImages !== false,
      inherited?.imageWidthCells ?? null,
      this.getCwd?.() ?? this.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
      this.bodyViewport.getScrollFromBottom() === 0,
      this.isStreaming(),
    ]);
  }

  private transcriptCacheKey(
    entry: ChatSessionHostEntry<TExtraEntry>,
    index: number,
  ): string {
    return cacheKey([
      this.transcriptRenderSettingsKey,
      index,
      entry.role,
      this.renderIdentityKey(entry),
      this.entryContentCacheKey(entry),
    ]);
  }

  private entryContentCacheKey(entry: ChatSessionHostEntry<TExtraEntry>): string {
    if (!isChatMessageEntry(entry)) return cacheKey(["extra"]);
    switch (entry.kind) {
      case "assistant":
        return cacheKey(["assistant", this.renderIdentityKey(entry.message)]);
      case "tool":
        return cacheKey([
          "tool",
          entry.toolCallId,
          entry.toolName,
          entry.isPartial === true,
          entry.result === undefined ? null : this.renderIdentityKey(entry.result),
        ]);
      case "bashExecution":
        return cacheKey([
          "bashExecution",
          entry.isPartial === true,
          entry.message.command,
          entry.message.output,
          entry.message.exitCode ?? null,
          entry.message.cancelled,
          entry.message.truncated,
          entry.message.fullOutputPath ?? null,
        ]);
      case "user":
        return cacheKey(["user", entry.text]);
      case "custom":
        return cacheKey(["custom", this.renderIdentityKey(entry.message)]);
      case "branchSummary":
        return cacheKey(["branchSummary", this.renderIdentityKey(entry.message)]);
      case "system":
        return cacheKey(["system", entry.text]);
    }
  }

  private renderIdentityKey(value: object): string {
    const existing = this.renderIdentityIds.get(value);
    if (existing !== undefined) return String(existing);
    const id = this.nextRenderIdentityId;
    this.nextRenderIdentityId += 1;
    this.renderIdentityIds.set(value, id);
    return String(id);
  }

  private pendingMessageLine(
    width: number,
    label: "Steering" | "Follow-up" | "Queued",
    message: string,
  ): string[] {
    const text = `${label}: ${message}`;
    return new Text(
      this.style.dim(truncateToWidth(text, Math.max(1, width - 2))),
      1,
      0,
    ).render(width);
  }

  private async abortCompaction(): Promise<void> {
    try {
      await this.commands.abortCompaction?.();
      this.compacting = false;
      this.sdkBusy = false;
      this.notifyStatus("Compaction cancelled");
    } catch (err) {
      this.notifyWarning(errorMessage(err));
    } finally {
      this.syncAnimationTick();
      this.requestRender?.();
    }
  }

  private async abortBash(): Promise<void> {
    try {
      await this.commands.abortBash?.();
      this.localBashRunning = false;
      this.notifyStatus("Bash command cancelled");
    } catch (err) {
      this.notifyWarning(errorMessage(err));
    } finally {
      this.requestRender?.();
    }
  }

  private async runBashCommand(
    command: string,
    excludeFromContext: boolean,
  ): Promise<void> {
    const runBash = this.commands.runBash;
    if (!runBash) {
      this.notifyWarning("no bash command configured for this chat session");
      return;
    }
    const bashMessage: BashExecutionMessage = {
      role: "bashExecution",
      command,
      output: "",
      exitCode: undefined,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
      ...(excludeFromContext ? { excludeFromContext: true } : {}),
    };
    const bashEntry: ChatMessageEntry = {
      role: "tool",
      kind: "bashExecution",
      message: bashMessage,
      isPartial: true,
    };
    this.transcript.push(bashEntry);
    this.localBashRunning = true;
    this.bodyViewport.scrollToBottom();
    this.requestRender?.();
    try {
      const result = await runBash({
        command,
        excludeFromContext,
        onChunk: (chunk) => {
          bashMessage.output += chunk;
          this.requestRender?.();
        },
      });
      bashMessage.output = result.output;
      bashMessage.exitCode = result.exitCode;
      bashMessage.cancelled = result.cancelled;
      bashMessage.truncated = result.truncated;
      if (result.fullOutputPath !== undefined) {
        bashMessage.fullOutputPath = result.fullOutputPath;
      }
    } catch (err) {
      bashMessage.output = errorMessage(err);
      bashMessage.exitCode = undefined;
      bashMessage.cancelled = false;
      bashMessage.truncated = false;
    } finally {
      bashEntry.isPartial = false;
      this.localBashRunning = false;
      this.requestRender?.();
    }
  }

  private async flushCompactionQueue(): Promise<void> {
    const queued = [...this.compactionQueuedMessages];
    this.compactionQueuedMessages = [];
    if (queued.length === 0) return;
    let nextIndex = 0;
    try {
      const first = queued[0];
      if (first !== undefined) {
        await this.requiredCommand("prompt")(first);
        nextIndex = 1;
      }
      for (; nextIndex < queued.length; nextIndex++) {
        await this.queueFollowUp(queued[nextIndex]!);
      }
    } catch (err) {
      this.compactionQueuedMessages = [
        ...queued.slice(nextIndex),
        ...this.compactionQueuedMessages,
      ];
      this.notifyWarning(errorMessage(err));
      this.requestRender?.();
    }
  }

  private async queueSteer(text: string): Promise<void> {
    const agentSession = this.getAgentSession?.();
    if (agentSession?.isStreaming) {
      await agentSession.prompt(text, { streamingBehavior: "steer" });
      return;
    }
    await this.requiredCommand("steer")(text);
  }

  private async queueFollowUp(text: string): Promise<void> {
    const agentSession = this.getAgentSession?.();
    if (agentSession?.isStreaming) {
      await agentSession.prompt(text, { streamingBehavior: "followUp" });
      return;
    }
    await this.requiredCommand("followUp")(text);
  }

  restoreQueuedMessagesToEditor(): boolean {
    const queuedMessages = [
      ...this.pendingSteeringMessages,
      ...this.pendingFollowUpMessages,
      ...this.compactionQueuedMessages,
    ];
    if (queuedMessages.length === 0) {
      this.notifyStatus("No queued messages to restore");
      return false;
    }
    const restoredText = combineQueuedMessagesForEditor(queuedMessages, this.inputBuffer);
    this.pendingSteeringMessages = [];
    this.pendingFollowUpMessages = [];
    this.compactionQueuedMessages = [];
    this.setEditorText(restoredText);
    this.getAgentSession?.()?.clearQueue();
    this.notifyStatus(
      `Restored ${queuedMessages.length} queued message${queuedMessages.length === 1 ? "" : "s"} to editor`,
    );
    this.requestRender?.();
    return true;
  }

  private notifyWarning(message: string): void {
    this.statusMessage = message;
    this.showWarning?.(message);
    this.requestRender?.();
  }

  private notifyStatus(message: string): void {
    this.statusMessage = message;
    this.showStatus?.(message);
    this.requestRender?.();
  }

  private requiredCommand(
    name: "prompt" | "steer" | "followUp" | "resume",
  ): (text?: string) => Promise<void> {
    switch (name) {
      case "prompt":
        return async (text) => {
          if (!this.commands.prompt) throw new Error("no prompt command configured for this chat session");
          await this.commands.prompt(text ?? "");
        };
      case "steer":
        return async (text) => {
          if (!this.commands.steer) throw new Error("no steer command configured for this chat session");
          await this.commands.steer(text ?? "");
        };
      case "followUp":
        return async (text) => {
          if (!this.commands.followUp) throw new Error("no followUp command configured for this chat session");
          await this.commands.followUp(text ?? "");
        };
      case "resume":
        return async (text) => {
          if (!this.commands.resume) throw new Error("no resume command configured for this chat session");
          await this.commands.resume(text);
        };
    }
  }

  private afterEvent(changed: boolean): void {
    this.syncAnimationTick();
    if (!changed) return;
    this.requestEventRender();
  }

  private requestEventRender(): void {
    if (!this.isStreaming()) {
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

function setEditorBorderColor(
  editor: EditorComponent,
  borderColor: (text: string) => string,
): void {
  const candidate = editor as EditorComponent & {
    borderColor?: (text: string) => string;
  };
  if (candidate.borderColor !== undefined) candidate.borderColor = borderColor;
}

function setEditorFocused(editor: EditorComponent, focused: boolean): void {
  const candidate = editor as EditorComponent & Partial<Focusable>;
  if ("focused" in candidate) candidate.focused = focused;
}

function matchesKey(
  data: string,
  key: "enter" | "backspace" | "escape" | "ctrl+f" | "alt+up",
): boolean {
  if (key === "enter" && (data === "\r" || data === "\n")) return true;
  if (key === "backspace" && (data === "\x7f" || data === "\b")) return true;
  if (key === "escape" && data === "\x1b") return true;
  if (key === "ctrl+f" && data === "\x06") return true;
  return tuiMatchesKey(data, key);
}

function parseBashInput(text: string):
  | { command: string; excludeFromContext: boolean }
  | undefined {
  if (!text.startsWith("!")) return undefined;
  const excludeFromContext = text.startsWith("!!");
  const command = text.slice(excludeFromContext ? 2 : 1).trim();
  return { command, excludeFromContext };
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

function cacheKey(parts: readonly CacheKeyPart[]): string {
  return JSON.stringify(parts);
}

function isChatMessageEntry<TExtraEntry extends ChatTranscriptEntryLike>(
  entry: ChatSessionHostEntry<TExtraEntry>,
): entry is ChatMessageEntry {
  if (!("role" in entry) || !("kind" in entry)) return false;
  const candidate = entry as { role?: unknown; kind?: unknown; message?: unknown; text?: unknown };
  switch (candidate.kind) {
    case "assistant":
      return candidate.role === "assistant" && candidate.message !== undefined;
    case "tool":
      return candidate.role === "tool" && "toolName" in candidate && "toolCallId" in candidate && "args" in candidate;
    case "bashExecution":
      return candidate.role === "tool" && candidate.message !== undefined;
    case "user":
      return candidate.role === "user" && typeof candidate.text === "string";
    case "custom":
      return candidate.role === "custom" && candidate.message !== undefined;
    case "branchSummary":
      return candidate.role === "summary" && candidate.message !== undefined;
    case "system":
      return candidate.role === "system" && candidate.message !== undefined;
    default:
      return false;
  }
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

function spinnerFrame(): string {
  const idx = Math.floor(Date.now() / 80) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx]!;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
