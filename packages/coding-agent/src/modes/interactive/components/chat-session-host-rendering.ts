import { type Component, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import {
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	renderChatMessageEntry,
} from "./chat-message-renderer.ts";
import { setEditorBorderColor, setEditorFocused, setEditorPlaceholder } from "./chat-session-host-editor.ts";
import { isChatSessionStreaming } from "./chat-session-host-runtime.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionHostEntry } from "./chat-session-host-types.ts";
import { cacheKey, isChatMessageEntry, stripAnsi, tailStreamingText } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { FooterComponent, UsageMeterComponent } from "./footer.ts";
import { compactionMeta } from "./working-run-meter.ts";
import { WorkingStatusComponent } from "./working-status.ts";

export function renderChatSessionBody<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
	budget: number,
): string[] {
	const components: Component[] = [];
	// Kept as the same string while it is unchanged, so every entry's key compares it by reference.
	const settingsKey = chatRenderSettingsCacheKey(state);
	if (settingsKey !== state.transcriptRenderSettingsKey) state.transcriptRenderSettingsKey = settingsKey;
	if (state.transcript.length > 0) {
		components.push(state.transcriptComponent);
	}
	if (state.statusMessage && !state.compacting) {
		components.push(new Spacer(1));
		components.push(new Text(state.style.dim(state.statusMessage), 2, 0));
	}
	state.bodyViewport.setVisibleRows(budget);
	state.bodyViewport.setComponents(components);
	return state.bodyViewport.render(width);
}

export function renderChatSessionPendingMessages<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
): string[] {
	if (
		state.pendingSteeringMessages.length === 0 &&
		state.pendingFollowUpMessages.length === 0 &&
		state.unconfirmedQueuedMessages.length === 0 &&
		state.compactionQueuedMessages.length === 0
	) {
		return [];
	}
	const lines = [state.style.blank(width)];
	const unconfirmed = (mode: "steer" | "followUp") =>
		state.unconfirmedQueuedMessages.filter((message) => message.mode === mode).map((message) => message.text);
	for (const message of [...state.pendingSteeringMessages, ...unconfirmed("steer")]) {
		lines.push(...pendingMessageLine(state, width, "Steering", message));
	}
	for (const message of [...state.pendingFollowUpMessages, ...unconfirmed("followUp")]) {
		lines.push(...pendingMessageLine(state, width, "Follow-up", message));
	}
	for (const message of state.compactionQueuedMessages) {
		lines.push(...pendingMessageLine(state, width, "Queued", message.text));
	}
	const hint = state.getActionKeyDisplay?.("app.message.dequeue") ?? "alt+up";
	lines.push(...new Text(state.style.dim(`↳ ${hint} to edit all queued messages`), 1, 0).render(width));
	return lines;
}

export function renderChatSessionWorkingStatus<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
): string[] {
	if (!isChatSessionStreaming(state)) return [];
	if (state.statusMessage && !state.compacting) return [];
	const palette = state.style.workingIndicatorPalette;
	const useCallerStyling =
		!palette && state.style.workingIndicatorUseGlobalTheme !== true && process.env.NO_COLOR === undefined;
	if (state.compacting) {
		const startedAt =
			state.compactionStartedAt ??
			state.getAgentSession?.()?.compactionStartedAt ??
			state.getChatBoxSession?.()?.compactionStartedAt ??
			Date.now();
		return new WorkingStatusComponent({
			frame: state.workingFrame,
			logo: true,
			message: state.statusMessage || "Compacting context...",
			meta: compactionMeta(startedAt, state.getActionKeyDisplay?.("app.interrupt") ?? "esc"),
			palette,
			spinnerColor: useCallerStyling ? (text) => state.style.accent(text) : undefined,
			spinnerBoldColor: useCallerStyling ? (text) => state.style.accentBold(text) : undefined,
			messageColor: (text) => state.style.textMuted(text),
		}).render(width);
	}
	if (!state.workingLifecycleActive) return [];
	return new WorkingStatusComponent({
		frame: state.workingFrame,
		message: state.workingMessage ?? "Working...",
		meta: state.workingRunMeter.snapshot(),
		palette,
		spinnerColor: useCallerStyling ? (text) => state.style.accent(text) : undefined,
		spinnerBoldColor: useCallerStyling ? (text) => state.style.accentBold(text) : undefined,
		messageColor: (text) => state.style.textMuted(text),
	}).render(width);
}

export function renderChatSessionUsage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
): string[] {
	const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
	if (!session) return [];
	return new UsageMeterComponent(session).render(width);
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
	const left = `${state.style.accentBold("❯")} ${value}`;
	const gap = Math.max(0, width - visibleWidth(stripAnsi(left)));
	const body = left + " ".repeat(gap);
	return [rule, body, rule];
}

