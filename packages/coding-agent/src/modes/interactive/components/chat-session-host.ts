import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import type { AgentSessionEvent, CompactionReason } from "../../../core/agent-session.js";
import { repairOrphanToolResults } from "../../../core/messages.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import type { PublishedChatActivity } from "../../../core/session-retry-status.js";
import type { SessionStore } from "../../../core/storage/session/types.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { taskClocksFor } from "../../../core/tasks/live-elapsed.js";
import { getOwnerTaskStore, type OwnerTaskStore, watchOwnerTaskStoreBinding } from "../../../core/tasks/owner-store.js";
import { ownerTaskViewSource, type TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { pickWhimsicalWorkingMessage } from "../whimsical-messages.ts";
import {
	abortChatSessionBash,
	abortChatSessionCompaction,
	interruptChatSession,
	restoreQueuedMessagesToEditor,
	submitChatSession,
} from "./chat-session-host-actions.ts";
import {
	chatSessionEditorAccess,
	createChatSessionEditor,
	handleChatSessionInput,
	hasChatSessionTransientModal,
	setChatSessionEditorText,
} from "./chat-session-host-editor.ts";
import {
	applyChatSessionAgentEvent,
	compactionStatusMessage,
	showChatSessionModelSwitch,
	showChatSessionRetryWait,
} from "./chat-session-host-events.ts";
import {
	chatSessionWorkingMeta,
	dropExpandedOverrides,
	entryExpands,
	entryIsExpanded,
	renderChatSessionBody,
	renderChatSessionEditor,
	renderChatSessionEntry,
	renderChatSessionFooter,
	renderChatSessionPendingMessages,
	renderChatSessionUsage,
	renderChatSessionWorkingStatus,
	restoreChatSessionTokens,
	setExpandedOverride,
	transcriptCacheKey,
	transcriptEntryName,
} from "./chat-session-host-rendering.ts";
import {
	disposeChatSession,
	isChatSessionBashRunning,
	isChatSessionStreaming,
	reassertChatSessionExternalPromptLifecycle,
	settleChatSessionPromptLifecycle,
	startChatSessionExternalPromptLifecycle,
	startChatSessionWorkingLifecycle,
	stopChatSessionWorkingLifecycle,
	syncChatSessionAnimationTick,
} from "./chat-session-host-runtime.ts";
import { ChatSessionHostState, countableTranscriptLength } from "./chat-session-host-state.ts";
import type {
	AgentSnapshotMessage,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionInterruptedTurnSnapshot,
	ChatSessionSubmitMode,
} from "./chat-session-host-types.ts";
import { firstRawUserExactText, syncFirstUserEntry } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { type RetryWaitEvent, retryWaitFromEvent } from "./retry-status-line.ts";
import { isSingleLeftClick } from "./single-click.ts";
import { TaskInspector } from "./task-inspector.js";
import { renderTaskFooter } from "./task-list.js";
import { pagedNotices } from "./task-transcript-notices.ts";
import type { TaskTranscriptEnvironment } from "./task-transcript-page.ts";
import { isClickedGroup } from "./transcript-block-clicks.ts";
import { type AgentTokenMeterSnapshot, type MeteredRunMessage, runInProgress } from "./working-run-meter.ts";

export type {
	ChatSessionHostBashRequest,
	ChatSessionHostCommands,
	ChatSessionHostEntry,
	ChatSessionHostOpts,
	ChatSessionHostStyle,
	ChatSessionInterruptedTurnSnapshot,
	ChatSessionSubmitMode,
	ChatSessionViewportSettings,
} from "./chat-session-host-types.ts";

export class ChatSessionHost<TExtraEntry extends ChatTranscriptEntryLike = never> implements Component, Focusable {
	focused = true;

	private readonly state: ChatSessionHostState<TExtraEntry>;
	private taskStore?: OwnerTaskStore;
	/** What `/tasks` and the task footer show: the session's task store, or the host's own task source. */
	private taskSource?: TaskViewSource;
	private readonly taskRowsInChat: boolean;
	private unsubscribeTasks?: () => void;
	private taskSession?: object;
	private unsubscribeTaskBinding?: () => void;
	private taskInspector?: TaskInspector;
	/** How the last `renderBody` laid out the body: a full-screen task view, or the transcript's rows above a picker. */
	private bodyLayout: { readonly taskView: true } | { readonly taskView: false; readonly transcriptRows: number } = {
		taskView: false,
		transcriptRows: Number.POSITIVE_INFINITY,
	};
	private historyHydrated = false;
	private readonly taskTranscriptEnvironment: () => TaskTranscriptEnvironment;

	constructor(opts: ChatSessionHostOpts<TExtraEntry>) {
		// `/tasks` stays a local action owned by the host's `commands.handleSlashCommand`
		// (see submitChatSession). Hosts that mount the inspector call `openTasks` from
		// that callback; the host must not intercept it ahead of the owner.
		this.taskRowsInChat = opts.taskRowsInChat ?? true;
		// A task transcript opened from this chat is a chat of its own on the same terminal and settings.
		this.taskTranscriptEnvironment = () => ({
			createChat: (transcriptOpts) => new ChatSessionHost(transcriptOpts),
			tui: opts.tui,
			keybindings: opts.keybindings,
			editorTheme: opts.editorTheme,
			editorFactory: opts.editorFactory,
			style: opts.style,
			getChatRenderSettings: opts.getChatRenderSettings,
			footerData: opts.footerData,
			notify: (message) => this.showWarning(message),
		});
		this.state = new ChatSessionHostState(opts, {
			renderEntry: (state, entry) => renderChatSessionEntry(state, entry),
			transcriptCacheKey: (state, entry) => transcriptCacheKey(state, entry),
		});
		this.state.editor = createChatSessionEditor(
			this.state,
			opts.tui,
			opts.keybindings,
			opts.editorTheme,
			opts.editorFactory,
			this.editorCallbacks(),
		);
		if (opts.autocompleteProvider) this.state.editor?.setAutocompleteProvider?.(opts.autocompleteProvider);
		this.syncAnimationTick();
		this.refreshTaskStore();
	}

	openTasks(id?: string): boolean {
		const session = this.state.getAgentSession?.();
		if (session && !getOwnerTaskStore(session)) session.getAgentTaskHost?.();
		this.refreshTaskStore();
		if (!this.taskSource) {
			this.showWarning("Launched agents and shells will appear here.");
			return true;
		}
		this.state.promptSearch = undefined;
		this.taskInspector?.dispose();
		this.taskInspector = new TaskInspector(
			this.taskSource,
			() => this.state.requestRender?.(),
			() => this.closeTasks(),
			undefined,
			() => this.taskTranscriptEnvironment(),
		);
		this.taskInspector.open(id as TaskId | undefined);
		this.state.requestRender?.();
		return true;
	}
	get hasTaskInspector(): boolean {
		return this.taskInspector !== undefined;
	}
	get hasTransientModal(): boolean {
		return hasChatSessionTransientModal(this.state);
	}
	get taskInspectorFullscreen(): boolean {
		return this.taskInspector?.fullscreen === true;
	}
	closeTasks(): void {
		this.taskInspector?.dispose();
		this.taskInspector = undefined;
		this.state.requestRender?.();
	}
	/** Offers input to the open task inspector; false when none is open or it declined the input. */
	handleTaskInput(data: string): boolean {
		return this.taskInspector?.handleInput(data) === true;
	}
	appendMessages(messages: readonly AgentSnapshotMessage[], settledTokens?: AgentTokenMeterSnapshot): void {
		const hadFirstUser = this.state.seenFirstRawUser;
		if (!hadFirstUser && messages.length > 0) {
			const firstUser = firstRawUserExactText(messages);
			if (firstUser.seenUser) {
				this.state.seenFirstRawUser = true;
				this.state.firstUserEntryExactText = firstUser.exactText;
			}
		}
		this.state.liveChat.appendMessages(messages);
		if (!hadFirstUser && this.state.seenFirstRawUser) {
			syncFirstUserEntry(this.state);
		}
		if (settledTokens) restoreChatSessionTokens(this.state, settledTokens);
	}

	/** Earlier history, shown above every entry while a reader scrolled away from the end keeps their place. */
	prependMessages(messages: readonly AgentSnapshotMessage[]): void {
		const firstUser = firstRawUserExactText(messages);
		if (firstUser.seenUser) {
			this.state.seenFirstRawUser = true;
			this.state.firstUserEntryExactText = firstUser.exactText;
		}
		const previousCount = countableTranscriptLength(this.state);
		const notices = pagedNotices.get(this);
		if (notices?.card) this.state.assistantCard = notices.card;
		this.state.liveChat.prependMessages(messages);
		if (firstUser.seenUser || this.state.firstUserEntry === undefined) {
			syncFirstUserEntry(this.state);
		}
		this.state.newMessages.historyPrepended(countableTranscriptLength(this.state) - previousCount);
		this.state.requestRender?.();
	}

	/** Replaces the conversation with `messages`, keeping the host's own extra entries. */
	replaceMessages(messages: readonly AgentSnapshotMessage[], options: { preserveUnread?: boolean } = {}): void {
		if (options.preserveUnread && this.state.bodyViewport.getScrollFromBottom() > 0) {
			this.state.newMessages.observe(false, countableTranscriptLength(this.state));
		}
		const firstUser = firstRawUserExactText(messages);
		this.state.seenFirstRawUser = firstUser.seenUser;
		this.state.firstUserEntryExactText = firstUser.exactText;
		const notices = pagedNotices.get(this);
		if (notices) pagedNotices.set(this.state.transcript, notices);
		this.state.liveChat.replaceMessages(messages, this.state.extraEntries);
		syncFirstUserEntry(this.state);
		if (options.preserveUnread) this.state.newMessages.replaced(countableTranscriptLength(this.state));
		else this.state.newMessages.reset();
		this.state.requestRender?.();
	}

	resetFollowedSession(options?: { readonly preserveWorkedRun?: boolean }): void {
		if (options?.preserveWorkedRun) {
			if (this.state.workedRun === undefined) {
				const snapshot = chatSessionWorkingMeta(this.state);
				if (snapshot !== undefined && !this.state.manualCompactionTakeoverPending) {
					this.state.workedRun = { message: this.state.lastWorkingMessage, snapshot };
				}
			}
		} else {
			this.state.workedRun = undefined;
			this.state.interruptedTurnSnapshot = undefined;
		}
		this.state.workingRunMeter.stop();
		this.state.retryContinuesRun = false;
		this.state.manualCompactionTakeoverPending = false;
		this.state.compacting = false;
		this.state.compactionStartedAt = undefined;
		this.state.sdkBusy = false;
		this.state.workingMessage = undefined;
		this.state.lastWorkingMessage = undefined;
		this.state.seenFirstRawUser = false;
		this.state.firstUserEntryExactText = undefined;
		this.state.firstUserEntry = undefined;
		this.state.statusMessage = "";
		if (this.state.noticeMessage !== this.state.lastWarningMessage) this.state.noticeMessage = "";
		this.state.pendingSteeringMessages = [];
		this.state.pendingFollowUpMessages = [];
		this.state.unconfirmedQueuedMessages = [];
		this.state.liveChat.clearPendingTools();
		this.state.newMessages.reset();
		stopChatSessionWorkingLifecycle(this.state);
		syncChatSessionAnimationTick(this.state);
	}
	/**
	 * Adopt the assistant message a live session is part-way through streaming.
	 *
	 * A host mounted mid-turn missed the `message_start` and every delta that
	 * came before it, and delta-only updates never restate them, so the session's
	 * in-flight message is the only place that text still exists. Ignored once
	 * this host is already following a stream of its own.
	 */
	hydrateStreamingAssistantMessage(message: AgentSnapshotMessage | undefined): void {
		if (message === undefined) return;
		if (this.state.liveChat.hydrateStreamingAssistantMessage(message)) this.state.requestRender?.();
	}

	/**
	 * Shows a saved conversation. A call in `inFlightToolCallIds` has no result yet because its stage waits for one,
	 * so it shows as pending, not as interrupted, and the call's own end replaces it with the result.
	 */
	async loadSession(
		store: SessionStore,
		sessionId: string | undefined,
		inFlightToolCallIds?: ReadonlySet<string>,
	): Promise<boolean> {
		if (
			this.historyHydrated ||
			this.state.transcript.length > this.state.extraEntries.length ||
			sessionId === undefined
		)
			return true;
		let messages: readonly AgentSnapshotMessage[];
		try {
			const manager = await SessionManager.open(store, sessionId, undefined, { history: "tail" });
			messages = repairOrphanToolResults(manager.buildSessionProjection("transcript").messages, {
				repairTrailing: true,
				...(inFlightToolCallIds === undefined ? {} : { inFlightToolCallIds }),
			}) as readonly AgentSnapshotMessage[];
		} catch {
			return false;
		}
		if (this.state.disposed) return false;
		if (this.historyHydrated || this.state.transcript.length > this.state.extraEntries.length) return true;
		this.historyHydrated = true;
		const firstUser = firstRawUserExactText(messages);
		this.state.seenFirstRawUser = firstUser.seenUser;
		this.state.firstUserEntryExactText = firstUser.exactText;
		const previousCount = countableTranscriptLength(this.state);
		const extras = this.state.transcript.splice(0);
		this.state.liveChat.appendMessages(messages);
		this.state.transcript.push(...extras);
		syncFirstUserEntry(this.state);
		this.state.newMessages.historyPrepended(countableTranscriptLength(this.state) - previousCount);
		this.state.requestRender?.();
		return true;
	}

	appendExtraEntry(entry: TExtraEntry): void {
		this.state.extraEntries.push(entry);
		this.state.transcript.push(entry);
	}

	entries(): readonly ChatSessionHostEntry<TExtraEntry>[] {
		return this.state.transcript;
	}

	/** Tasks outlive tools and turns; only host/session binding grants this read projection. */
	refreshTaskStore(): void {
		const session = this.state.getAgentSession?.();
		const sessionChanged = session !== this.taskSession;
		if (sessionChanged) {
			this.unsubscribeTaskBinding?.();
			this.taskSession = session;
			this.unsubscribeTaskBinding = session
				? watchOwnerTaskStoreBinding(session, () => this.refreshTaskStore())
				: undefined;
		}
		const store = session ? getOwnerTaskStore(session) : undefined;
		// A session in another process has no store here; the host
		// supplies a source that reads its tasks there.
		const source = store ? ownerTaskViewSource(store) : this.state.getTaskSource?.();
		if (store === this.taskStore && source === this.taskSource) return;
		this.closeTasks();
		this.unsubscribeTasks?.();
		this.taskStore = store;
		this.taskSource = source;
		this.unsubscribeTasks = undefined;
		this.state.liveChat.clearTasks();
		this.state.transcriptComponent.invalidate();
		this.state.requestRender?.();
		if (!source) return;
		taskClocksFor(source);
		const update = () => {
			// Without task rows the transcript shows nothing of the tasks; only the footer repaints.
			if (this.taskRowsInChat) {
				this.state.liveChat.upsertTasks(source.tasks, store);
				this.state.transcriptComponent.invalidate();
			}
			this.state.requestRender?.();
		};
		this.unsubscribeTasks = source.subscribe(update);
		update();
	}
	applyAgentEvent(event: AgentSessionEvent): boolean {
		this.refreshTaskStore();
		return applyChatSessionAgentEvent(this.state, event);
	}

	hydrateToolExecutionStarts(starts: readonly { readonly toolCallId: string; readonly startedAt: number }[]): void {
		let changed = false;
		for (const start of starts)
			changed = this.state.liveChat.markToolExecutionStarted(start.toolCallId, start.startedAt) || changed;
		if (changed) this.state.requestRender?.();
	}

	/**
	 * Restore the factual compaction indicator on a host mounted after the
	 * `compaction_start` it never saw. The label resolves through the same
	 * mapping the live event path uses, so the two cannot drift.
	 *
	 * Branch summaries deliberately do not paint here: their label belongs to
	 * a retry lifecycle this re-attached host is not inside, and no event exists
	 * to clear it after the summary finishes. An absent paintable reason is a
	 * no-op unless this host is actively showing a compaction label, so unrelated
	 * prompt delivery busy state is preserved.
	 */
	hydrateCompactionStatus(reason: CompactionReason | undefined, startedAt?: number): void {
		const compactionReason = reason === "branchSummary" ? undefined : reason;
		if (compactionReason === undefined) {
			this.state.manualCompactionTakeoverPending = false;
			this.state.compactionStartedAt = undefined;
			if (!this.state.compacting) return;
			this.state.compacting = false;
			this.state.statusMessage = "";
		} else {
			this.state.compacting = true;
			this.state.compactionStartedAt =
				startedAt ??
				this.state.getAgentSession?.()?.compactionStartedAt ??
				this.state.getChatBoxSession?.()?.compactionStartedAt ??
				Date.now();
			this.state.sdkBusy = true;
			this.state.statusMessage = compactionStatusMessage(compactionReason);
		}
		this.syncAnimationTick();
		this.state.requestRender?.();
	}

	/**
	 * Show the retry wait of a session this host attached to after its `auto_retry_start`: a session between two
	 * attempts streams nothing, so a running turn's hydration shows none of it. The wait reads as that event shows it,
	 * with the details of `retry`, the session's pending `auto_retry_start`, when the session has it, and ends as it
	 * does, with the next attempt's `agent_start` or the retry's `auto_retry_end`. With the session's messages, the next
	 * attempt's working line counts from the turn's start, as it does in a chat that saw the turn.
	 */
	hydrateRetryWait(messages?: readonly MeteredRunMessage[], turnStartedAt?: number, retry?: RetryWaitEvent): void {
		if (this.state.disposed) return;
		const run = messages === undefined ? undefined : runInProgress(messages);
		const startedAt = turnStartedAt ?? run?.startedAt;
		if (startedAt !== undefined) {
			this.state.workingRunMeter.awaitRetry(startedAt, run?.settledTokens ?? 0);
			this.state.retryContinuesRun = true;
		}
		showChatSessionRetryWait(this.state, retry === undefined ? undefined : retryWaitFromEvent(retry));
		this.syncAnimationTick();
		this.state.requestRender?.();
	}

	/**
	 * Show the move to a fallback model of a turn whose start (`turnStartedAt`) this host did not see: nothing streams
	 * until the next model's request, which counts from the turn's start, as it does in a chat that saw the turn. A host
	 * that saw the turn's failed request keeps its own count. The move ends as `model_fallback_start` shows it does,
	 * with that request's `agent_start` or the switch's `model_fallback_end`.
	 */
	hydrateModelSwitch(turnStartedAt?: number, messages?: readonly MeteredRunMessage[]): void {
		if (this.state.disposed) return;
		if (turnStartedAt !== undefined && !this.state.retryContinuesRun) {
			this.state.workingRunMeter.awaitRetry(turnStartedAt, messages ? runInProgress(messages).settledTokens : 0);
			this.state.retryContinuesRun = true;
		}
		showChatSessionModelSwitch(this.state);
		this.syncAnimationTick();
		this.state.requestRender?.();
	}

	render(width: number): string[] {
		return this.renderBody(width, 1);
	}

	invalidate(): void {
		this.taskInspector?.invalidate();
		this.state.transcriptComponent.invalidate();
		this.state.bodyViewport.invalidate();
		this.state.editor?.invalidate();
	}

	renderBody(width: number, budget: number): string[] {
		if (this.taskInspector) {
			if (this.taskInspector.fullscreen) {
				this.bodyLayout = { taskView: true };
				return this.taskInspector.renderViewport(width, budget);
			}
			const picker = this.taskInspector.renderPicker(width, budget);
			const remaining = Math.max(0, budget - picker.length);
			const body = remaining ? renderChatSessionBody(this.state, width, remaining) : [];
			this.bodyLayout = { taskView: false, transcriptRows: body.length };
			return [...body, ...Array.from({ length: Math.max(0, remaining - body.length) }, () => ""), ...picker];
		}
		const body = renderChatSessionBody(this.state, width, budget);
		this.bodyLayout = { taskView: false, transcriptRows: body.length };
		return body;
	}

	/**
	 * Rows the body occupies at `width`, whether or not they are on screen.
	 *
	 * Pair with `renderBodyRows` to read the whole transcript, not only the
	 * window the reader is parked on. Both measure the component stack the last
	 * `renderBody` installed, so call them after at least one body render.
	 */
	bodyRowCount(width: number): number {
		return this.state.bodyViewport.rowCount(width);
	}

	/** Body rows `startRow` (inclusive) to `endRow` (exclusive), unscrolled. */
	renderBodyRows(width: number, startRow: number, endRow: number): string[] {
		return this.state.bodyViewport.renderRows(width, startRow, endRow);
	}

	/**
	 * Render a live assistant entry whole, or only its tail (the default).
	 *
	 * The tail window keeps a fast-streaming turn cheap for a reader following
	 * the bottom of the body; it also drops everything above the last 240 lines
	 * from what `bodyRowCount` and `renderBodyRows` report. Returns whether the
	 * setting changed, so the caller can invalidate the rows that were rendered
	 * under the old rule.
	 */
	setStreamingTailWindowEnabled(enabled: boolean): boolean {
		if (this.state.streamingTailWindowEnabled === enabled) return false;
		this.state.streamingTailWindowEnabled = enabled;
		this.invalidate();
		return true;
	}

	renderPendingMessages(width: number): string[] {
		return renderChatSessionPendingMessages(this.state, width);
	}

	renderWorkingStatus(width: number, published?: PublishedChatActivity): string[] {
		return renderChatSessionWorkingStatus(this.state, width, published);
	}

	renderUsage(width: number): string[] {
		return renderChatSessionUsage(this.state, width);
	}

	/**
	 * The one row between the chat's working status and its composer: the usage meter, or a blank row when the chat has
	 * no usage to show, so the status never sits on the composer's top rule and the transcript never runs into it.
	 */
	renderUsageRow(width: number): string[] {
		const usage = this.renderUsage(width);
		return usage.length > 0 ? usage : [""];
	}

	renderEditor(width: number): string[] {
		return renderChatSessionEditor(this.state, width, this.focused);
	}

	hasBackgroundTasks(): boolean {
		return (this.taskSource?.backgroundTasks.length ?? 0) > 0;
	}

	private footerTaskSource(): TaskViewSource | undefined {
		const agent = this.state.getAgentSession?.();
		const session = agent ?? this.state.getChatBoxSession?.();
		const store = session && getOwnerTaskStore(session);
		return (
			(agent ? undefined : this.state.getTaskSource?.()) ?? (store ? ownerTaskViewSource(store) : this.taskSource)
		);
	}

	renderTaskFooter(width: number): string[] {
		const source = this.footerTaskSource();
		return source ? renderTaskFooter(source, width) : [];
	}
	renderFooter(width: number, navigationActive = false): string[] {
		const footer = renderChatSessionFooter(
			this.state,
			() => this.footerTaskSource(),
			width,
			navigationActive || (this.hasTaskInspector && !this.taskInspectorFullscreen),
		);
		return footer.length ? footer : this.renderTaskFooter(width);
	}

	handleScrollInput(data: string): boolean {
		return this.state.bodyViewport.handleInput(data);
	}

	handleInput(data: string): boolean {
		return handleChatSessionInput(this.state, data, this.editorCallbacks());
	}

	interrupt(options?: { restoreQueuedMessages?: boolean }): Promise<void> {
		// Keep the observed settlement: an async wrapper would orphan rejections from Escape callers.
		return interruptChatSession(this.state, options);
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

	/**
	 * A single click at row `event.y` of the body the last `renderBody` drew: on any row of a block it expands or
	 * collapses that block, or a group summary and its calls, once the click cannot become a double-click. Expanding
	 * while the body follows its end holds the view where it is, so the block stays under the pointer.
	 */
	handleBodyClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!isSingleLeftClick(event)) return undefined;
		const layout = this.bodyLayout;
		// A task's transcript the chat shows full-screen takes the click into its own transcript.
		if (layout.taskView) return this.taskInspector?.handleMouse(event);
		// While the prompt search or a completion menu owns input, a click on the transcript does nothing.
		if (event.y >= layout.transcriptRows || hasChatSessionTransientModal(this.state)) return undefined;
		const state = this.state;
		const hit = state.bodyViewport.componentAtRow(event.y);
		if (hit === undefined || hit.component !== state.transcriptComponent) return undefined;
		const clicked = state.transcriptComponent.clickedEntries(hit.width, hit.row);
		if (clicked === undefined) return undefined;
		// The entries are drawn again with the click's expansion.
		const expandEntries = (entries: readonly ChatSessionHostEntry<TExtraEntry>[], expand: boolean) => {
			for (const entry of entries) {
				setExpandedOverride(state, entry, expand);
				state.entryRevisions.set(entry, (state.entryRevisions.get(entry) ?? 0) + 1);
			}
			const first = state.bodyViewport.firstVisibleRow();
			if (expand && state.bodyViewport.getScrollFromBottom() === 0 && first !== undefined) {
				state.bodyViewport.scrollTo(first);
			}
			state.requestRender?.();
		};
		// The blocks as drawn may be redrawn by the time the click settles, by another click on them among others: the
		// entries are asked then how they are drawn and whether they change, and a group always changes as its calls
		// fold or show.
		const generation = state.expansionGeneration;
		const target = transcriptEntryName(state, clicked.target);
		return {
			handled: true,
			whenSingleClick: () => {
				if (
					state.disposed ||
					this.bodyLayout.taskView ||
					generation !== state.expansionGeneration ||
					(state.getChatRenderSettings?.()?.toolOutputExpanded === true) !== state.expandedOverridesFor
				)
					return;
				const entry = state.transcript.find((item) => transcriptEntryName(state, item) === target);
				if (!entry) return;
				const width = state.bodyViewport.paintedContentWidth;
				const group = state.transcriptComponent.currentClickGroup(width, entry);
				const head = group?.entries[0];
				if (group && head && (isClickedGroup(group.blocks) || entryExpands(state, head, width))) {
					expandEntries(group.entries, !entryIsExpanded(state, head));
				}
			},
		};
	}

	/**
	 * Ctrl+O was pressed: every block follows the tool-output setting again, including those a click set, in this
	 * chat and in the task transcript it shows.
	 */
	toolOutputToggled(): void {
		dropExpandedOverrides(this.state);
		this.taskInspector?.toolOutputToggled();
		this.invalidate();
	}

	/**
	 * What the last `renderBody` drew on `row`: the transcript entry there and the row within it, or what the task
	 * transcript the chat shows drew there. Undefined for rows outside a transcript.
	 */
	bodyRowKey(row: number): string | undefined {
		const layout = this.bodyLayout;
		if (layout.taskView) return this.taskInspector?.paintedRowKey(row);
		if (row < 0 || row >= layout.transcriptRows) return undefined;
		const state = this.state;
		const hit = state.bodyViewport.componentAtRow(row);
		if (hit === undefined || hit.component !== state.transcriptComponent) return undefined;
		const drawn = state.transcriptComponent.paintedEntryAt(hit.width, hit.row);
		return drawn === undefined
			? undefined
			: `${state.expansionGeneration}:${transcriptEntryName(state, drawn.entry)}#${drawn.row}`;
	}

	bodyMaxScroll(): number {
		return this.state.bodyViewport.getMaxScroll();
	}

	inputText(): string {
		return this.state.inputBuffer;
	}
	/** Whether the cursor is at the very start of the prompt, so ← there leaves the chat and keeps what is typed. */
	inputCursorAtStart(): boolean {
		if (this.state.inputBuffer.length === 0) return true;
		const cursor = chatSessionEditorAccess(this.state).getCursor?.();
		return cursor !== undefined && cursor.line === 0 && cursor.col === 0;
	}
	setInputText(text: string): void {
		setChatSessionEditorText(this.state, text);
	}

	statusText(): string {
		return this.state.noticeMessage || this.state.statusMessage;
	}

	showWarning(message: string): void {
		this.state.noticeMessage = message;
		this.state.lastWarningMessage = message;
		this.state.requestRender?.();
	}

	scrollToBottom(): void {
		this.state.bodyViewport.scrollToBottom();
	}

	/**
	 * Park the body with absolute row `row` at the top of its window, clamped
	 * to the last rendered layout. Used to reveal a search match the reader
	 * cannot currently see.
	 */
	scrollBodyTo(row: number): void {
		this.state.bodyViewport.scrollTo(row);
	}

	syncAnimationTick(): void {
		syncChatSessionAnimationTick(this.state);
	}

	snapshotInterruptedTurn(): ChatSessionInterruptedTurnSnapshot | undefined {
		const snapshot = chatSessionWorkingMeta(this.state);
		const now = Date.now();
		const startedAt = snapshot !== undefined ? now - snapshot.elapsedMs : undefined;
		const settledTokens = snapshot?.tokens ?? 0;
		const lastWorkingMessage = this.state.lastWorkingMessage ?? this.state.workingMessage;
		const workedRun = snapshot !== undefined ? { message: lastWorkingMessage, snapshot } : this.state.workedRun;
		if (startedAt === undefined && workedRun === undefined && lastWorkingMessage === undefined) {
			return this.state.interruptedTurnSnapshot;
		}
		if (workedRun !== undefined) {
			this.state.workedRun = workedRun;
		}
		const captured: ChatSessionInterruptedTurnSnapshot = {
			startedAt,
			settledTokens,
			lastWorkingMessage,
			workedRun,
		};
		this.state.interruptedTurnSnapshot = captured;
		return captured;
	}

	restoreInterruptedTurn(
		interrupted: ChatSessionInterruptedTurnSnapshot | undefined,
		options?: { readonly resumeMeterForAgentEnd?: boolean },
	): void {
		this.state.interruptedTurnSnapshot = interrupted;
		if (!interrupted) return;
		if (options?.resumeMeterForAgentEnd && interrupted.startedAt !== undefined) {
			const elapsedAtInterrupt = interrupted.workedRun?.snapshot.elapsedMs;
			const startedAt = elapsedAtInterrupt !== undefined ? Date.now() - elapsedAtInterrupt : interrupted.startedAt;
			this.state.workingRunMeter.resume(startedAt, interrupted.settledTokens, false);
			if (this.state.lastWorkingMessage === undefined) {
				this.state.lastWorkingMessage = interrupted.lastWorkingMessage;
			}
			return;
		}
		if (interrupted.workedRun !== undefined) {
			this.state.workedRun = interrupted.workedRun;
		}
	}

	workedRunSnapshot(): ChatSessionInterruptedTurnSnapshot["workedRun"] {
		return this.state.workedRun;
	}

	/**
	 * Start Working for an accepted prompt delivered outside this host. Returns the
	 * lifecycle token to hand back to `settleExternalPromptLifecycle`.
	 */
	beginExternalPromptLifecycle(): number | undefined {
		return startChatSessionExternalPromptLifecycle(this.state);
	}

	/**
	 * Show the turn a session runs now, read from its `messages` and the answer it `streaming`s. A turn that went on in
	 * this session after it moved from another model counts from `turnStartedAt`, its first request's start, which
	 * this session's messages do not hold.
	 */
	hydrateRunningTurn(
		messages: readonly MeteredRunMessage[],
		streaming?: MeteredRunMessage,
		turnStartedAt?: number,
		requestSide?: boolean,
	): void {
		if (this.state.disposed) return;
		if (!this.state.workingLifecycleActive) startChatSessionWorkingLifecycle(this.state);
		if (this.state.workingRunMeter.snapshot() === undefined) {
			const run = runInProgress(messages, streaming);
			this.state.workingRunMeter.resume(
				turnStartedAt ?? run.startedAt,
				run.settledTokens,
				requestSide ?? run.requesting,
			);
			if (streaming !== undefined) this.state.workingRunMeter.streaming(streaming);
		}
		if (this.state.workingMessage === undefined) {
			this.state.workingMessage = pickWhimsicalWorkingMessage();
			this.state.lastWorkingMessage = this.state.workingMessage;
		}
		syncChatSessionAnimationTick(this.state);
		this.state.requestRender?.();
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
		this.taskInspector?.dispose();
		this.unsubscribeTasks?.();
		this.unsubscribeTaskBinding?.();
		disposeChatSession(this.state);
	}

	restoreQueuedMessagesToEditor(): boolean {
		return restoreQueuedMessagesToEditor(this.state);
	}

	private editorCallbacks(): {
		submit: (mode: "auto" | "followUp", submittedText?: string) => void | Promise<void>;
		restoreQueuedMessagesToEditor: () => boolean;
		abortCompaction: () => void | Promise<void>;
		interrupt: (options?: { restoreQueuedMessages?: boolean }) => void | Promise<void>;
		abortBash: () => void | Promise<void>;
	} {
		return {
			submit: (mode, submittedText) => this.submit(mode, submittedText),
			restoreQueuedMessagesToEditor: () => this.restoreQueuedMessagesToEditor(),
			abortCompaction: () => abortChatSessionCompaction(this.state),
			interrupt: (options) => this.interrupt(options),
			abortBash: () => abortChatSessionBash(this.state),
		};
	}
}
