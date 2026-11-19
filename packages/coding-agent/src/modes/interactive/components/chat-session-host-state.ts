import type { Component, EditorComponent, MarkdownTheme, TUI } from "@bastani/atomic-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { ChatBoxSession } from "../../../core/tasks/supervisor.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { rowSource, savedRowKey, savedSeqOf, savedTaskRowKey } from "../../../core/tasks/transcript-origin.js";
import { theme } from "../theme/theme.js";
import { atomicWorkingFrame } from "./atomic-working-status.ts";
import { type ChatMessageEntry, LiveChatEntriesController } from "./chat-message-renderer.ts";
import type {
	ChatSessionHostCommands,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionHostStyle,
	ChatSessionInterruptedTurnSnapshot,
	ChatSessionSubmitMode,
} from "./chat-session-host-types.ts";
import {
	type ChatTranscriptCacheKeyValue,
	ChatTranscriptComponent,
	type ChatTranscriptEntryLike,
	ScrollableComponentViewport,
} from "./chat-transcript.js";
import type { FooterComponent } from "./footer.ts";
import { NewMessageCounter, pinnedPromptLine } from "./jump-to-latest.ts";
import { keyText } from "./keybinding-hints.js";
import type { ParkedTaskRows } from "./parked-rows.ts";
import { disposeRenderer } from "./renderer-disposal.js";
import { SavedRendererInstances } from "./saved-renderer-instances.js";
import { TranscriptFollowIndicator } from "./transcript-follow-indicator.ts";
import { WorkingRunMeter, type WorkingRunSnapshot } from "./working-run-meter.ts";

/** The chat's status while work it started is still under way; the chat shows it as its working line. */
export const CHAT_SESSION_RESUMING_STATUS = "resuming…";
export const CHAT_SESSION_RETRYING_STATUS = "retrying…";
export const CHAT_SESSION_SWITCHING_MODEL_STATUS = "switching model…";
export const CHAT_SESSION_RETRYING_SUMMARY_STATUS = "retrying summary…";
const BUSY_STATUS_MESSAGES: ReadonlySet<string> = new Set([
	CHAT_SESSION_RESUMING_STATUS,
	CHAT_SESSION_RETRYING_STATUS,
	CHAT_SESSION_SWITCHING_MODEL_STATUS,
	CHAT_SESSION_RETRYING_SUMMARY_STATUS,
]);

/** Whether a status message stands for work under way rather than a notice or an error for the transcript. */
export function isChatSessionBusyStatus(message: string): boolean {
	return BUSY_STATUS_MESSAGES.has(message);
}
export interface ChatSessionHostStateCallbacks<TExtraEntry extends ChatTranscriptEntryLike> {
	renderEntry: (state: ChatSessionHostState<TExtraEntry>, entry: ChatSessionHostEntry<TExtraEntry>) => Component;
	transcriptCacheKey: (
		state: ChatSessionHostState<TExtraEntry>,
		entry: ChatSessionHostEntry<TExtraEntry>,
		index: number,
	) => ChatTranscriptCacheKeyValue;
}

