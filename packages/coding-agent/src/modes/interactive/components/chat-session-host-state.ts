import type { Component, EditorComponent, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import type { AgentSession, SessionStats } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { LiveChatEntriesController } from "./chat-message-renderer.ts";
import type {
	ChatSessionHostCommands,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionHostStyle,
} from "./chat-session-host-types.ts";
import {
	ChatTranscriptComponent,
	type ChatTranscriptEntryLike,
	ScrollableComponentViewport,
} from "./chat-transcript.ts";

export interface ChatSessionHostStateCallbacks<TExtraEntry extends ChatTranscriptEntryLike> {
	renderEntry: (state: ChatSessionHostState<TExtraEntry>, entry: ChatSessionHostEntry<TExtraEntry>) => Component;
	transcriptCacheKey: (
		state: ChatSessionHostState<TExtraEntry>,
		entry: ChatSessionHostEntry<TExtraEntry>,
		index: number,
	) => string;
}

export class ChatSessionHostState<TExtraEntry extends ChatTranscriptEntryLike = never> {
	readonly style: ChatSessionHostStyle;
	readonly commands: ChatSessionHostCommands;
	readonly requestRender: (() => void) | undefined;
	readonly getAgentSession: (() => AgentSession | undefined) | undefined;
	readonly getSessionStats: (() => SessionStats | undefined) | undefined;
	readonly isStreamingOverride: (() => boolean) | undefined;
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
	readonly renderExtraEntry: ((entry: TExtraEntry) => Component) | undefined;
	readonly tui: TUI | undefined;

	inputBuffer = "";
	transcript: ChatSessionHostEntry<TExtraEntry>[] = [];
	extraEntries: TExtraEntry[] = [];
	statusMessage = "";
	isBashMode = false;
	localBashRunning = false;
	sdkBusy = false;
	/** Escape interrupt plus asynchronous workflow pause acknowledgement. */
	interruptSettlement: Promise<void> | undefined;
	/** Recorded pause failure consumed by the first submit after settlement. */
	interruptFailureMessage: string | undefined;
	workingMessage: string | undefined;
	workingFrame = 0;
	workingLifecycleActive: boolean;
	workingLifecycleGeneration = 0;
	immediateEventRenderPending = false;
	disposed = false;
	pendingSteeringMessages: readonly string[] = [];
	pendingFollowUpMessages: readonly string[] = [];
	compactionQueuedMessages: readonly string[] = [];
	compacting = false;
	/** Keeps input queued while automatic compaction hands off to a manual request. */
	manualCompactionTakeoverPending = false;
	animationTimer: ReturnType<typeof setInterval> | undefined;
	renderThrottleTimer: ReturnType<typeof setTimeout> | undefined;
	bodyViewport = new ScrollableComponentViewport();
	transcriptComponent: ChatTranscriptComponent<ChatSessionHostEntry<TExtraEntry>>;
	transcriptRenderSettingsKey = "";
	renderIdentityIds = new WeakMap<object, number>();
	nextRenderIdentityId = 1;
	liveChat: LiveChatEntriesController;
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

	constructor(opts: ChatSessionHostOpts<TExtraEntry>, callbacks: ChatSessionHostStateCallbacks<TExtraEntry>) {
		this.style = opts.style;
		this.commands = opts.commands ?? {};
		this.requestRender = opts.requestRender;
		this.getAgentSession = opts.getAgentSession;
		this.getSessionStats = opts.getSessionStats;
		this.isStreamingOverride = opts.isStreaming;
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
		this.tui = opts.tui;
		this.liveChat = new LiveChatEntriesController(this.transcript);
		this.transcriptComponent = new ChatTranscriptComponent(
			this.transcript,
			(entry) => callbacks.renderEntry(this, entry),
			(entry, index) => callbacks.transcriptCacheKey(this, entry, index),
		);
	}
}
