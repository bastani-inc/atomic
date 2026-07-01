import {
  type Component,
  type TUI,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { UsageMeterComponent, FooterComponent } from "./footer.ts";
import {
  renderChatMessageEntry,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
} from "./chat-message-renderer.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionHostEntry } from "./chat-session-host-types.ts";
import {
  setEditorBorderColor,
  setEditorFocused,
  setEditorPlaceholder,
} from "./chat-session-host-editor.ts";
import { isChatSessionStreaming } from "./chat-session-host-runtime.ts";
import {
  cacheKey,
  isChatMessageEntry,
  spinnerFrame,
  stripAnsi,
  tailStreamingText,
} from "./chat-session-host-utils.ts";
import { WorkingStatusComponent } from "./working-status.ts";

export function renderChatSessionBody<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  width: number,
  budget: number,
): string[] {
  const components: Component[] = [];
  state.transcriptRenderSettingsKey = chatRenderSettingsCacheKey(state);
  if (state.transcript.length > 0) {
    components.push(state.transcriptComponent);
  }
  if (state.statusMessage) {
    components.push(new Spacer(1));
    components.push(new Text(state.style.dim(state.statusMessage), 2, 0));
  }
  state.bodyViewport.setVisibleRows(budget);
  state.bodyViewport.setComponents(components);
  return state.bodyViewport.render(width);
}

export function renderChatSessionPendingMessages<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>, width: number): string[] {
  if (
    state.pendingSteeringMessages.length === 0 &&
    state.pendingFollowUpMessages.length === 0 &&
    state.compactionQueuedMessages.length === 0
  ) {
    return [];
  }
  const lines = [state.style.blank(width)];
  for (const message of state.pendingSteeringMessages) {
    lines.push(...pendingMessageLine(state, width, "Steering", message));
  }
  for (const message of state.pendingFollowUpMessages) {
    lines.push(...pendingMessageLine(state, width, "Follow-up", message));
  }
  for (const message of state.compactionQueuedMessages) {
    lines.push(...pendingMessageLine(state, width, "Queued", message));
  }
  const hint = state.getActionKeyDisplay?.("app.message.dequeue") ?? "alt+up";
  lines.push(...new Text(state.style.dim(`↳ ${hint} to edit all queued messages`), 1, 0).render(width));
  return lines;
}

export function renderChatSessionWorkingStatus<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>, width: number): string[] {
  if (!isChatSessionStreaming(state)) return [];
  const message = state.workingMessage ?? "Working...";
  return new WorkingStatusComponent({
    spinner: spinnerFrame(),
    message,
    spinnerColor: (text) => state.style.accentBold(text),
    messageColor: (text) => state.style.textMuted(text),
  }).render(width);
}

export function renderChatSessionUsage<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  width: number,
): string[] {
  const agentSession = state.getAgentSession?.();
  if (!agentSession) return [];
  return new UsageMeterComponent(agentSession).render(width);
}

export function renderChatSessionEditor<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  width: number,
  focused: boolean,
): string[] {
  const disabled = state.isDisabled?.() === true;
  const agentSession = state.getAgentSession?.();
  const ruleHex = state.style.editorRuleColor(disabled, agentSession, {
    isBashMode: state.isBashMode,
  });
  if (!disabled && state.editor) {
    setEditorFocused(state.editor, focused);
    setEditorPlaceholder(state.editor, undefined);
    setEditorBorderColor(state.editor, (text) => state.style.rule(ruleHex, text));
    return state.editor.render(width);
  }
  if (state.editor) setEditorFocused(state.editor, false);
  const rule = state.style.rule(ruleHex, "─".repeat(width));
  const available = Math.max(1, width - 3);
  const value = state.inputBuffer
    ? state.style.text(truncateToWidth(state.inputBuffer, available)) + state.style.cursor()
    : disabled
      ? ""
      : state.style.cursor();
  const left = state.style.accentBold("❯") + " " + value;
  const gap = Math.max(0, width - visibleWidth(stripAnsi(left)));
  const body = left + " ".repeat(gap);
  return [rule, body, rule];
}

