import {
	type AgentSessionEvent,
	ChatSessionHost,
	type ChatSessionInterruptedTurnSnapshot,
	classifyChatCommand,
	type ReadonlyFooterDataProvider,
} from "@bastani/atomic";
import { Editor, type EditorComponent } from "@bastani/atomic-tui";
import { stageChatHistory, stageWaitsToRetry } from "../runs/foreground/stage-control-registry.js";
import { isPooledStageStarting, pooledStageStartingText } from "../shared/stage-display-status.js";
import { type StageUiBroker, stageUiBroker } from "../shared/stage-ui-broker.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import { readGraphStoreRun, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import { createPromptCardState } from "./prompt-card.js";
import { resolveStageChatViewportRows } from "./stage-chat-layout.js";
import { stageSkillAutocomplete, submitStageSkillCommand } from "./stage-chat-skill-commands.js";
import { hideMountedCustomUi, releaseMountedCustomUi, showCustomUi } from "./stage-chat-view-custom-ui.js";
import {
	invalidateStageChatDeliveryLifecycles,
	subscribeStageChatDeliveryActivity,
} from "./stage-chat-view-delivery-activity.js";
import { applyStageChatLiveHandleEvent } from "./stage-chat-view-live-events.js";
import { replayPendingToolExecutions } from "./stage-chat-view-pending-tools.js";
import {
	editorThemeFromGraphTheme,
	setEditorBorderColor,
	setEditorPlaceholder,
} from "./stage-chat-view-render-helpers.js";
import { chatHostStyle, stageChatRenderSettings } from "./stage-chat-view-render-settings.js";
import {
	isTerminalOrNonStreamingStageChatStatus,
	isTerminalStageChatState,
	isTerminalStageChatTransition,
} from "./stage-chat-view-status.js";
import { noticeRow, noticeSummary, stageNoticeCountsAsMessage } from "./stage-chat-view-transcript.js";
import {
	HEADER_ROWS,
	isReadOnlyArchiveStatus,
	type NoticeEntry,
	SEP_ROWS,
	type StageChatDetachMetadata,
	type StageChatViewContext,
	type StageChatViewOpts,
	VIEW_LINE_COUNT,
} from "./stage-chat-view-types.js";

export function initializeStageChatView(ctx: StageChatViewContext, opts: StageChatViewOpts): void {
	ctx.store = opts.store;
	ctx.sessionStore = opts.sessionStore;
	ctx.theme = opts.graphTheme;
	ctx.runId = opts.runId;
	ctx.stageId = opts.stageId;
	ctx.workflowName = opts.workflowName;
	ctx.handle = opts.handle;
	ctx.postMortemUnavailableReason = opts.postMortemUnavailableReason;
	ctx.onDetach = opts.onDetach;
	ctx.onClose = opts.onClose;
	ctx.requestRender = opts.requestRender;
	ctx.requestFocus = opts.requestFocus;
	ctx.focusHoldTimer = undefined;
	ctx.promptCountdownTimer = undefined;
	ctx.piTui = opts.piTui;
	ctx.piTheme = opts.piTheme;
	ctx.piKeybindings = opts.piKeybindings;
	ctx.piEditorFactory = opts.piEditorFactory;
	let localToolsExpanded = false;
	ctx.getToolsExpanded = opts.getToolsExpanded ?? (() => localToolsExpanded);
	ctx.setToolsExpanded =
		opts.setToolsExpanded ??
		((expanded) => {
			localToolsExpanded = expanded;
		});
	ctx.stageUiBroker = opts.stageUiBroker ?? stageUiBroker;
	ctx.footerData = opts.footerData && stageFooterData(opts.footerData, ctx.stageUiBroker, opts.runId, opts.stageId);
	ctx.canSubmitPrompt = opts.canSubmitPrompt;
	ctx.mountedCustomUi = null;
	ctx.mountingRequestId = null;
	ctx.promptState = null;
	ctx.dismissedPromptId = null;
	ctx.promptEditor = null;
	ctx.promptEditorPromptId = null;
	ctx.promptEditorSubmitFromEnter = false;
	ctx.promptScrollOffset = 0;
	ctx.promptMaxScroll = 0;
	ctx.promptVisibleRows = 0;
	ctx.helpOpen = false;
	ctx.interruptedByEscape = false;
	ctx.localPaused = false;
	ctx.lastObservedStageStatus = undefined;
	ctx.lastObservedRunStatus = undefined;
	ctx.seenNoticeIds = new Set<string>();
	ctx.deliveryLifecycles = new Map<number, number | undefined>();
	ctx.terminalLifecycleFenced = false;
	ctx._unsubscribeStore = null;
	ctx._unsubscribeHandle = null;
	ctx._unsubscribeDeliveryActivity = null;
	ctx._unsubscribeFooterData = null;
	ctx._unregisterStageUiHost = null;
	installFocusHold(ctx);
	ctx.chatHost = createChatHost(ctx, opts);
	if (opts.initialComposerDraft !== undefined) {
		ctx.chatHost.setInputText(opts.initialComposerDraft);
	}
	ctx._unregisterStageUiHost = ctx.stageUiBroker.registerHost(
		ctx.runId,
		ctx.stageId,
		{
			showCustomUi: (request) => {
				void showCustomUi(ctx, request);
			},
			hideCustomUi: (request) => {
				hideMountedCustomUi(ctx, request);
			},
		},
		opts.handle?.stageUiSignal,
	);

	snapshotMessagesFromHandle(ctx);
	replayPendingToolExecutions(ctx);
	const initialRun = currentRun(ctx);
	const initialStage = initialRun?.stages.find((s) => s.id === ctx.stageId);
	ctx.lastObservedRunStatus = initialRun?.status;
	ctx.lastObservedStageStatus = initialStage?.status;
	snapshotMessagesFromSession(ctx, initialStage);
	absorbStageNotices(ctx, initialStage);
	syncPromptState(ctx, initialStage?.pendingPrompt);
	const initialChatIsTerminal =
		isTerminalStageChatState(initialRun?.status) || isTerminalStageChatState(initialStage?.status);
	if (initialChatIsTerminal) ctx.chatHost.clearBusyForTerminalWorkflowStage();
	rehydrateEscapeInterruptState(ctx, initialStage);
	ctx._unsubscribeStore = subscribeStoreInvalidation(ctx.store, () => handleStoreUpdate(ctx));
	const unsubscribeBranch = ctx.footerData?.onBranchChange(() => ctx.requestRender?.());
	const unsubscribeStatuses = ctx.footerData
		? ctx.stageUiBroker.onStageStatusesChanged(() => ctx.requestRender?.())
		: undefined;
	ctx._unsubscribeFooterData = () => {
		unsubscribeBranch?.();
		unsubscribeStatuses?.();
	};

	if (ctx.handle) {
		// Delivery activity first: its replay must be in place before the SDK
		// stream, so a synchronously replayed `agent_start` on a retained terminal
		// stage can see that a live delivery authorizes it.
		ctx._unsubscribeDeliveryActivity = subscribeStageChatDeliveryActivity(ctx);
		ctx._unsubscribeHandle = ctx.handle.subscribe(
			(event) => applyStageChatLiveHandleEvent(ctx, event),
			() => {
				ctx.chatHost.clearBusyForTerminalWorkflowStage();
				ctx.requestRender?.();
			},
		);
		if (!initialChatIsTerminal) rehydrateCompactionStatusAfterAttach(ctx);
		rehydrateQueuedMessages(ctx);
	}
	ctx.chatHost.syncAnimationTick();
}