export class ChatSessionHostState<TExtraEntry extends ChatTranscriptEntryLike = never> {
	/** Only a mounted task with a split failed reply needs a specialized assistant card. */
	declare assistantCard?: typeof import("./assistant-message.ts").AssistantMessageComponent;
	readonly style: ChatSessionHostStyle;
	readonly commands: ChatSessionHostCommands;
	readonly requestRender: (() => void) | undefined;
	readonly getAgentSession: (() => AgentSession | undefined) | undefined;
	readonly getChatBoxSession: (() => ChatBoxSession | undefined) | undefined;
	readonly getSessionMessages: (() => AgentSession["messages"] | undefined) | undefined;
	readonly getSessionContextMeter: ChatSessionHostOpts<TExtraEntry>["getSessionContextMeter"];
	readonly getPromptEntries: ChatSessionHostOpts<TExtraEntry>["getPromptEntries"];
	readonly getTaskSource: (() => TaskViewSource | undefined) | undefined;
	readonly echoedInitialPrompt: string | (() => string | undefined) | undefined;
	readonly isStreamingOverride: (() => boolean) | undefined;
	readonly workingTokenCount: (() => number | undefined) | undefined;
	readonly isPaused: (() => boolean) | undefined;
	readonly isDisabled: (() => boolean) | undefined;
	readonly isBashRunningOverride: (() => boolean) | undefined;
	readonly showWarning: ((message: string) => void) | undefined;
	readonly showStatus: ((message: string) => void) | undefined;
	readonly actions: Record<string, () => void | Promise<void>> | undefined;
	readonly getActionKeyDisplay: ((action: string) => string) | undefined;
	readonly getMarkdownTheme: (() => MarkdownTheme) | undefined;
	readonly getChatRenderSettings: ChatSessionHostOpts<TExtraEntry>["getChatRenderSettings"];
	readonly getCwd: (() => string) | undefined;
	readonly footerData: ReadonlyFooterDataProvider | undefined;
	readonly renderExtraEntry: ((entry: TExtraEntry, expanded?: boolean) => Component) | undefined;
	readonly countsAsMessage: ((entry: TExtraEntry) => boolean) | undefined;
	readonly tui: TUI | undefined;

	footer: FooterComponent | undefined;
	footerNavigationActive = false;
	inputBuffer = "";
	promptSearch: (Component & { handleInput(data: string): void }) | undefined;
	transcript: ChatSessionHostEntry<TExtraEntry>[] = [];
	extraEntries: TExtraEntry[] = [];
	statusMessage = "";
	/** A delivery notice belongs beside the transcript, independently of the turn's working line. */
	noticeMessage = "";
	/** Explicit diagnostics survive busy-state cleanup, but are not restored after later input. */
	lastWarningMessage: string | undefined;
	isBashMode = false;
	localBashRunning = false;
	sdkBusy = false;
	/** Escape interrupt plus asynchronous workflow pause acknowledgement. */
	interruptSettlement: Promise<void> | undefined;
	/** Recorded pause failure consumed by the first submit after settlement. */
	interruptFailureMessage: string | undefined;
	workingMessage: string | undefined;
	lastWorkingMessage: string | undefined = undefined;
	workedRun: { readonly message: string | undefined; readonly snapshot: WorkingRunSnapshot } | undefined = undefined;
	interruptedTurnSnapshot: ChatSessionInterruptedTurnSnapshot | undefined = undefined;
	seenFirstRawUser = false;
	firstUserEntryExactText: string | undefined = undefined;
	firstUserEntry: Extract<ChatMessageEntry, { kind: "user" }> | undefined = undefined;
	get workingFrame(): number {
		return atomicWorkingFrame();
	}
	set workingFrame(_value: number) {}
	readonly newMessages = new NewMessageCounter();
	compactionStartedAt: number | undefined;
	readonly workingRunMeter = new WorkingRunMeter();
	/** A retry or a model fallback this host saw start waits for the next attempt, which continues the turn's run. */
	retryContinuesRun = false;
	workingLifecycleActive: boolean;
	workingLifecycleGeneration = 0;
	disposed = false;
	pendingSteeringMessages: readonly string[] = [];
	pendingFollowUpMessages: readonly string[] = [];
	/** Messages sent while the agent works that its queue does not list yet; shown as queued from submit (#4696). */
	unconfirmedQueuedMessages: readonly { text: string; mode: "steer" | "followUp" }[] = [];
	compactionQueuedMessages: readonly { text: string; mode: ChatSessionSubmitMode }[] = [];
	/** True while compaction-queued messages are being sent one at a time. */
	compactionFlushPending = false;
	/** Resolves the pending compaction-queue prompt when its run starts. */
	compactionPromptStarted: (() => void) | undefined;
	compacting = false;
	/** Keeps input queued while automatic compaction hands off to a manual request. */
	manualCompactionTakeoverPending = false;
	animationTimer: ReturnType<typeof setInterval> | undefined;
	stopAnimationClock: (() => void) | undefined;
	metaTimer: ReturnType<typeof setInterval> | undefined;
	bodyViewport: ScrollableComponentViewport;
	transcriptComponent: ChatTranscriptComponent<ChatSessionHostEntry<TExtraEntry>>;
	transcriptRenderSettingsKey = "";
	renderIdentityIds = new WeakMap<object, number>();
	/** Bumped when a rendered entry redraws itself (a tool renderer's `invalidate`), so its cached rows are rebuilt. */
	entryRevisions = new WeakMap<object, number>();
	/**
	 * Entries a click expanded or collapsed, which then differ from the chat's tool-output setting. A tool call is kept
	 * by its call id, because live output replaces its entry object; other entries by the entry itself.
	 */
	expandedOverrides = new Map<string, boolean>();
	expansionGeneration = 0;
	expandedEntryOverrides = new WeakMap<object, boolean>();
	/** The tool-output setting the overrides were made against; changing it (Ctrl+O) drops them. */
	expandedOverridesFor: boolean | undefined;
	/** The cache key shared by entries that change only by being replaced, per revision, under the current settings. */
	readonly replacedEntryKeys = new Map<number, readonly unknown[]>();
	nextRenderIdentityId = 1;
	liveChat: LiveChatEntriesController;
	readonly savedRenderers?: SavedRendererInstances;
	readonly liveRowOrigin: ((seq: number) => string | undefined) | undefined;
	/** The component each row drew, for keeping a stateful one when its row is retired. Weak: rows own nothing. */
	private readonly renderedRows = new WeakMap<object, Component>();
	editor: EditorComponent | undefined;
	optimisticUserSignatureCounts = new Map<string, number>();
	/**
	 * Whether an assistant entry still streaming into a sticky-bottom body is
	 * rendered as its tail alone.
	 *
	 * On by default: while the reader is following a live stream, the rows far
	 * above the cursor cost layout work nobody is reading.
	 */
	streamingTailWindowEnabled = true;

