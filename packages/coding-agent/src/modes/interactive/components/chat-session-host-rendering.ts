import type { AssistantMessage } from "@bastani/atomic-ai";
import { type Component, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { PublishedChatActivity } from "../../../core/session-retry-status.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskSession, getOwnerTaskStore } from "../../../core/tasks/owner-store.js";
import {
	type ChatBoxSession,
	loadTaskOwnTranscriptHistory,
	taskTranscriptSource,
} from "../../../core/tasks/supervisor.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { getToolExecutionStartedAt } from "../../../core/tool-execution-timing.ts";
import {
	AtomicWorkedStatusComponent,
	DEFAULT_WORKING_MESSAGE,
	workingMessageColumns,
} from "./atomic-working-status.ts";
import {
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	renderHostedChatEntry,
} from "./chat-message-renderer.ts";
import {
	hasChatSessionTransientModal,
	setEditorBorderColor,
	setEditorFocused,
	setEditorPlaceholder,
	syncChatSessionPromptSearch,
} from "./chat-session-host-editor.ts";
import { isChatSessionStreaming } from "./chat-session-host-runtime.ts";
import {
	CHAT_SESSION_RETRYING_STATUS,
	CHAT_SESSION_SWITCHING_MODEL_STATUS,
	type ChatSessionHostState,
	isChatSessionBusyStatus,
	isChatSessionRetryStatus,
} from "./chat-session-host-state.ts";
import type { ChatSessionHostEntry } from "./chat-session-host-types.ts";
import { cacheKey, isChatMessageEntry, stripAnsi, tailStreamingText } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { FooterComponent, UsageMeterComponent } from "./footer.ts";
import { clickableKeyTextHint } from "./nav-keys.ts";
import { disposeRenderer } from "./renderer-disposal.js";
import { retrySecondsLeft, retryWaitMessage } from "./retry-status-line.ts";
import { taskDisplayText } from "./task-row.js";
import { toolGroupRoleKey } from "./tool-group-tracker.ts";
import { isClickExpandableBlock, sameRows, withBlockRenderTime } from "./transcript-block-clicks.ts";
import {
	AgentTokenMeter,
	type AgentTokenMeterSnapshot,
	agentTokenTotal,
	compactionMeta,
	type WorkingRunSnapshot,
} from "./working-run-meter.ts";
import { WorkingStatusComponent } from "./working-status.ts";

export function renderChatSessionBody<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
	budget: number,
): string[] {
	const components: Component[] = [];
	state.liveChat.setGroupBash(state.getChatRenderSettings?.()?.groupBash ?? true);
	hydrateToolExecutionStarts(state);
	// Kept as the same string while it is unchanged, so every entry's key compares it by reference.
	const settingsKey = chatRenderSettingsCacheKey(state);
	if (settingsKey !== state.transcriptRenderSettingsKey) state.transcriptRenderSettingsKey = settingsKey;
	// Ctrl+O sets every block, including those a click expanded or collapsed. A view that takes Ctrl+O itself drops
	// the clicks' choices on each press; a setting changed elsewhere drops them once it is seen to change.
	const toolsExpanded = state.getChatRenderSettings?.()?.toolOutputExpanded === true;
	if (state.expandedOverridesFor !== toolsExpanded) {
		state.expandedOverridesFor = toolsExpanded;
		dropExpandedOverrides(state);
	}
	if (state.transcript.length > 0) {
		components.push(state.transcriptComponent);
	}
	// A notice or an error follows the transcript; work under way is the working line above the prompt instead.
	if (state.statusMessage && !state.compacting && !isChatSessionBusyStatus(state.statusMessage)) {
		components.push(new Spacer(1));
		components.push(new Text(state.style.dim(state.statusMessage), 2, 0));
	}
	if (state.noticeMessage) {
		components.push(new Spacer(1));
		components.push(new Text(state.style.dim(state.noticeMessage), 2, 0));
	}
	state.bodyViewport.setVisibleRows(budget);
	state.bodyViewport.setComponents(components);
	return state.bodyViewport.render(width);
}