/**
 * Restore the factual compaction indicator into a freshly mounted host.
 *
 * Compaction start is an event, but the active reason lives on the session so
 * a host rebuilt after detach can render the same label even when it missed
 * that event. An absent reason explicitly clears the fresh host's status.
 */
function rehydrateCompactionStatus(ctx: StageChatViewContext): void {
	const session = liveHandle(ctx)?.agentSession;
	ctx.chatHost.hydrateCompactionStatus(
		session?.isCompacting === true ? session.compactionReason : undefined,
		session?.isCompacting === true ? session.compactionStartedAt : undefined,
	);
}

/**
 * The live stage handle may create its session lazily. Re-read compaction state
 * after that async attach so a host mounted while the session is already
 * compacting does not stay on the generic Working row forever.
 */
function rehydrateCompactionStatusAfterAttach(ctx: StageChatViewContext): void {
	const handle = liveHandle(ctx);
	if (!handle) return;
	rehydrateCompactionStatus(ctx);
	void handle.ensureAttached().then(
		() => {
			if (ctx._unsubscribeHandle === null || liveHandle(ctx) === undefined) return;
			ctx.chatHost.refreshTaskStore();
			if (isTerminalStageChatState(currentRun(ctx)?.status) || isTerminalStageChatState(currentStage(ctx)?.status)) {
				return;
			}
			rehydrateCompactionStatus(ctx);
			ctx.chatHost.syncAnimationTick();
			ctx.requestRender?.();
		},
		() => {},
	);
}

/**
 * Replay the stage's pending queue into a freshly mounted chat host.
 *
 * The queue lives on the session, but its display lives in the host that is
 * destroyed on detach. A new host starts empty and only sees future
 * `queue_update` events, so a message queued while attached would silently
 * vanish on reattach. The snapshot comes from the handle rather than from a
 * concrete `AgentSession`, so an adapter-backed stage rehydrates too.
 * Subscribing before this runs means a real update that arrives later wins.
 */
function rehydrateQueuedMessages(ctx: StageChatViewContext): void {
	const queued = liveHandle(ctx)?.queuedUserMessages?.();
	if (!queued) return;
	const steering = [...queued.steering];
	const followUp = [...queued.followUp];
	if (steering.length === 0 && followUp.length === 0) return;
	const event: AgentSessionEvent = { type: "queue_update", steering, followUp };
	ctx.chatHost.applyAgentEvent(event);
}

function installFocusHold(ctx: StageChatViewContext): void {
	if (!ctx.requestFocus) return;
	ctx.focusHoldTimer = setInterval(() => {
		// Keep interactive custom UI and idle composer focus without reclaiming it
		// from a streaming continuation.
		if (ctx.mountedCustomUi !== null || !isStreaming(ctx)) ctx.requestFocus?.();
	}, 150);
}

