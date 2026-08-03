import { type AgentSessionEvent, ChatSessionHost } from "@bastani/atomic";
import { Editor, type EditorComponent } from "@earendil-works/pi-tui";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import { createPromptCardState } from "./prompt-card.js";
import { resolveStageChatViewportRows } from "./stage-chat-layout.js";
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
import { noticeRow, noticeSummary } from "./stage-chat-view-transcript.js";
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
	ctx.getViewportRows = opts.getViewportRows;
	ctx.piTui = opts.piTui;
	ctx.piTheme = opts.piTheme;
	ctx.piKeybindings = opts.piKeybindings;
	ctx.piEditorFactory = opts.piEditorFactory;
	ctx.getToolsExpanded = opts.getToolsExpanded;
	ctx.setToolsExpanded = opts.setToolsExpanded;
	ctx.footerData = opts.footerData;
	ctx.stageUiBroker = opts.stageUiBroker ?? stageUiBroker;
	ctx.canSubmitPrompt = opts.canSubmitPrompt;
	ctx.mountedCustomUi = null;
	ctx.mountingRequestId = null;
	ctx.promptState = null;
	ctx.promptEditor = null;
	ctx.promptEditorPromptId = null;
	ctx.promptEditorSubmitFromEnter = false;
	ctx.promptScrollOffset = 0;
	ctx.promptMaxScroll = 0;
	ctx.promptVisibleRows = 0;
	ctx.localPaused = false;
	ctx.mouseScrollCaptureEnabled = true;
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
	ctx._unregisterStageUiHost = ctx.stageUiBroker.registerHost(ctx.runId, ctx.stageId, {
		showCustomUi: (request) => {
			void showCustomUi(ctx, request);
		},
		hideCustomUi: (request) => {
			hideMountedCustomUi(ctx, request);
		},
	});

	snapshotMessagesFromHandle(ctx);
	replayPendingToolExecutions(ctx);
	const initialRun = currentRun(ctx);
	const initialStage = initialRun?.stages.find((s) => s.id === ctx.stageId);
	ctx.lastObservedRunStatus = initialRun?.status;
	ctx.lastObservedStageStatus = initialStage?.status;
	snapshotMessagesFromSessionFile(ctx, initialStage);
	absorbStageNotices(ctx, initialStage);
	syncPromptState(ctx, initialStage?.pendingPrompt);
	const initialChatIsTerminal =
		isTerminalStageChatState(initialRun?.status) || isTerminalStageChatState(initialStage?.status);
	if (initialChatIsTerminal) ctx.chatHost.clearBusyForTerminalWorkflowStage();
	ctx._unsubscribeStore = subscribeStoreInvalidation(ctx.store, () => handleStoreUpdate(ctx));
	ctx._unsubscribeFooterData = ctx.footerData?.onBranchChange(() => ctx.requestRender?.()) ?? null;

	if (ctx.handle) {
		// Delivery activity first: its replay must be in place before the SDK
		// stream, so a synchronously replayed `agent_start` on a retained terminal
		// stage can see that a live delivery authorizes it.
		ctx._unsubscribeDeliveryActivity = subscribeStageChatDeliveryActivity(ctx);
		ctx._unsubscribeHandle = ctx.handle.subscribe((event) => applyStageChatLiveHandleEvent(ctx, event));
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
	ctx.chatHost.hydrateCompactionStatus(session?.isCompacting === true ? session.compactionReason : undefined);
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

function createChatHost(ctx: StageChatViewContext, opts: StageChatViewOpts): ChatSessionHost<NoticeEntry> {
	return new ChatSessionHost<NoticeEntry>({
		style: chatHostStyle(ctx),
		commands: {
			ensureAttached: async () => {
				await liveHandle(ctx)?.ensureAttached();
			},
			prompt: async (text, mode) => {
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
			steer: async (text) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				await handle.steer(text);
			},
			followUp: async (text) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				await handle.followUp(text);
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
			resume: async (message) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				ctx.localPaused = true;
				await handle.resume(message);
				ctx.localPaused = false;
			},
			runBash: async (request) => {
				const handle = liveHandle(ctx);
				if (!handle) throw new Error("no live handle on this stage");
				await handle.ensureAttached();
				const agentSession = handle.agentSession;
				if (!agentSession) throw new Error("no live agent session on this stage");
				return agentSession.executeBash(request.command, request.onChunk, {
					excludeFromContext: request.excludeFromContext,
				});
			},
			abortBash: async () => {
				liveHandle(ctx)?.agentSession?.abortBash();
			},
			abortCompaction: async () => {
				liveHandle(ctx)?.agentSession?.abortCompaction();
			},
			handleSlashCommand: async (text) => handleSlashCommand(ctx, text),
		},
		isBashRunning: () => liveHandle(ctx)?.agentSession?.isBashRunning === true,
		requestRender: opts.requestRender,
		getAgentSession: () => liveHandle(ctx)?.agentSession,
		isStreaming: () => isLiveHandleStreaming(ctx),
		isPaused: () => isPaused(ctx),
		isDisabled: () => isBlocked(ctx) || !liveHandle(ctx),
		tui: opts.piTui,
		keybindings: opts.piKeybindings,
		editorFactory: opts.piEditorFactory,
		editorTheme: editorThemeFromGraphTheme(ctx.theme),
		getChatRenderSettings: () => stageChatRenderSettings(ctx, opts),
		footerData: opts.footerData,
		renderExtraEntry: (entry) => noticeRow(entry, ctx.theme),
	});
}