export function renderChatSessionFooter<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
	navigationActive = false,
): string[] {
	if (state.disposed) return [];
	const agentSession = state.getAgentSession?.();
	const session = agentSession ?? state.getChatBoxSession?.();
	state.footerNavigationActive = navigationActive || agentSession === undefined;
	if (session && state.footerData) {
		state.footer ??= new FooterComponent(
			session,
			state.footerData,
			{
				dim: (text) => state.style.dim(text),
				muted: (text) => state.style.textMuted(text),
				warning: (text) => state.style.accent(text),
			},
			() => state.footerNavigationActive,
			// A task's session has no task store of its own: its footer counts the tasks the host shows for it.
			agentSession === undefined ? () => state.getTaskSource?.()?.backgroundTasks ?? [] : undefined,
		);
		state.footer.setSession(session);
		return state.footer.render(width);
	}
	state.footer?.dispose();
	state.footer = undefined;
	return [];
}

export function renderChatSessionEntry<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
): Component {
	if (state.extraEntries.includes(entry as TExtraEntry)) {
		return state.renderExtraEntry?.(entry as TExtraEntry) ?? new Text("", 0, 0);
	}
	if (isChatMessageEntry(entry)) {
		const isStreaming = isChatSessionStreaming(state) && state.liveChat.isStreamingAssistantEntry(entry);
		const options = chatMessageRenderOptions(state, isStreaming);
		return renderChatMessageEntry(
			streamingWindowedEntry(state, entry, isStreaming),
			entry.kind === "tool" ? { ...options, ui: entryTui(state, entry) } : options,
		);
	}
	if (!state.renderExtraEntry) {
		return new Text("", 0, 0);
	}
	return state.renderExtraEntry(entry);
}

/**
 * What an entry's rows depend on besides the entry object, compared part by part: the chat's render settings, the
 * redraws its own renderer asked for, the fields that change in place, and, for the assistant message still
 * streaming, the streaming state and tail window. Entries that only change by being replaced share one key, so a
 * frame that changed nothing compares each of them by reference.
 */
export function transcriptCacheKey<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
): readonly unknown[] {
	const revision = state.entryRevisions.get(entry) ?? 0;
	const message = isChatMessageEntry(entry) ? entry : undefined;
	const streaming =
		message !== undefined && state.liveChat.isStreamingAssistantEntry(message) && isChatSessionStreaming(state);
	if (!streaming && (message === undefined || message.kind !== "bashExecution")) {
		return replacedEntryKey(state, revision, message?.kind === "task" ? message : undefined);
	}
	return [
		state.transcriptRenderSettingsKey,
		revision,
		streaming,
		streaming && state.bodyViewport.getScrollFromBottom() === 0,
		...(message === undefined ? [] : inPlaceKeyParts(message)),
	];
}

/** The key of an entry that changes only by being replaced: the same array for every such entry at a revision. */
function replacedEntryKey<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	revision: number,
	task: Extract<ChatMessageEntry, { kind: "task" }> | undefined,
): readonly unknown[] {
	if (task !== undefined) return [state.transcriptRenderSettingsKey, revision, task.task, task.duplicate];
	let key = state.replacedEntryKeys.get(revision);
	if (key === undefined || key[0] !== state.transcriptRenderSettingsKey) {
		key = [state.transcriptRenderSettingsKey, revision];
		state.replacedEntryKeys.set(revision, key);
	}
	return key;
}

function streamingWindowedEntry<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatMessageEntry,
	isStreaming: boolean,
): ChatMessageEntry {
	if (!isStreaming || !state.streamingTailWindowEnabled || state.bodyViewport.getScrollFromBottom() !== 0) {
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
	isStreaming: boolean,
): ChatMessageRenderOptions {
	const inherited = state.getChatRenderSettings?.();
	return {
		...inherited,
		ui: toolTui(state),
		cwd: state.getCwd?.() ?? state.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
		markdownTheme: inherited?.markdownTheme ?? state.getMarkdownTheme?.(),
		isStreaming,
		showImages: inherited?.showImages ?? true,
	};
}

function entryTui<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatMessageEntry,
): Pick<TUI, "requestRender"> {
	return {
		requestRender: () => {
			state.entryRevisions.set(entry, (state.entryRevisions.get(entry) ?? 0) + 1);
			state.requestRender?.();
		},
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
	const markdownTransformersKey =
		inherited?.markdownTransformers?.map((transformer) => renderIdentityKey(state, transformer)).join(",") ?? "";
	return cacheKey([
		"settings",
		inherited?.hideThinkingBlock === true,
		inherited?.hiddenThinkingLabel ?? "",
		inherited?.toolOutputExpanded === true,
		inherited?.showImages !== false,
		inherited?.imageWidthCells ?? null,
		inherited?.outputPad ?? null,
		inherited?.renderLatex !== false,
		markdownTransformersKey,
		state.getCwd?.() ?? state.getAgentSession?.()?.sessionManager.getCwd() ?? process.cwd(),
	]);
}

/** The fields of a local shell entry, which it updates in place as the command prints and finishes. */
function inPlaceKeyParts(entry: ChatMessageEntry): readonly unknown[] {
	if (entry.kind !== "bashExecution") return [];
	return [
		entry.isPartial === true,
		entry.message.command,
		entry.message.output,
		entry.message.exitCode,
		entry.message.cancelled,
		entry.message.truncated,
		entry.message.fullOutputPath,
	];
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
	return new Text(state.style.dim(truncateToWidth(text, Math.max(1, width - 2))), 1, 0).render(width);
}