/**
 * The stage chat footer describes the viewed stage's session. Git branch and provider count are
 * host-wide and stay shared, but extension statuses are the stage session's own: the main
 * session's would present its activity as the stage's.
 */
function stageFooterData(
	hostFooterData: ReadonlyFooterDataProvider,
	broker: StageUiBroker,
	runId: string,
	stageId: string,
): ReadonlyFooterDataProvider {
	return {
		getGitBranch: (cwd) => hostFooterData.getGitBranch(cwd),
		getAvailableProviderCount: () => hostFooterData.getAvailableProviderCount(),
		onBranchChange: (callback, cwd) => hostFooterData.onBranchChange(callback, cwd),
		getExtensionStatuses: () => broker.getStageStatuses(runId, stageId),
	};
}

function createChatHost(ctx: StageChatViewContext, opts: StageChatViewOpts): ChatSessionHost<NoticeEntry> {
	return new ChatSessionHost<NoticeEntry>({
		taskRowsInChat: false,
		style: chatHostStyle(ctx),
		// The stage chat takes Esc itself: it pauses the stage, which cancels the retry it waits on.
		canCancelRetry: () => isAbortableStreamingSession(ctx),
		autocompleteProvider: stageSkillAutocomplete(ctx),
		commands: {
			submitUserMessage: (text, mode) => submitStageSkillCommand(ctx, text, mode),
			ensureAttached: async () => {
				await liveHandle(ctx)?.ensureAttached();
			},
			prompt: async (text, mode) => {
				clearStageEscapeInterruptState(ctx);
				if (classifyChatCommand(text) === "skill") return submitStageSkillCommand(ctx, text, mode);
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				// Typed Enter is a steering intent even when this chat reads the
				// handle as idle: workflow admission can still own a retiring turn,
				// and the unspecified `sendUserMessage` default would demote the
				// message to a follow-up delivered at the end of the turn. Naming
				// the mode keeps manual input on the steering boundary. A genuinely
				// idle session ignores `deliverAs` and starts a fresh turn. Ctrl+F
				// reaches this same command and carries its own mode, so the choice
				// is scoped to this submission rather than to the view.
				if (handle.sendUserMessage !== undefined) {
					await handle.sendUserMessage(text, { deliverAs: mode === "followUp" ? "followUp" : "steer" });
					return;
				}
				// A handle without that surface cannot be idle-aware on the caller's
				// behalf, so make the same choice here that `sendUserMessage` makes:
				// a follow-up needs a turn to trail, and `followUp()` on a session
				// that is not streaming queues text no turn would ever consume. Ctrl+F
				// therefore reaches the follow-up queue exactly while the stage
				// streams, and otherwise starts a turn like Enter.
				if (mode === "followUp" && handle.isStreaming) {
					await handle.followUp(text);
					return;
				}
				await handle.prompt(text);
			},
			// Queued text keeps `sendUserMessage()`'s literal semantics, as Enter on an idle stage does;
			// `steer()`/`followUp()` would expand templates and refuse registered commands instead.
			steer: async (text) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				if (handle.sendUserMessage !== undefined) await handle.sendUserMessage(text, { deliverAs: "steer" });
				else await handle.steer(text);
			},
			followUp: async (text) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				if (handle.sendUserMessage !== undefined) await handle.sendUserMessage(text, { deliverAs: "followUp" });
				else await handle.followUp(text);
			},
			interrupt: async () => {
				const handle = liveHandle(ctx);
				if (!handle) return;
				const status = currentStage(ctx)?.status ?? handle.status;
				if (status === "pending" || status === "running" || status === "awaiting_input") {
					await handle.pause();
					return;
				}
				await handle.agentSession?.abort();
			},
			resume: async (message, mode = "auto") => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				clearStageEscapeInterruptState(ctx);
				ctx.localPaused = true;
				let succeeded = false;
				try {
					if (message && classifyChatCommand(message) === "skill") {
						await submitStageSkillCommand(ctx, message, mode, true);
					} else {
						await handle.resume(message);
					}
					succeeded = true;
				} finally {
					ctx.localPaused =
						!succeeded && (currentStage(ctx)?.status === "paused" || liveHandle(ctx)?.status === "paused");
				}
			},
			runBash: async (request) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				await handle.ensureAttached();
				// The stage's session can close while it attaches; a command never runs on a closed one (#5168).
				if (liveHandle(ctx) !== handle) throw new Error("no live handle on this stage");
				const agentSession = handle.agentSession;
				// A stage on a local worker runs the command on its session there.
				if (!agentSession && handle.executeBash !== undefined)
					return handle.executeBash(request.command, request.onChunk, {
						excludeFromContext: request.excludeFromContext,
					});
				if (!agentSession) throw new Error("no live agent session on this stage");
				const execute = () =>
					agentSession.executeBash(request.command, request.onChunk, {
						excludeFromContext: request.excludeFromContext,
					});
				const holds = handle.releaseGate?.chatHolds;
				return holds ? holds.operation(execute) : execute();
			},
			abortBash: async () => {
				const handle = liveHandle(ctx);
				if (handle?.agentSession) handle.agentSession.abortBash();
				else handle?.abortBash?.();
			},
			abortCompaction: async () => {
				const handle = liveHandle(ctx);
				if (handle?.agentSession) handle.agentSession.abortCompaction();
				else handle?.abortCompaction?.();
			},
			handleSlashCommand: async (text) => handleSlashCommand(ctx, text),
		},
		isBashRunning: () => {
			const handle = liveHandle(ctx);
			return handle?.agentSession?.isBashRunning === true || handle?.isBashRunning === true;
		},
		requestRender: opts.requestRender,
		getAgentSession: () => liveHandle(ctx)?.agentSession,
		getSessionContextMeter: (displayed) => liveHandle(ctx)?.contextMeter?.(displayed),
		// A stage on a local worker: the handle's copy of its session's messages, kept current by the worker.
		getSessionMessages: () => {
			const handle = liveHandle(ctx);
			return handle !== undefined && handle.agentSession === undefined ? handle.messages : undefined;
		},
		// A stage on a local worker lists the tasks of its session there.
		getTaskSource: () => {
			const handle = liveHandle(ctx);
			return handle?.agentSession === undefined ? handle?.taskSource?.() : undefined;
		},
		isStreaming: () => isLiveHandleStreaming(ctx),
		isPaused: () => isPaused(ctx),
		isDisabled: () => isBlocked(ctx) || !liveHandle(ctx),
		tui: opts.piTui,
		keybindings: opts.piKeybindings,
		editorFactory: opts.piEditorFactory,
		editorTheme: editorThemeFromGraphTheme(ctx.theme),
		getChatRenderSettings: () => stageChatRenderSettings(ctx, opts),
		footerData: ctx.footerData,
		renderExtraEntry: (entry, expanded) =>
			noticeRow(
				entry,
				() => {
					const settings = stageChatRenderSettings(ctx, opts);
					return { expanded: settings?.toolOutputExpanded === true, outputPad: settings?.outputPad };
				},
				expanded,
			),
		countsAsMessage: stageNoticeCountsAsMessage,
	});
}

