import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { repairOrphanToolResults } from "../../../core/messages.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import {
	abortChatSessionBash,
	abortChatSessionCompaction,
	interruptChatSession,
	restoreQueuedMessagesToEditor,
	submitChatSession,
} from "./chat-session-host-actions.ts";
import {
	createChatSessionEditor,
	handleChatSessionInput,
	setChatSessionEditorText,
} from "./chat-session-host-editor.ts";
import { applyChatSessionAgentEvent } from "./chat-session-host-events.ts";
import {
	renderChatSessionBody,
	renderChatSessionEditor,
	renderChatSessionEntry,
	renderChatSessionFooter,
	renderChatSessionPendingMessages,
	renderChatSessionUsage,
	renderChatSessionWorkingStatus,
	transcriptCacheKey,
} from "./chat-session-host-rendering.ts";
import {
	clearChatSessionBusyForTerminalWorkflowStage,
	disposeChatSession,
	isChatSessionBashRunning,
	isChatSessionStreaming,
	reassertChatSessionExternalPromptLifecycle,
	settleChatSessionPromptLifecycle,
	startChatSessionExternalPromptLifecycle,
	syncChatSessionAnimationTick,
} from "./chat-session-host-runtime.ts";
import { ChatSessionHostState } from "./chat-session-host-state.ts";
import type {
	AgentSnapshotMessage,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionSubmitMode,
} from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";

export type {
	ChatSessionHostBashRequest,
	ChatSessionHostCommands,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionHostStyle,
	ChatSessionSubmitMode,
} from "./chat-session-host-types.ts";

export class ChatSessionHost<TExtraEntry extends ChatTranscriptEntryLike = never> implements Component, Focusable {
	focused = true;

	private readonly state: ChatSessionHostState<TExtraEntry>;

	constructor(opts: ChatSessionHostOpts<TExtraEntry>) {
		this.state = new ChatSessionHostState(opts, {
			renderEntry: (state, entry) => renderChatSessionEntry(state, entry),
			transcriptCacheKey: (state, entry, index) => transcriptCacheKey(state, entry, index),
		});
		this.state.editor = createChatSessionEditor(
			this.state,
			opts.tui,
			opts.keybindings,
			opts.editorTheme,
			opts.editorFactory,
			this.editorCallbacks(),
		);
		this.syncAnimationTick();
	}

	appendMessages(messages: readonly AgentSnapshotMessage[]): void {
		this.state.liveChat.appendMessages(messages);
	}

	loadSessionFile(sessionFile: string | undefined): void {
		if (this.state.transcript.length > 0 || sessionFile === undefined) return;
		let messages: readonly AgentSnapshotMessage[];
		try {
			messages = repairOrphanToolResults(SessionManager.open(sessionFile).buildSessionContext().messages, {
				repairTrailing: true,
			}) as readonly AgentSnapshotMessage[];
		} catch {
			return;
		}
		this.state.liveChat.appendMessages(messages);
	}

	appendExtraEntry(entry: TExtraEntry): void {
		this.state.extraEntries.push(entry);
		this.state.transcript.push(entry);
	}

	entries(): readonly ChatSessionHostEntry<TExtraEntry>[] {
		return this.state.transcript;
	}

	applyAgentEvent(event: AgentSessionEvent): boolean {
		return applyChatSessionAgentEvent(this.state, event);
	}

	render(width: number): string[] {
		return this.renderBody(width, 1);
	}

	invalidate(): void {
		this.state.transcriptComponent.invalidate();
		this.state.bodyViewport.invalidate();
		this.state.editor?.invalidate();
	}

	renderBody(width: number, budget: number): string[] {
		return renderChatSessionBody(this.state, width, budget);
	}

	renderPendingMessages(width: number): string[] {
		return renderChatSessionPendingMessages(this.state, width);
	}

	renderWorkingStatus(width: number): string[] {
		return renderChatSessionWorkingStatus(this.state, width);
	}