	replaceTranscriptWindow(
		messages: Parameters<LiveChatEntriesController["replaceMessages"]>[0],
		parked?: ParkedTaskRows,
	): void {
		const previous = [...this.transcript];
		this.liveChat.replaceMessages(messages, this.extraEntries);
		if (parked) this.liveChat.keepParkedEntries(parked.rows, parked.adopted, savedRowKey);
		this.keepRetiredRenderers(previous);
		this.releaseRetiredRows();
	}

	/** The saved-page key of a row: its page's origin, or a live row's from its save receipt. */
	rowKey(entry: object): string | undefined {
		const saved = savedTaskRowKey(entry);
		if (saved !== undefined || this.liveRowOrigin === undefined) return saved;
		const source = rowSource(entry);
		const seq = savedSeqOf(source?.message);
		const origin = seq === undefined ? undefined : this.liveRowOrigin(seq);
		return origin === undefined ? undefined : `${origin}:0:${source!.part}`;
	}

	/** A retired row's stateful renderer stays the instance its saved row shows when it is read again. */
	keepRetiredRenderers(previous: readonly object[]): void {
		const store = this.savedRenderers;
		if (!store) return;
		const current = new Set<object>(this.transcript);
		for (const entry of previous) {
			if (current.has(entry)) continue;
			const component = this.renderedRows.get(entry);
			const key = component && this.rowKey(entry);
			if (key && !store.get(key)?.includes(component)) store.remember(key, [component]);
		}
	}

	releaseRetiredRows(): void {
		const retained = new Set(this.transcript);
		this.bodyViewport.retainSegmentAnchors(this.transcriptComponent, retained);
		this.transcriptComponent.releaseRetired(retained);
		this.replacedEntryKeys.clear();
		if (this.expandedOverrides.size) {
			const tools = new Set(
				this.transcript.flatMap((entry) =>
					"kind" in entry && entry.kind === "tool" && "toolCallId" in entry ? [entry.toolCallId] : [],
				),
			);
			for (const key of this.expandedOverrides.keys()) if (!tools.has(key)) this.expandedOverrides.delete(key);
		}
	}