function handleStoreUpdate(ctx: StageChatViewContext): void {
	const run = currentRun(ctx);
	const stage = run?.stages.find((s) => s.id === ctx.stageId);
	const currentRunStatus = run?.status;
	const currentStageStatus = stage?.status;
	const publishedActivity = publishedStageChatActivity(ctx, stage);
	let changed = ctx.lastPublishedActivity !== publishedActivity;
	ctx.lastPublishedActivity = publishedActivity;
	if (stage && stage.status === "paused" && !ctx.localPaused) {
		ctx.localPaused = true;
		changed = true;
	} else if (stage && stage.status === "running" && (ctx.localPaused || ctx.interruptedByEscape)) {
		ctx.localPaused = false;
		clearStageEscapeInterruptState(ctx);
		changed = true;
	}
	pruneStageEscapeInterruptStates(ctx.store);
	changed = absorbStageNotices(ctx, stage) || changed;
	const promptChanged = syncPromptState(ctx, stage?.pendingPrompt);
	changed = promptChanged || changed;
	if (promptChanged && ctx.promptState && canSubmitPrompt(ctx, ctx.promptState.prompt.id)) {
		ctx.requestFocus?.();
	}
	if (
		isTerminalStageChatTransition(ctx.lastObservedStageStatus, currentStageStatus) ||
		isTerminalStageChatTransition(ctx.lastObservedRunStatus, currentRunStatus)
	) {
		ctx.chatHost.clearBusyForTerminalWorkflowStage();
		// Leases admitted before this transition can no longer authorize activity.
		invalidateStageChatDeliveryLifecycles(ctx);
		changed = true;
	}
	ctx.lastObservedRunStatus = currentRunStatus;
	ctx.lastObservedStageStatus = currentStageStatus;
	const hadAnimationTick = ctx.chatHost.hasAnimationTick();
	ctx.chatHost.syncAnimationTick();
	if (changed || hadAnimationTick !== ctx.chatHost.hasAnimationTick()) ctx.requestRender?.();
}

/**
 * Snapshot the transcript a freshly mounted chat has to start from.
 *
 * The handle reports settled messages; an assistant message still streaming is
 * not one of them until its turn ends. `message_update` carries only the next
 * delta, so a chat opened part-way through a stage's turn would otherwise show
 * nothing until that turn finished — a stage held mid-turn shows nothing at
 * all. The session's in-flight message closes that window, and the live
 * subscription installed after this continues it delta by delta. Between two
 * attempts of a retry nothing streams, so the chat shows the retry's wait, and
 * while the stage moves its turn to its next model, the move. A turn that went on
 * in a new session after such a move counts from its first request, which that
 * session's messages do not hold.
 */