function hydrateToolExecutionStarts<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
	if (session === undefined) return;
	for (const toolCallId of state.liveChat.pendingToolIds()) {
		const startedAt = getToolExecutionStartedAt(session, toolCallId);
		if (startedAt !== undefined) state.liveChat.markToolExecutionStarted(toolCallId, startedAt);
	}
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

interface TranscriptTokenCache {
	firstEntry: ChatTranscriptEntryLike | undefined;
	lastSettledEntry: ChatTranscriptEntryLike | undefined;
	settledCount: number;
	meter: AgentTokenMeter;
}

const transcriptTokenCaches = new WeakMap<object, TranscriptTokenCache>();

/** Start at the session's settled count; subsequent live messages are counted normally. */
export function restoreChatSessionTokens<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	snapshot: AgentTokenMeterSnapshot,
): void {
	transcriptTokenCaches.set(state, {
		firstEntry: state.transcript[0],
		lastSettledEntry: state.transcript.at(-1),
		settledCount: state.transcript.length,
		meter: new AgentTokenMeter([], snapshot),
	});
}

function readTranscriptTokens<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): { readonly settledTokens: number; readonly streamingTokens: number } {
	let cache = transcriptTokenCaches.get(state);
	if (
		!cache ||
		state.transcript.length < cache.settledCount ||
		state.transcript[0] !== cache.firstEntry ||
		(cache.settledCount > 0 && state.transcript[cache.settledCount - 1] !== cache.lastSettledEntry)
	) {
		cache = {
			firstEntry: state.transcript[0],
			lastSettledEntry: undefined,
			settledCount: 0,
			meter: new AgentTokenMeter(),
		};
		transcriptTokenCaches.set(state, cache);
	}
	let streaming: AssistantMessage | undefined;
	let sawStreaming = false;
	for (let index = cache.settledCount; index < state.transcript.length; index += 1) {
		const entry = state.transcript[index]!;
		if (isChatMessageEntry(entry) && entry.kind === "assistant") {
			if (state.liveChat.isStreamingAssistantEntry(entry)) {
				streaming = entry.message;
				sawStreaming = true;
				continue;
			}
			if (!sawStreaming) {
				cache.meter.settled(entry.message);
			}
		}
		if (!sawStreaming) {
			if (cache.settledCount === 0) cache.firstEntry = state.transcript[0];
			cache.settledCount = index + 1;
			cache.lastSettledEntry = entry;
		}
	}
	return {
		settledTokens: cache.meter.total(),
		streamingTokens: streaming === undefined ? 0 : agentTokenTotal([], streaming),
	};
}

export function chatSessionTokenCount<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): number {
	const { settledTokens, streamingTokens } = readTranscriptTokens(state);
	const counted = state.workingTokenCount?.();
	if (counted !== undefined && counted > 0) return counted + streamingTokens;
	return settledTokens + streamingTokens;
}

export function chatSessionWorkingMeta<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): WorkingRunSnapshot | undefined {
	const snapshot = state.workingRunMeter.snapshot();
	return snapshot === undefined ? undefined : { ...snapshot, tokens: chatSessionTokenCount(state) };
}

const publishedWorkingMessages = {
	working: DEFAULT_WORKING_MESSAGE,
	retrying: CHAT_SESSION_RETRYING_STATUS,
	switching: CHAT_SESSION_SWITCHING_MODEL_STATUS,
} satisfies Record<Exclude<PublishedChatActivity, "idle">, string>;

/**
 * The working line of work that waits between turns: a retry, a model switch or a resume. A retry this chat saw start,
 * or read from its session, counts down to its next attempt, and names the key that cancels it where Esc does; it fits
 * a line `width` columns wide.
 */