function handleStoreUpdate(ctx: StageChatViewContext): void {
	const run = currentRun(ctx);
	const stage = run?.stages.find((s) => s.id === ctx.stageId);
	const currentRunStatus = run?.status;
	const currentStageStatus = stage?.status;
	let changed = false;
	if (stage && stage.status === "paused" && !ctx.localPaused) {
		ctx.localPaused = true;
		changed = true;
	} else if (stage && stage.status === "running" && ctx.localPaused) {
		ctx.localPaused = false;
		changed = true;
	}
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

function snapshotMessagesFromHandle(ctx: StageChatViewContext): void {
	const handle = liveHandle(ctx);
	if (!handle) return;
	ctx.chatHost.appendMessages(handle.messages);
}

function snapshotMessagesFromSessionFile(ctx: StageChatViewContext, stage: StageSnapshot | undefined): void {
	ctx.chatHost.loadSessionFile(liveHandle(ctx)?.sessionFile ?? stage?.sessionFile);
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
	return readGraphStoreSnapshot(ctx.store).runs.find((r) => r.id === ctx.runId);
}

export function currentStage(ctx: StageChatViewContext): StageSnapshot | undefined {
	return currentRun(ctx)?.stages.find((s) => s.id === ctx.stageId);
}

export function syncPromptState(ctx: StageChatViewContext, prompt: PendingPrompt | undefined): boolean {
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
	disposePromptEditor(ctx);
	resetPromptScroll(ctx);
	const resolved = ctx.store.resolveStagePendingPrompt(ctx.runId, ctx.stageId, prompt.id, response);
	ctx.requestRender?.();
	if (resolved) ctx.onDetach("prompt-resolved", metadata);
}

export function viewLineCount(ctx: StageChatViewContext): number {
	const reported = ctx.getViewportRows?.();
	if (typeof reported !== "number" || !Number.isFinite(reported)) {
		return VIEW_LINE_COUNT;
	}
	return resolveStageChatViewportRows(reported, VIEW_LINE_COUNT);
}

export { isTerminalOrNonStreamingStageChatStatus } from "./stage-chat-view-status.js";

export function liveHandle(ctx: StageChatViewContext) {
	return ctx.handle?.isDisposed === true ? undefined : ctx.handle;
}

export function isLiveHandleStreaming(ctx: StageChatViewContext): boolean {
	const handle = liveHandle(ctx);
	if (!handle) return false;
	if (isTerminalOrNonStreamingStageChatStatus(currentRun(ctx)?.status)) return false;
	if (isTerminalOrNonStreamingStageChatStatus(currentStage(ctx)?.status)) return false;
	if (isTerminalOrNonStreamingStageChatStatus(handle.status)) return false;
	return handle.isStreaming === true;
}

export function isStreaming(ctx: StageChatViewContext): boolean {
	return ctx.chatHost.isStreaming();
}

export function isAbortableStreamingSession(ctx: StageChatViewContext): boolean {
	return isLiveHandleStreaming(ctx) || liveHandle(ctx)?.agentSession?.isStreaming === true;
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
	return isReadOnlyArchiveStatus(stage.status) || Boolean(stage.sessionFile);
}

async function handleSlashCommand(ctx: StageChatViewContext, text: string): Promise<boolean> {
	const [command, ...rest] = text.trim().split(/\s+/);
	switch (command) {
		case "/compact": {
			if (rest.length > 0) return true;
			const handle = liveHandle(ctx);
			if (!handle) return false;
			await handle.ensureAttached();
			if (!handle.agentSession) return false;
			try {
				await handle.agentSession.compact();
			} catch {
				/* compaction_end owns cancellation/failure UI. */
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