function snapshotMessagesFromHandle(ctx: StageChatViewContext): void {
	const handle = liveHandle(ctx);
	if (!handle) return;
	const { messages, contextMeter } = stageChatHistory(handle);
	ctx.chatHost.appendMessages(messages, contextMeter);
	const streaming = handle.agentSession?.agent?.state.streamingMessage ?? handle.streamingMessage?.();
	ctx.chatHost.hydrateStreamingAssistantMessage(streaming);
	const active = activeLiveHandle(ctx);
	if (!active) return;
	const turnStartedAt = active.turnStartedAt ?? active.agentSession?.turnStartedAt;
	const status = active.agentSession?.retryStatus ?? active.modelSwitch;
	if (stageWaitsToRetry(active))
		ctx.chatHost.hydrateRetryWait(messages, turnStartedAt, status?.type === "auto_retry_start" ? status : undefined);
	else if (status?.type === "model_fallback_start") ctx.chatHost.hydrateModelSwitch(turnStartedAt, messages);
	else if (active.isStreaming)
		ctx.chatHost.hydrateRunningTurn(messages, streaming, turnStartedAt, contextMeter?.requestSide);
	else if (turnStartedAt !== undefined) ctx.chatHost.hydrateModelSwitch(turnStartedAt);
}

/** The calls a stage with its session released waits on: their results arrive when it reopens, so none is interrupted. */
function waitingToolCallIds(stage: StageSnapshot | undefined): ReadonlySet<string> | undefined {
	const calls = stage?.wait?.toolCalls;
	return calls === undefined ? undefined : new Set(calls.map((call) => call.toolCallId));
}

function snapshotMessagesFromSession(ctx: StageChatViewContext, stage: StageSnapshot | undefined): void {
	const handle = liveHandle(ctx);
	const sessionId = handle?.sessionId ?? stage?.sessionId;
	if (sessionId === undefined) return;
	const sessionStore =
		handle?.sessionStore ?? handle?.agentSession?.sessionManager.getSessionStore() ?? ctx.sessionStore;
	if (sessionStore === undefined) {
		if (!handle) ctx.postMortemUnavailableReason ??= "invalid_session";
		return;
	}
	void ctx.chatHost.loadSession(sessionStore, sessionId, waitingToolCallIds(stage)).then((loaded) => {
		if (!loaded && !liveHandle(ctx)) ctx.postMortemUnavailableReason ??= "invalid_session";
		ctx.requestRender?.();
	});
}

function absorbStageNotices(ctx: StageChatViewContext, stage: StageSnapshot | undefined): boolean {
	const notices = stage?.notices;
	if (!notices) return false;
	let changed = false;
	for (const n of notices) {
		if (ctx.seenNoticeIds.has(n.id)) continue;
		ctx.seenNoticeIds.add(n.id);
		changed = true;
		ctx.chatHost.appendExtraEntry({
			role: "notice",
			noticeId: n.id,
			kind: n.kind,
			value: n.to,
			from: n.from,
			meta: n.meta,
			text: noticeSummary(n),
		});
	}
	return changed;
}

export function currentRun(ctx: StageChatViewContext): RunSnapshot | undefined {
	// Read on every store change: project only this run, not the whole store (#4009).
	return readGraphStoreRun(ctx.store, ctx.runId);
}

export function currentStage(ctx: StageChatViewContext): StageSnapshot | undefined {
	return currentRun(ctx)?.stages.find((s) => s.id === ctx.stageId);
}

/** Whether a pending question owns the composer's place, rather than being closed back to the chat's prompt. */
export function promptCardShown(ctx: Pick<StageChatViewContext, "promptState" | "dismissedPromptId">): boolean {
	return ctx.promptState !== null && ctx.promptState.prompt.id !== ctx.dismissedPromptId;
}

export function syncPromptState(ctx: StageChatViewContext, prompt: PendingPrompt | undefined): boolean {
	const changed = replacePromptState(ctx, prompt);
	syncPromptCountdown(ctx);
	return changed;
}

function replacePromptState(ctx: StageChatViewContext, prompt: PendingPrompt | undefined): boolean {
	if (!prompt) {
		const hadLivePrompt = ctx.promptState !== null || ctx.promptEditor !== null || ctx.promptEditorPromptId !== null;
		if (!hadLivePrompt) return false;
		ctx.promptState = null;
		disposePromptEditor(ctx);
		resetPromptScroll(ctx);
		return true;
	}
	if (!ctx.promptState || ctx.promptState.prompt.id !== prompt.id) {
		ctx.promptState = createPromptCardState(prompt);
		seedPromptTextState(ctx, prompt);
		resetPromptEditor(ctx, prompt);
		resetPromptScroll(ctx);
		return true;
	}
	return false;
}

function syncPromptCountdown(ctx: StageChatViewContext): void {
	const counting = ctx.promptState?.prompt.expiresAt !== undefined;
	if (counting && ctx.promptCountdownTimer === undefined) {
		ctx.promptCountdownTimer = setInterval(() => ctx.requestRender?.(), 1000);
	} else if (!counting) {
		clearPromptCountdown(ctx);
	}
}

function clearPromptCountdown(ctx: StageChatViewContext): void {
	if (ctx.promptCountdownTimer === undefined) return;
	clearInterval(ctx.promptCountdownTimer);
	ctx.promptCountdownTimer = undefined;
}

function resetPromptScroll(ctx: StageChatViewContext): void {
	ctx.promptScrollOffset = 0;
	ctx.promptMaxScroll = 0;
	ctx.promptVisibleRows = 0;
}

