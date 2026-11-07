import type {
	Component,
	EditorComponent,
	EditorTheme,
	MarkdownTheme,
	ScrollViewScrollbar,
	TUI,
	WheelScrollLines,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { BashResult } from "../../../core/bash-executor.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { ChatMessageEntry, ChatMessageRenderOptions } from "./chat-message-renderer.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";

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
}

/** Body viewport settings a host inherits, named after the fullscreen settings they come from. */
export interface ChatSessionViewportSettings {
	/** Rows per mouse-wheel event, or `"auto"` to follow wheel velocity. */
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
	/** `"auto"`, `"always"` or `"hidden"` scrollbar beside the body. */
	readonly fullscreenScrollbar?: ScrollViewScrollbar;
}

export interface ChatSessionHostOpts<TExtraEntry extends ChatTranscriptEntryLike = never> {
	style: ChatSessionHostStyle;
	commands?: ChatSessionHostCommands;
	requestRender?: () => void;
	getAgentSession?: () => AgentSession | undefined;
	/**
	 * The session's messages when `getAgentSession` has no session in this process, such as a workflow
	 * stage on a local worker: a compaction redraws the transcript from them.
	 */
	getSessionMessages?: () => AgentSession["messages"] | undefined;
	/**
	 * Tasks to show when `getAgentSession` has no task store in this process: the tasks of a session
	 * that runs elsewhere, such as a workflow stage on a local worker.
	 */
	getTaskSource?: () => TaskViewSource | undefined;
	/** Custom hosts may retain live task rows; interactive stage chat uses footer-only status. */
	taskRowsInChat?: boolean;
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
	editorFactory?: (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;
	autocompleteProvider?: import("@earendil-works/pi-tui").AutocompleteProvider;
	editorTheme: EditorTheme;
	getChatRenderSettings?: () =>
		| (Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> & ChatSessionViewportSettings)
		| undefined;
	/** Called when the body shows rows within one viewport of its top, so earlier history can load. */
	onNearTop?: () => void;
	getCwd?: () => string;
	footerData?: ReadonlyFooterDataProvider;
	renderExtraEntry?: (entry: TExtraEntry) => Component;
}

export type ChatSessionHostEntry<TExtraEntry extends ChatTranscriptEntryLike = never> = ChatMessageEntry | TExtraEntry;

export type AgentSnapshotMessage = AgentSession["messages"][number];
export type CacheKeyPart = string | number | boolean | null;