function chatSessionBusyMessage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	published: Exclude<PublishedChatActivity, "idle"> | undefined,
	width: number,
): string {
	const status = published === undefined ? state.statusMessage : publishedWorkingMessages[published];
	if (!isChatSessionRetryStatus(status)) return status;
	const wait = (state.statusMessage === status ? state.retryWait : undefined) ?? {};
	// Only the chat's owner knows whether its Esc reaches the retry; a summary is not part of the turn Esc interrupts.
	const cancellable = wait.subject !== "summary" && state.canCancelRetry?.() === true;
	const cancel = cancellable
		? clickableKeyTextHint(state.getActionKeyDisplay?.("app.interrupt") ?? "esc", " cancel")
		: undefined;
	return retryWaitMessage(wait, retrySecondsLeft(wait), cancel, workingMessageColumns(width));
}

export function renderChatSessionWorkingStatus<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	width: number,
	published?: PublishedChatActivity,
): string[] {
	const palette = state.style.workingIndicatorPalette;
	const useCallerStyling =
		!palette && state.style.workingIndicatorUseGlobalTheme !== true && process.env.NO_COLOR === undefined;
	// A retry, a model switch or a resume waits between turns; it is the chat's working line until the work resumes.
	// The worker attempt can retire without sending a final session event to a chat that stayed open.
	if (published === "idle") return [];
	if (!state.compacting && (published !== undefined || isChatSessionBusyStatus(state.statusMessage))) {
		return new WorkingStatusComponent({
			frame: state.workingFrame,
			message: chatSessionBusyMessage(state, published, width),
			palette,
			spinnerColor: useCallerStyling ? (text) => state.style.accent(text) : undefined,
			spinnerBoldColor: useCallerStyling ? (text) => state.style.accentBold(text) : undefined,
			messageColor: (text) => state.style.textMuted(text),
		}).render(width);
	}
	if (!isChatSessionStreaming(state)) {
		// A notice or an error follows the transcript, so the ended turn's row stays beside it, as in the main chat.
		const worked = state.workedRun;
		if (worked === undefined || state.workingLifecycleActive || state.compacting) return [];
		return new AtomicWorkedStatusComponent({
			message: worked.message,
			snapshot: worked.snapshot,
			color: (text) => state.style.dim(text),
		}).render(width);
	}
	if (state.statusMessage && !state.compacting) return [];
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
		message: state.workingMessage ?? DEFAULT_WORKING_MESSAGE,
		meta: chatSessionWorkingMeta(state),
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
	if (syncChatSessionPromptSearch(state)) return state.promptSearch!.render(width);
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
	taskSource: () => TaskViewSource | undefined,
	width: number,
	navigationActive = false,
): string[] {
	if (state.disposed) return [];
	const agentSession = state.getAgentSession?.();
	const session = agentSession ?? state.getChatBoxSession?.();
	state.footerNavigationActive = navigationActive || agentSession === undefined || hasChatSessionTransientModal(state);
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
			taskSource,
		);
		state.footer.setSession(session);
		return state.footer.render(width);
	}
	state.footer?.dispose();
	state.footer = undefined;
	return [];
}

const HEADER_PROMPT_ECHO_PREFIX_CELLS = 3;

function resolveEchoedInitialPrompt<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): string | undefined {
	const raw =
		typeof state.echoedInitialPrompt === "function" ? state.echoedInitialPrompt() : state.echoedInitialPrompt;
	return raw !== undefined && raw.length > 0 ? raw : undefined;
}

export function fitsSingleLineHeaderEcho(prompt: string, width: number): boolean {
	if (width <= HEADER_PROMPT_ECHO_PREFIX_CELLS) return false;
	if (/[\r\n\u2028\u2029]/u.test(prompt)) return false;
	const displayed = taskDisplayText(prompt);
	if (displayed.length === 0) return false;
	return HEADER_PROMPT_ECHO_PREFIX_CELLS + visibleWidth(displayed) <= width;
}

class EchoedInitialPromptComponent implements Component {
	private readonly inner: Component;
	private readonly prompt: string;

	constructor(inner: Component, prompt: string) {
		this.inner = inner;
		this.prompt = prompt;
	}