function promptSeedText(ctx: StageChatViewContext, prompt: PendingPrompt): string {
	const draft = ctx.store.getStagePromptDraft(ctx.runId, ctx.stageId, prompt.id);
	if (draft !== undefined) return draft;
	return typeof prompt.initial === "string" ? prompt.initial : "";
}

function seedPromptTextState(ctx: StageChatViewContext, prompt: PendingPrompt): void {
	if (prompt.kind !== "input" && prompt.kind !== "editor") return;
	if (!ctx.promptState || ctx.promptState.prompt.id !== prompt.id) return;
	const seed = promptSeedText(ctx, prompt);
	ctx.promptState.rawText = seed;
	ctx.promptState.caret = seed.length;
}

function recordPromptDraft(ctx: StageChatViewContext, promptId: string, text: string): void {
	ctx.store.recordStagePromptDraft(ctx.runId, ctx.stageId, promptId, text);
}

export function recordCurrentPromptDraft(ctx: StageChatViewContext): void {
	const state = ctx.promptState;
	if (!state) return;
	const prompt = state.prompt;
	if (prompt.kind !== "input" && prompt.kind !== "editor") return;
	const text = ctx.promptEditor && ctx.promptEditorPromptId === prompt.id ? ctx.promptEditor.getText() : state.rawText;
	recordPromptDraft(ctx, prompt.id, text);
}

function resetPromptEditor(ctx: StageChatViewContext, prompt: PendingPrompt): void {
	disposePromptEditor(ctx);
	if ((prompt.kind !== "input" && prompt.kind !== "editor") || !ctx.piTui) return;
	const editor = ctx.piEditorFactory
		? ctx.piEditorFactory(ctx.piTui, editorThemeFromGraphTheme(ctx.theme), ctx.piKeybindings)
		: new Editor(ctx.piTui, editorThemeFromGraphTheme(ctx.theme), { paddingX: 0 });
	editor.setText(ctx.promptState?.prompt.id === prompt.id ? ctx.promptState.rawText : promptSeedText(ctx, prompt));
	setEditorPlaceholder(editor, "Type your response…");
	setEditorBorderColor(editor, (text) => hexToAnsi(ctx.theme.accent) + text + RESET);
	editor.onChange = (text: string) => {
		if (ctx.promptState?.prompt.id !== prompt.id) return;
		ctx.promptState.rawText = text;
		ctx.promptState.caret = text.length;
		recordPromptDraft(ctx, prompt.id, text);
		ctx.requestRender?.();
	};
	editor.onSubmit = (text: string) => {
		resolvePromptResponse(ctx, prompt.id, text, {
			suppressNextGraphSubmit: ctx.promptEditorSubmitFromEnter,
		});
	};
	ctx.promptEditor = editor;
	ctx.promptEditorPromptId = prompt.id;
}

function disposePromptEditor(ctx: StageChatViewContext): void {
	const editor = ctx.promptEditor;
	ctx.promptEditor = null;
	ctx.promptEditorPromptId = null;
	const disposable = editor as (EditorComponent & { dispose?: () => void }) | null;
	disposable?.dispose?.();
}

export function resolvePromptResponse(
	ctx: StageChatViewContext,
	promptId: string,
	response: unknown,
	metadata: StageChatDetachMetadata = {},
): void {
	const prompt = ctx.promptState?.prompt;
	if (!prompt || prompt.id !== promptId) return;
	if (!canSubmitPrompt(ctx, promptId)) {
		ctx.requestRender?.();
		return;
	}
	ctx.promptState = null;
	clearPromptCountdown(ctx);
	disposePromptEditor(ctx);
	resetPromptScroll(ctx);
	const resolved = ctx.store.resolveStagePendingPrompt(ctx.runId, ctx.stageId, prompt.id, response);
	ctx.requestRender?.();
	if (resolved && ctx.mountedCustomUi === null && ctx.mountingRequestId === null)
		ctx.onDetach("prompt-resolved", metadata);
}

export function viewLineCount(ctx: StageChatViewContext): number {
	const reported = ctx.piTui?.terminal?.rows;
	if (typeof reported !== "number" || !Number.isFinite(reported)) {
		return VIEW_LINE_COUNT;
	}
	return resolveStageChatViewportRows(reported, VIEW_LINE_COUNT);
}

export { isTerminalOrNonStreamingStageChatStatus } from "./stage-chat-view-status.js";

export function liveHandle(ctx: StageChatViewContext) {
	return ctx.handle?.isDisposed === true ? undefined : ctx.handle;
}

/** What the chat of a stage on a local worker says while it cannot show that stage's session yet. */
export interface PooledStageWaitingNotice {
	readonly label: string;
	/** What the stage is doing, such as `creating session 32s`. */
	readonly detail: string;
	readonly message: string;
}

/**
 * The notice for a stage on a local worker that this chat cannot show yet: its session is still
 * starting, or this chat has no live view of it yet (it opens one by itself once it can). Undefined
 * for any other stage. The worker's own word wins over the published startup step, which can lag it.
 */