	renderUsage(width: number): string[] {
		return renderChatSessionUsage(this.state, width);
	}

	renderEditor(width: number): string[] {
		return renderChatSessionEditor(this.state, width, this.focused);
	}

	renderFooter(width: number): string[] {
		return renderChatSessionFooter(this.state, width);
	}

	handleScrollInput(data: string): boolean {
		return this.state.bodyViewport.handleInput(data);
	}

	handleInput(data: string): boolean {
		return handleChatSessionInput(this.state, data, this.editorCallbacks());
	}

	async interrupt(): Promise<void> {
		await interruptChatSession(this.state);
	}

	async submit(mode: ChatSessionSubmitMode = "auto", submittedText?: string): Promise<void> {
		await submitChatSession(this.state, mode, submittedText);
	}

	isStreaming(): boolean {
		return isChatSessionStreaming(this.state);
	}

	isBashRunning(): boolean {
		return isChatSessionBashRunning(this.state);
	}

	isEditingBashCommand(): boolean {
		return this.state.isBashMode;
	}

	isCompacting(): boolean {
		return this.state.compacting;
	}

	hasInputText(): boolean {
		return this.state.inputBuffer.length > 0;
	}

	hasAnimationTick(): boolean {
		return this.state.animationTimer !== undefined;
	}

	bodyScrollFromBottom(): number {
		return this.state.bodyViewport.getScrollFromBottom();
	}

	bodyMaxScroll(): number {
		return this.state.bodyViewport.getMaxScroll();
	}

	inputText(): string {
		return this.state.inputBuffer;
	}
	setInputText(text: string): void {
		setChatSessionEditorText(this.state, text);
	}

	statusText(): string {
		return this.state.statusMessage;
	}

	scrollToBottom(): void {
		this.state.bodyViewport.scrollToBottom();
	}

	syncAnimationTick(): void {
		syncChatSessionAnimationTick(this.state);
	}

	clearBusyForTerminalWorkflowStage(): void {
		clearChatSessionBusyForTerminalWorkflowStage(this.state);
	}

	/**
	 * Start Working for an accepted prompt delivered outside this host — a
	 * workflow definition auto-sending to its own retained stage. Returns the
	 * lifecycle token to hand back to `settleExternalPromptLifecycle`.
	 */
	beginExternalPromptLifecycle(): number | undefined {
		return startChatSessionExternalPromptLifecycle(this.state);
	}

	/**
	 * Reopen Working for a delivery still active after a temporary overlay — a
	 * pre-turn compaction — cleared it. Preserves factual status text.
	 */
	reassertExternalPromptLifecycle(): number | undefined {
		return reassertChatSessionExternalPromptLifecycle(this.state);
	}

	/** Settle a lifecycle from `beginExternalPromptLifecycle`. Stale tokens no-op. */
	settleExternalPromptLifecycle(generation: number | undefined): void {
		settleChatSessionPromptLifecycle(this.state, generation);
		syncChatSessionAnimationTick(this.state);
		this.state.requestRender?.();
	}

	dispose(): void {
		disposeChatSession(this.state);
	}

	restoreQueuedMessagesToEditor(): boolean {
		return restoreQueuedMessagesToEditor(this.state);
	}

	private editorCallbacks(): {
		submit: (mode: "auto" | "followUp", submittedText?: string) => void | Promise<void>;
		restoreQueuedMessagesToEditor: () => boolean;
		abortCompaction: () => void | Promise<void>;
		interrupt: () => void | Promise<void>;
		abortBash: () => void | Promise<void>;
	} {
		return {
			submit: (mode, submittedText) => this.submit(mode, submittedText),
			restoreQueuedMessagesToEditor: () => this.restoreQueuedMessagesToEditor(),
			abortCompaction: () => abortChatSessionCompaction(this.state),
			interrupt: () => this.interrupt(),
			abortBash: () => abortChatSessionBash(this.state),
		};
	}
}