	render(width: number): string[] {
		return fitsSingleLineHeaderEcho(this.prompt, width) ? [] : this.inner.render(width);
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/** The key a click's expansion is kept under for a tool call: its call id, which outlives the replaced entry objects. */
function toolCallKey<TExtraEntry extends ChatTranscriptEntryLike>(
	entry: ChatSessionHostEntry<TExtraEntry>,
): string | undefined {
	return isChatMessageEntry(entry) && entry.kind === "tool" ? `tool:${entry.toolCallId}` : undefined;
}

/** Whether a click expanded (true) or collapsed (false) `entry`, or undefined when the chat's setting applies. */
export function expandedOverride<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
): boolean | undefined {
	const key = toolCallKey(entry);
	return key === undefined ? state.expandedEntryOverrides.get(entry) : state.expandedOverrides.get(key);
}

/** Forgets which blocks a click expanded or collapsed, so every block follows the chat's tool-output setting. */
export function dropExpandedOverrides<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.expansionGeneration++;
	state.expandedOverrides = new Map();
	state.expandedEntryOverrides = new WeakMap();
}

/** A name for `entry` that a repaint keeps: a tool call's id, which outlives its replaced entry objects, or the entry's. */
export function transcriptEntryName<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
): string {
	return toolCallKey(entry) ?? `entry:${renderIdentityKey(state, entry)}`;
}

export function setExpandedOverride<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
	expanded: boolean,
): void {
	const key = toolCallKey(entry);
	if (key === undefined) state.expandedEntryOverrides.set(entry, expanded);
	else state.expandedOverrides.set(key, expanded);
}

/**
 * Draws `entry`. `expanded` is the expansion a click chose for it, which then differs from the chat's tool-output
 * setting; it defaults to the one the chat keeps for the entry.
 */
export function renderChatSessionEntry<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
	expanded = expandedOverride(state, entry),
): Component {
	if (state.extraEntries.includes(entry as TExtraEntry)) {
		return state.renderExtraEntry?.(entry as TExtraEntry, expanded) ?? new Text("", 0, 0);
	}
	if (isChatMessageEntry(entry)) {
		const isStreaming = isChatSessionStreaming(state) && state.liveChat.isStreamingAssistantEntry(entry);
		const options =
			expanded === undefined
				? chatMessageRenderOptions(state, isStreaming)
				: { ...chatMessageRenderOptions(state, isStreaming), toolOutputExpanded: expanded };
		const component = renderHostedChatEntry(
			streamingWindowedEntry(state, entry, isStreaming),
			entry.kind === "tool" || entry.kind === "custom" ? { ...options, ui: entryTui(state, entry) } : options,
			state.assistantCard,
		);
		const echoed = resolveEchoedInitialPrompt(state);
		if (
			entry.kind === "user" &&
			state.firstUserEntry === entry &&
			echoed !== undefined &&
			state.firstUserEntryExactText === echoed
		) {
			return new EchoedInitialPromptComponent(component, echoed);
		}
		return component;
	}
	if (!state.renderExtraEntry) {
		return new Text("", 0, 0);
	}
	return state.renderExtraEntry(entry, expanded);
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
	if (!streaming && (message === undefined || (message.kind !== "bashExecution" && message.kind !== "tool"))) {
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
		cwd:
			state.getCwd?.() ??
			state.getAgentSession?.()?.sessionManager?.getCwd() ??
			state.getChatBoxSession?.()?.sessionManager?.getCwd() ??
			process.cwd(),
		markdownTheme: inherited?.markdownTheme ?? state.getMarkdownTheme?.(),
		isStreaming,
		showImages: inherited?.showImages ?? true,
		groupBash: inherited?.groupBash ?? true,
		getToolDefinition: (toolName: string) => {
			const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
			return (
				session?.extensionRunner?.resolveToolRenderers?.(toolName, () => session.getToolDefinition?.(toolName)) ??
				session?.getToolDefinition?.(toolName) ??
				inherited?.getToolDefinition?.(toolName)
			);
		},
		getCustomMessageRenderer: (customType: string) => {
			const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
			const taskSource = state.getTaskSource?.();
			const owner =
				taskSource === undefined ? undefined : (getOwnerTaskSession(taskSource) as ChatBoxSession | undefined);
			return (
				session?.extensionRunner?.getMessageRenderer?.(customType) ??
				inherited?.getCustomMessageRenderer?.(customType) ??
				owner?.extensionRunner?.getMessageRenderer?.(customType)
			);
		},
		getTaskRecord: (taskId: TaskId) => {
			const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
			const store = session === undefined ? undefined : getOwnerTaskStore(session);
			return store?.getTask(taskId) ?? inherited?.getTaskRecord?.(taskId);
		},
		hasTaskTranscript: (taskId: TaskId) => {
			const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
			const store = session === undefined ? undefined : getOwnerTaskStore(session);
			const lease = store?.resolveTask(taskId);
			if (lease?.ok && taskTranscriptSource(lease.value).ok) return true;
			return inherited?.hasTaskTranscript?.(taskId) ?? false;
		},
		loadTaskTranscript: async (taskId: TaskId) => {
			const session = state.getAgentSession?.() ?? state.getChatBoxSession?.();
			const store = session === undefined ? undefined : getOwnerTaskStore(session);
			const lease = store?.resolveTask(taskId);
			if (lease?.ok) return loadTaskOwnTranscriptHistory(lease.value);
			return inherited?.loadTaskTranscript?.(taskId);
		},
	};
}