export function pooledStageWaitingNotice(
	ctx: StageChatViewContext,
	stage: StageSnapshot | undefined = currentStage(ctx),
): PooledStageWaitingNotice | undefined {
	const handle = liveHandle(ctx);
	if (handle?.agentSession !== undefined) return undefined;
	const starting = pooledStageStartingText(stage);
	if (handle === undefined) {
		// No live view yet: the attach pane opens one as soon as the worker serves it.
		if (stage?.workerExecution === undefined || isTerminalStageStatus(stage.status)) return undefined;
		return {
			label: starting === undefined ? "CONNECTING TO LOCAL WORKER" : "STARTING ON LOCAL WORKER",
			detail: starting ?? "opening a live view",
			message: "This stage runs on a local worker. Its chat opens here by itself as soon as its session is ready.",
		};
	}
	if (!(handle.isSessionStarting ?? isPooledStageStarting(stage))) return undefined;
	return {
		label: "STARTING ON LOCAL WORKER",
		detail: starting ?? "starting its session",
		message:
			"This stage's session is still starting on its local worker. Its transcript streams here once it starts, and messages you send now are delivered then.",
	};
}

/** The live handle, unless its run, its stage or the handle itself is in a state that runs no turn. */
function activeLiveHandle(ctx: StageChatViewContext): ReturnType<typeof liveHandle> {
	const handle = liveHandle(ctx);
	if (!handle) return undefined;
	if (isTerminalOrNonStreamingStageChatStatus(currentRun(ctx)?.status)) return undefined;
	if (isTerminalOrNonStreamingStageChatStatus(currentStage(ctx)?.status)) return undefined;
	if (isTerminalOrNonStreamingStageChatStatus(handle.status)) return undefined;
	return handle;
}

export function publishedStageChatActivity(
	ctx: StageChatViewContext,
	stage: StageSnapshot | undefined,
): StageSnapshot["chatActivity"] {
	if (ctx.handle?.placement?.reconnecting || stage?.workerExecution?.reconnecting) return "idle";
	const initial = ctx.handle?.publishedActivity;
	if (initial === undefined || !activeLiveHandle(ctx) || stage?.status === "suspended") return undefined;
	// Once the worker has published the stage, an absent phase is idle, not the wait from the initial watch.
	return stage?.chatActivity ?? (stage?.workerExecution ? "idle" : initial);
}

export function isLiveHandleStreaming(ctx: StageChatViewContext): boolean {
	return activeLiveHandle(ctx)?.isStreaming === true;
}

export function isStreaming(ctx: StageChatViewContext): boolean {
	return ctx.chatHost.isStreaming();
}

/** Whether Escape interrupts the stage's turn: it streams, or its session waits out a retry's backoff between attempts. */
export function isAbortableStreamingSession(ctx: StageChatViewContext): boolean {
	if (isPaused(ctx) || ctx.interruptedByEscape || liveHandle(ctx)?.canPause === false) return false;
	const handle = activeLiveHandle(ctx);
	const agentSession = liveHandle(ctx)?.agentSession;
	return (
		agentSession?.isStreaming === true ||
		agentSession?.isRetrying === true ||
		(handle !== undefined &&
			(ctx.chatHost.isStreaming() ||
				handle.isRetrying === true ||
				stageWaitsToRetry(handle) ||
				currentStage(ctx)?.rateLimits?.some((limit) => limit.waitingUntil !== undefined) === true))
	);
}

export function isBlocked(ctx: StageChatViewContext): boolean {
	return currentStage(ctx)?.status === "blocked";
}

export function isPaused(ctx: StageChatViewContext, stage: StageSnapshot | undefined = currentStage(ctx)): boolean {
	return ctx.localPaused || stage?.status === "paused" || liveHandle(ctx)?.status === "paused";
}

export function isReadOnlyArchive(
	ctx: StageChatViewContext,
	stage: StageSnapshot | undefined = currentStage(ctx),
): boolean {
	if (liveHandle(ctx)) return false;
	if (!stage) return true;
	return isReadOnlyArchiveStatus(stage.status) || stage.sessionId !== undefined;
}

async function handleSlashCommand(ctx: StageChatViewContext, text: string): Promise<boolean> {
	const [command, ...rest] = text.trim().split(/\s+/);
	switch (command) {
		case "/tasks":
			return ctx.chatHost.openTasks(rest.join(" ") || undefined);
		case "/compact": {
			const instructions = rest.join(" ");
			const handle = liveHandle(ctx);
			if (!handle) return false;
			await handle.ensureAttached();
			// A stage on a local worker compacts its session there; its compaction events reach this chat.
			const compact =
				handle.agentSession !== undefined
					? () => handle.agentSession!.compact(instructions ? { query: instructions } : {})
					: handle.compact === undefined
						? undefined
						: () => handle.compact!(instructions || undefined);
			if (compact === undefined) return false;
			try {
				const holds = handle.releaseGate?.chatHolds;
				if (holds)
					await holds.operation(async () => {
						await compact();
					});
				else await compact();
			} catch (error) {
				// compaction_end owns cancellation/failure UI; a stage that could not start compacting says why.
				if (handle.agentSession === undefined) ctx.chatHost.showWarning((error as Error).message);
			}
			return true;
		}
		case "/quit":
			ctx.onClose();
			return true;
		default:
			return false;
	}
}