export function renderChatSessionFooter<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  width: number,
): string[] {
  const agentSession = state.getAgentSession?.();
  if (agentSession && state.footerData) {
    return new FooterComponent(agentSession, state.footerData).render(width);
  }
  return [];
}

export function renderChatSessionEntry<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  entry: ChatSessionHostEntry<TExtraEntry>,
): Component {
  if (isChatMessageEntry(entry)) {
    return renderChatMessageEntry(
      streamingWindowedEntry(state, entry),
      chatMessageRenderOptions(state),
    );
  }
  if (!state.renderExtraEntry) {
    return new Text("", 0, 0);
  }
  return state.renderExtraEntry(entry);
}

export function transcriptCacheKey<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  entry: ChatSessionHostEntry<TExtraEntry>,
  index: number,
): string {
  return cacheKey([
    state.transcriptRenderSettingsKey,
    index,
    entry.role,
    renderIdentityKey(state, entry),
    entryContentCacheKey(state, entry),
  ]);
}

function streamingWindowedEntry<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  entry: ChatMessageEntry,
): ChatMessageEntry {
  if (!isChatSessionStreaming(state) || state.bodyViewport.getScrollFromBottom() !== 0) {
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

function chatMessageRenderOptions<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): ChatMessageRenderOptions {
  const inherited = state.getChatRenderSettings?.();
  return {
    ...inherited,
    ui: toolTui(state),
    cwd: state.getCwd?.() ?? state.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
    markdownTheme: inherited?.markdownTheme ?? state.getMarkdownTheme?.(),
    showImages: inherited?.showImages ?? true,
  };
}

function toolTui<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): Pick<TUI, "requestRender"> {
  return { requestRender: () => state.requestRender?.() };
}

function chatRenderSettingsCacheKey<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): string {
  const inherited = state.getChatRenderSettings?.();
  return cacheKey([
    "settings",
    inherited?.hideThinkingBlock === true,
    inherited?.hiddenThinkingLabel ?? "",
    inherited?.toolOutputExpanded === true,
    inherited?.showImages !== false,
    inherited?.imageWidthCells ?? null,
    inherited?.outputPad ?? null,
    state.getCwd?.() ?? state.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
    state.bodyViewport.getScrollFromBottom() === 0,
    isChatSessionStreaming(state),
  ]);
}

function entryContentCacheKey<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  entry: ChatSessionHostEntry<TExtraEntry>,
): string {
  if (!isChatMessageEntry(entry)) return cacheKey(["extra"]);
  switch (entry.kind) {
    case "assistant":
      return cacheKey(["assistant", renderIdentityKey(state, entry.message)]);
    case "tool":
      return cacheKey(["tool", entry.toolCallId, entry.toolName, entry.isPartial === true, entry.result === undefined ? null : renderIdentityKey(state, entry.result)]);
    case "bashExecution":
      return cacheKey(["bashExecution", entry.isPartial === true, entry.message.command, entry.message.output, entry.message.exitCode ?? null, entry.message.cancelled, entry.message.truncated, entry.message.fullOutputPath ?? null]);
    case "user":
      return cacheKey(["user", entry.text]);
    case "custom":
      return cacheKey(["custom", renderIdentityKey(state, entry.message)]);
    case "branchSummary":
      return cacheKey(["branchSummary", renderIdentityKey(state, entry.message)]);
    case "system":
      return cacheKey(["system", entry.text]);
  }
}

function renderIdentityKey<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  value: object,
): string {
  const existing = state.renderIdentityIds.get(value);
  if (existing !== undefined) return String(existing);
  const id = state.nextRenderIdentityId;
  state.nextRenderIdentityId += 1;
  state.renderIdentityIds.set(value, id);
  return String(id);
}

function pendingMessageLine<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  width: number,
  label: "Steering" | "Follow-up" | "Queued",
  message: string,
): string[] {
  const text = `${label}: ${message}`;
  return new Text(
    state.style.dim(truncateToWidth(text, Math.max(1, width - 2))),
    1,
    0,
  ).render(width);
}
