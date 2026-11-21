import type {
	Component,
	EditorComponent,
	EditorTheme,
	MarkdownTheme,
	ScrollViewScrollbar,
	TUI,
	WheelScrollLines,
} from "@bastani/atomic-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { BashResult } from "../../../core/bash-executor.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { ChatBoxSession } from "../../../core/tasks/supervisor.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { ChatMessageEntry, ChatMessageRenderOptions } from "./chat-message-renderer.ts";
import type { ChatSteeringTarget } from "./chat-session-host-steering.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import type { sessionPromptsFromEntries } from "./prompt-history-selector.ts";
import type { AgentTokenMeterSnapshot, WorkingRunSnapshot } from "./working-run-meter.ts";

export interface ChatSessionInterruptedTurnSnapshot {
	readonly startedAt: number | undefined;
	readonly settledTokens: number;
	readonly lastWorkingMessage: string | undefined;
	readonly workedRun: { readonly message: string | undefined; readonly snapshot: WorkingRunSnapshot } | undefined;
}

export interface ChatSessionHostStyle {
	dim(text: string): string;
	text(text: string): string;
	textMuted(text: string): string;
	accent(text: string): string;
	accentBold(text: string): string;
	workingIndicatorPalette?: () => {
		dark: string;
		lift: string;
		muted: string;
		accent: string;
		bright: string;
		peak: string;
	};
	/** Use Atomic's live global theme when the host shares the interactive theme proxy. */
	workingIndicatorUseGlobalTheme?: boolean;
	rule(hex: string, text: string): string;
	cursor(): string;
	blank(width: number): string;
	editorRuleColor(disabled: boolean, agentSession: AgentSession | undefined, state?: { isBashMode: boolean }): string;
}

export interface ChatSessionHostBashRequest {
	command: string;
	excludeFromContext: boolean;
	onChunk: (chunk: string) => void;
}

/**
 * Which key produced one submission. `auto` is Enter; `followUp` is the
 * explicit follow-up binding. The mode travels with the submission so a host
 * whose idle `prompt` command has to pick a delivery queue reads this
 * invocation's intent rather than shared state a concurrent submission owns.
 */
export type ChatSessionSubmitMode = "auto" | "followUp";

export interface ChatSessionHostCommands {
	ensureAttached?: () => Promise<void>;
	prompt?: (text: string, mode: ChatSessionSubmitMode) => Promise<void>;
	/** Host-owned admission route, used instead of raw SDK streaming shortcuts. */
	submitUserMessage?: (text: string, mode: ChatSessionSubmitMode) => Promise<void>;
	steer?: (text: string) => Promise<void>;
	followUp?: (text: string) => Promise<void>;
	interrupt?: () => Promise<void>;
	resume?: (message?: string, mode?: ChatSessionSubmitMode) => Promise<void>;
	runBash?: (request: ChatSessionHostBashRequest) => Promise<BashResult>;
	abortBash?: () => void | Promise<void>;
	abortCompaction?: () => void | Promise<void>;
	handleSlashCommand?: (text: string) => Promise<boolean> | boolean;
	/**
	 * Delivers every submission through a channel whose recipient records the message itself, such as a task's
	 * Intercom target. Set, it replaces prompt, steering, follow-up, compaction queueing and `!` commands: the text is
	 * sent as typed, the chat shows no optimistic copy, and a rejection restores the draft and shows its message.
	 */
	send?: (text: string, mode: ChatSessionSubmitMode) => Promise<void>;
}

/** Body viewport settings a host inherits, named after the fullscreen settings they come from. */
export interface ChatSessionViewportSettings {
	/** Rows per mouse-wheel event, or `"auto"` to follow wheel velocity. */
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
	/** `"auto"`, `"always"` or `"hidden"` scrollbar beside the body. */
	readonly fullscreenScrollbar?: ScrollViewScrollbar;
}