export function canSubmitPrompt(ctx: StageChatViewContext, promptId: string): boolean {
	return ctx.canSubmitPrompt?.(ctx.runId, ctx.stageId, promptId) ?? true;
}

export function invalidateStageChatView(ctx: StageChatViewContext): void {
	ctx.chatHost.invalidate();
	syncPromptState(ctx, currentStage(ctx)?.pendingPrompt);
}

export function disposeStageChatView(ctx: StageChatViewContext): void {
	if (ctx.focusHoldTimer !== undefined) {
		clearInterval(ctx.focusHoldTimer);
		ctx.focusHoldTimer = undefined;
	}
	clearPromptCountdown(ctx);
	ctx._unsubscribeStore?.();
	ctx._unsubscribeStore = null;
	ctx._unsubscribeHandle?.();
	ctx._unsubscribeHandle = null;
	ctx._unsubscribeDeliveryActivity?.();
	ctx._unsubscribeDeliveryActivity = null;
	ctx.deliveryLifecycles.clear();
	ctx._unsubscribeFooterData?.();
	ctx._unsubscribeFooterData = null;
	releaseMountedCustomUi(ctx);
	disposePromptEditor(ctx);
	ctx._unregisterStageUiHost?.();
	ctx._unregisterStageUiHost = null;
	ctx.chatHost.dispose();
}

export function promptPageSize(ctx: StageChatViewContext): number {
	return Math.max(4, viewLineCount(ctx) - HEADER_ROWS - SEP_ROWS - 2);
}

export interface EscapeInterruptedStageState {
	interruptedTurn: ChatSessionInterruptedTurnSnapshot | undefined;
	awaitingAgentEnd: boolean;
}

const escapeInterruptedStagesByStore = new WeakMap<object, Map<string, EscapeInterruptedStageState>>();

function escapeInterruptStageKey(ctx: Pick<StageChatViewContext, "runId" | "stageId">): string {
	return `${ctx.runId}\u0000${ctx.stageId}`;
}

export function pruneStageEscapeInterruptStates(store: StageChatViewContext["store"]): void {
	const byStage = escapeInterruptedStagesByStore.get(store);
	if (!byStage) return;
	for (const [key, entry] of byStage) {
		const sep = key.indexOf("\u0000");
		if (sep < 0) {
			byStage.delete(key);
			continue;
		}
		const runId = key.slice(0, sep);
		const stageId = key.slice(sep + 1);
		const run = readGraphStoreRun(store, runId);
		if (!run || (isTerminalStageChatState(run.status) && run.status !== "paused")) {
			byStage.delete(key);
			continue;
		}
		const stage = run.stages.find((candidate) => candidate.id === stageId);
		if (!stage) {
			byStage.delete(key);
			continue;
		}
		if (stage.status === "paused") continue;
		if (stage.status === "running" && entry.awaitingAgentEnd) continue;
		byStage.delete(key);
	}
	if (byStage.size === 0) escapeInterruptedStagesByStore.delete(store);
}

export function getStageEscapeInterruptState(
	ctx: Pick<StageChatViewContext, "store" | "runId" | "stageId">,
): EscapeInterruptedStageState | undefined {
	pruneStageEscapeInterruptStates(ctx.store);
	return escapeInterruptedStagesByStore.get(ctx.store)?.get(escapeInterruptStageKey(ctx));
}

export function clearStageEscapeInterruptState(
	ctx: Pick<StageChatViewContext, "store" | "runId" | "stageId" | "interruptedByEscape">,
): void {
	ctx.interruptedByEscape = false;
	const byStage = escapeInterruptedStagesByStore.get(ctx.store);
	if (!byStage) return;
	byStage.delete(escapeInterruptStageKey(ctx));
	if (byStage.size === 0) escapeInterruptedStagesByStore.delete(ctx.store);
}

export function recordStageEscapeInterrupt(ctx: StageChatViewContext): void {
	ctx.interruptedByEscape = true;
	pruneStageEscapeInterruptStates(ctx.store);
	const interruptedTurn = ctx.chatHost.snapshotInterruptedTurn();
	let byStage = escapeInterruptedStagesByStore.get(ctx.store);
	if (!byStage) {
		byStage = new Map<string, EscapeInterruptedStageState>();
		escapeInterruptedStagesByStore.set(ctx.store, byStage);
	}
	byStage.set(escapeInterruptStageKey(ctx), {
		interruptedTurn,
		awaitingAgentEnd: true,
	});
	void ctx.chatHost.interrupt({ restoreQueuedMessages: true });
	ctx.chatHost.restoreInterruptedTurn(interruptedTurn);
}

function rehydrateEscapeInterruptState(ctx: StageChatViewContext, stage: StageSnapshot | undefined): void {
	const saved = getStageEscapeInterruptState(ctx);
	if (!saved) return;
	if (!isPaused(ctx, stage)) {
		clearStageEscapeInterruptState(ctx);
		return;
	}
	ctx.interruptedByEscape = true;
	ctx.chatHost.restoreInterruptedTurn(saved.interruptedTurn);
}