function entryTui<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatMessageEntry,
): Pick<TUI, "requestRender"> {
	return {
		requestRender: () => {
			state.transcriptComponent.requestEntryRender(entry);
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
	const taskSource = state.getTaskSource?.();
	const owner = taskSource === undefined ? undefined : (getOwnerTaskSession(taskSource) as ChatBoxSession | undefined);
	return cacheKey([
		"settings",
		inherited?.hideThinkingBlock === true,
		inherited?.hiddenThinkingLabel ?? "",
		inherited?.toolOutputExpanded === true,
		inherited?.showImages !== false,
		inherited?.imageWidthCells ?? null,
		inherited?.outputPad ?? null,
		inherited?.renderLatex !== false,
		inherited?.groupBash ?? true,
		markdownTransformersKey,
		state.getCwd?.() ?? state.getAgentSession?.()?.sessionManager?.getCwd() ?? process.cwd(),
		owner?.sessionManager?.getSessionId?.() ?? "",
		resolveEchoedInitialPrompt(state) ?? "",
		state.firstUserEntryExactText ?? "",
		state.firstUserEntry === undefined ? "" : renderIdentityKey(state, state.firstUserEntry),
	]);
}

/** The fields of an entry it updates in place: a local shell entry's output, a tool entry's start and group. */
function inPlaceKeyParts(entry: ChatMessageEntry): readonly unknown[] {
	if (entry.kind === "tool") {
		return [
			entry.argsComplete === true,
			entry.executionStarted === true,
			entry.startedAt,
			toolGroupRoleKey(entry.groupRole),
		];
	}
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

/** Whether `entry` draws other rows at `width` expanded than collapsed: whether it has anything to expand. */
export function entryExpands<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
	width: number,
): boolean {
	const rows = (expanded: boolean): string[] => {
		const component = renderChatSessionEntry(state, entry, expanded);
		try {
			return component.render(width);
		} finally {
			disposeRenderer(component);
		}
	};
	return withBlockRenderTime(() => !sameRows(rows(false), rows(true)));
}

/** Whether `entry` is drawn expanded now: as a click last set it, or else as the chat's setting draws it. */
export function entryIsExpanded<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: ChatSessionHostEntry<TExtraEntry>,
): boolean {
	const component = renderChatSessionEntry(state, entry);
	try {
		return isClickExpandableBlock(component) && component.isExpanded();
	} finally {
		disposeRenderer(component);
	}
}