	constructor(opts: ChatSessionHostOpts<TExtraEntry>, callbacks: ChatSessionHostStateCallbacks<TExtraEntry>) {
		this.style = opts.style;
		this.commands = opts.commands ?? {};
		this.bodyViewport = new ScrollableComponentViewport(opts.keybindings, {
			wheelScrollLines: () => this.getChatRenderSettings?.()?.fullscreenWheelScrollLines,
			scrollbar: () => this.getChatRenderSettings?.()?.fullscreenScrollbar,
			scrollbarThumbStyle: (text) => theme.bg("scrollbarThumb", text),
			followIndicator: new TranscriptFollowIndicator({
				isFollowing: () => false,
				keyLabel: () => followIndicatorKeyLabel(opts.keybindings),
				newCount: () => this.newMessages.count,
			}),
			observeFollowing: (following) => this.newMessages.observe(following, countableTranscriptLength(this)),
			pinnedPrompt: pinnedPromptLine,
			requestRender: () => this.requestRender?.(),
			onNearTop: () => opts.onNearTop?.(),
			onNearBottom: () => opts.onNearBottom?.(),
		});
		this.requestRender = opts.requestRender;
		this.getAgentSession = opts.getAgentSession;
		this.getChatBoxSession = opts.getChatBoxSession;
		this.getSessionMessages = opts.getSessionMessages;
		this.getSessionContextMeter = opts.getSessionContextMeter;
		this.getPromptEntries = opts.getPromptEntries;
		this.getTaskSource = opts.getTaskSource;
		this.echoedInitialPrompt = opts.echoedInitialPrompt;
		this.isStreamingOverride = opts.isStreaming;
		this.workingTokenCount = opts.workingTokenCount;
		this.workingLifecycleActive = opts.isStreaming?.() === true;
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
		this.countsAsMessage = opts.countsAsMessage;
		this.tui = opts.tui;
		this.liveChat = new LiveChatEntriesController(this.transcript);
		const store = opts.savedTaskPages ? new SavedRendererInstances() : undefined;
		this.savedRenderers = store;
		this.liveRowOrigin = store ? opts.liveRowOrigin : undefined;
		this.transcriptComponent = new ChatTranscriptComponent(
			this.transcript,
			(entry) => {
				const key = store && this.rowKey(entry);
				const kept = key && store?.get(key)?.[0];
				if (kept) {
					this.renderedRows.set(entry, kept);
					return kept;
				}
				const component = callbacks.renderEntry(this, entry);
				if (store) this.renderedRows.set(entry, component);
				if (key) store?.remember(key, [component]);
				return component;
			},
			(entry, index) => callbacks.transcriptCacheKey(this, entry, index),
			store
				? (component) => {
						if (component && !store.protect(component)) disposeRenderer(component);
					}
				: undefined,
		);
	}
}

/** The jump-to-latest label names the host's own `tui.altScreen.bottom` keys, falling back to the global ones. */
function followIndicatorKeyLabel(keybindings: unknown): string {
	const getKeys = (keybindings as { getKeys?: (action: "tui.altScreen.bottom") => readonly string[] } | undefined)
		?.getKeys;
	return typeof getKeys === "function"
		? getKeys.call(keybindings, "tui.altScreen.bottom").join("/")
		: keyText("tui.altScreen.bottom");
}

export function extraEntryCountsAsMessage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	entry: TExtraEntry,
): boolean {
	if (state.countsAsMessage !== undefined) return state.countsAsMessage(entry);
	return (entry as { readonly role?: unknown }).role !== "notice";
}

export function countableTranscriptLength<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): number {
	let excluded = 0;
	for (const entry of state.extraEntries) {
		if (!extraEntryCountsAsMessage(state, entry)) excluded += 1;
	}
	for (const entry of state.transcript) {
		if ("kind" in entry && entry.kind === "task") excluded += 1;
	}
	return Math.max(0, state.transcript.length - excluded);
}