export interface ChatSessionHostOpts<TExtraEntry extends ChatTranscriptEntryLike = never> {
	/** @internal First-party task transcripts can recreate only the renderers that opted into it. */
	readonly savedTaskPages?: true;
	/**
	 * @internal Where a live row whose message was saved at `seq` appears in the transcript's saved pages, as their row
	 * origin; `undefined` while that is not known. A stateful renderer instance keeps it when the row is retired.
	 */
	readonly liveRowOrigin?: (seq: number) => string | undefined;
	style: ChatSessionHostStyle;
	commands?: ChatSessionHostCommands;
	/**
	 * @internal The agent this chat steers as the main chat steers its own session (a subagent's chat): Enter steers and
	 * the follow-up key queues a follow-up while the agent works, each shown as a queued row until the agent takes it, and
	 * the dequeue key takes every queued message back to the editor. Set, it takes the place of `commands.prompt`,
	 * `steer`, `followUp` and `send`; `commands.handleSlashCommand` still runs the chat's own commands first.
	 */
	steering?: ChatSteeringTarget;
	/**
	 * @internal Messages taken back from the agent's queue for the editor after the chat was closed: kept, steering
	 * first, for the reader's next draft in this chat. Without it they are dropped with the chat.
	 */
	keepRestoredMessages?: (messages: readonly string[]) => void;
	requestRender?: () => void;
	getAgentSession?: () => AgentSession | undefined;
	/**
	 * The usage meter's and footer's session when `getAgentSession` has none: a task's live session, which the chat
	 * shows without owning it. It never makes the chat the session's host (no task owner, interrupt or compaction).
	 */
	getChatBoxSession?: () => ChatBoxSession | undefined;
	/**
	 * The session's messages when `getAgentSession` has no session in this process: a compaction redraws the transcript from them.
	 */
	getSessionMessages?: () => AgentSession["messages"] | undefined;
	/** Metering baseline when compaction replaces the displayed history with a new session snapshot. */
	getSessionContextMeter?: (displayed: readonly AgentSnapshotMessage[]) => AgentTokenMeterSnapshot | undefined;
	getPromptEntries?: () => Parameters<typeof sessionPromptsFromEntries>[0] | undefined;
	/**
	 * Tasks to show when `getAgentSession` has no task store in this process: the tasks of a session
	 * that runs elsewhere.
	 */
	getTaskSource?: () => TaskViewSource | undefined;
	/**
	 * A block the chat shows after its transcript, as a message of its own: a blank row above it, and it scrolls with the
	 * transcript. Asked on every render; `undefined` shows nothing.
	 */
	transcriptEndBlock?: () => Component | undefined;
	/** Custom hosts may retain live task rows; interactive subagent chats use footer-only status. */
	taskRowsInChat?: boolean;
	echoedInitialPrompt?: string | (() => string | undefined);
	isStreaming?: () => boolean;
	workingTokenCount?: () => number | undefined;
	isPaused?: () => boolean;
	isDisabled?: () => boolean;
	isBashRunning?: () => boolean;
	/** Whether Esc now cancels the retry the chat waits on, so its working line names the key. Without it, none. */
	canCancelRetry?: () => boolean;
	showWarning?: (message: string) => void;
	showStatus?: (message: string) => void;
	actions?: Record<string, () => void | Promise<void>>;
	getActionKeyDisplay?: (action: string) => string;
	getMarkdownTheme?: () => MarkdownTheme;
	tui?: TUI;
	keybindings?: unknown;
	editorFactory?: (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;
	autocompleteProvider?: import("@bastani/atomic-tui").AutocompleteProvider;
	editorTheme: EditorTheme;
	getChatRenderSettings?: () =>
		| (Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> & ChatSessionViewportSettings)
		| undefined;
	/** Called when the body shows rows within one viewport of its top, so earlier history can load. */
	onNearTop?: () => void;
	/** A saved transcript may also have an evicted page below the one on screen. */
	onNearBottom?: () => void;
	getCwd?: () => string;
	footerData?: ReadonlyFooterDataProvider;
	/**
	 * Draws an entry the host does not know. `expanded` is set when a click expanded or collapsed this entry, which then
	 * differs from the chat's tool-output setting.
	 */
	renderExtraEntry?: (entry: TExtraEntry, expanded?: boolean) => Component;
	countsAsMessage?: (entry: TExtraEntry) => boolean;
}

export type ChatSessionHostEntry<TExtraEntry extends ChatTranscriptEntryLike = never> = ChatMessageEntry | TExtraEntry;

export type AgentSnapshotMessage = AgentSession["messages"][number];
export type CacheKeyPart = string | number | boolean | null;
