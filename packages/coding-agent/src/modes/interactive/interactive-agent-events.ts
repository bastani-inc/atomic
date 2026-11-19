import { APP_NAME, detectInstallChangeAsync, VERSION } from "../../config.js";
import { sessionCloseReason } from "../../core/agent-session-events.ts";
import { createCacheMissModelSource, detectCacheMiss, formatCacheMissNotice } from "../../core/cache-stats.ts";
import { chatReceipt } from "../../core/chat-receipts.js";
import { createCustomMessage } from "../../core/messages.ts";
import { formatModelLabel } from "../../core/model-label.ts";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { bindAgentPanel } from "../rpc/agent-panel-bridge.ts";
import { chatLineDrawnLive } from "./chat-reader-layout.js";
import { chatRecordsChanged } from "./chat-reader-records.js";
import { hasAssistantVisibleContent, interruptedNotice } from "./components/assistant-message.ts";
import { AtomicWorkedStatusComponent, AtomicWorkingLoader } from "./components/atomic-working-status.ts";
import { mountIdleStatus } from "./components/idle-status.ts";
import { retryCancelHint, retryWaitFromEvent, retryWaitMessage } from "./components/retry-status-line.ts";
import { toolResultGroupState } from "./components/tool-group-tracker.ts";
import { compactionMeta, runInProgress, type WorkingRunSnapshot } from "./components/working-run-meter.ts";
import { appendNewChildrenBeforeAttachedChild } from "./interactive-child-ordering.ts";
import { type EventStartup, eventStartupScope } from "./interactive-initial-session-binding.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type AgentSessionEvent,
	AssistantMessageComponent,
	CountdownTimer,
	keyText,
	Loader,
	type Message,
	pickWhimsicalWorkingMessage,
	Spacer,
	Text,
	ToolExecutionComponent,
	theme,
} from "./interactive-mode-deps.ts";
import { formatResumeCommand } from "./interactive-mode-helpers.ts";
import { reconcileQueuedSubmissions } from "./interactive-queueing.ts";
import {
	breakMainToolGroup,
	endMainAssistantMessage,
	endMainToolTurn,
	mainToolCallBreaks,
	observeMainToolStart,
	settleMainTool,
	trackMainToolComponent,
} from "./interactive-render-chat.ts";
import { handleSummarizationRetryEvent } from "./interactive-summarization-retry-events.ts";
import { disposeInteractiveTasks, refreshInteractiveTasks } from "./interactive-task-projection.js";
import { applyAssistantMessageDelta, beginStreamingAssistantMessage } from "./streaming-assistant-message.ts";

/** Reasons that mean there is nothing to snapshot, which keep the session exactly as it behaves without snapshots. */
const WORKSPACE_ABSENCE_CODES: ReadonlySet<string> = new Set(["not-installed", "not-a-repository", "unborn-head"]);
interface MainTurnToolBatch {
	readonly pending: Map<string, string>;
	aborted: string[];
}
const mainTurnToolBatches = new WeakMap<InteractiveModeBase, MainTurnToolBatch>();

/**
 * The status row after the turn's retry or model switch ended while the chat waited on it: the turn's worked row when
 * the turn ends there (`turn`, counted from its start to now), as after any other turn, or nothing.
 */
function mountEndedTurn(mode: InteractiveModeBase, turn: WorkingRunSnapshot | undefined): void {
	if (turn === undefined || !mode.workingVisible) {
		mountIdleStatus(mode.statusContainer, mode.settingsManager.getClearOnShrink());
		return;
	}
	mode.statusContainer.addChild(new AtomicWorkedStatusComponent({ message: mode.lastWorkingMessage, snapshot: turn }));
}

function getMainTurnToolBatch(mode: InteractiveModeBase): MainTurnToolBatch {
	let batch = mainTurnToolBatches.get(mode);
	if (!batch) {
		batch = { pending: new Map(), aborted: [] };
		mainTurnToolBatches.set(mode, batch);
	}
	return batch;
}

function recordMainPendingTool(mode: InteractiveModeBase, toolCallId: string, toolName: string): void {
	const trimmed = toolName.trim();
	if (!trimmed) return;
	const batch = getMainTurnToolBatch(mode);
	if (batch.pending.size === 0 && batch.aborted.length > 0) batch.aborted = [];
	batch.pending.set(toolCallId, trimmed);
}

function settleMainTurnTool(mode: InteractiveModeBase, toolCallId: string, toolName: string, isError: boolean): void {
	const batch = mainTurnToolBatches.get(mode);
	const resolved = (batch?.pending.get(toolCallId) ?? toolName).trim();
	batch?.pending.delete(toolCallId);
	if (!isError || !resolved) return;
	const target = batch ?? getMainTurnToolBatch(mode);
	if (!target.aborted.includes(resolved)) target.aborted.push(resolved);
}

function currentInterruptedMainTools(mode: InteractiveModeBase): readonly string[] | undefined {
	const batch = mainTurnToolBatches.get(mode);
	if (!batch) return undefined;
	if (batch.pending.size > 0) return [...new Set(batch.pending.values())];
	return batch.aborted.length > 0 ? [...new Set(batch.aborted)] : undefined;
}

InteractiveModeBase.prototype.maybeShowInstallChangeWarning = async function (
	this: InteractiveModeBase,
): Promise<boolean> {
	if (this.installChangeWarningShown) return true;
	const change = await detectInstallChangeAsync();
	if (!change) return false;
	if (this.installChangeWarningShown) return true;
	this.installChangeWarningShown = true;
	const cause =
		change.kind === "updated"
			? `${APP_NAME} was updated to ${change.version} while this session was running (${VERSION})`
			: `The ${APP_NAME} installation this session runs from was removed or replaced`;
	void formatResumeCommand(this.sessionManager).then((resume) =>
		this.showWarning(
			`${cause}. Features that load code on demand can fail until restart. ${resume ? `Restart with \`${resume}\` to continue this session.` : `Restart ${APP_NAME}.`}`,
		),
	);
	return true;
};

function createToolComponent(
	mode: InteractiveModeBase,
	toolName: string,
	toolCallId: string,
	args: unknown,
): ToolExecutionComponent | RemoteToolExecutionComponent {
	const options = {
		showImages: mode.settingsManager.getShowImages(),
		imageWidthCells: mode.settingsManager.getImageWidthCells(),
		outputPad: mode.outputPad,
	};
	const getTaskRecord = (taskId: TaskId) => getOwnerTaskStore(mode.session)?.getTask(taskId);
	return mode.runtimeHost instanceof IsolatedInteractiveRuntime
		? new RemoteToolExecutionComponent(toolName, toolCallId, args, options, mode.runtimeHost, () =>
				mode.ui.requestRender(),
			)
		: new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{
					...options,
					getTaskRecord,
					getToolDefinition: (name) => mode.getRegisteredToolDefinition(name),
				},
				mode.getRegisteredToolDefinition(toolName),
				mode.ui,
				mode.sessionManager.getCwd(),
			);
}

type StartupEvent = AgentSessionEvent | JsonAgentSessionEvent;
interface EventForwarding {
	mode: InteractiveModeBase;
	session: object;
	event?: StartupEvent;
	startup?: EventStartup;
	stock?: Promise<void>;
}
// The subscriber owns one synchronous dispatch frame, not a receipt per streamed event.
// Only a handler that actually starts the UI needs to distinguish fire-and-forget delivery
// from an SDK handler that catches startup failure and runs its own recovery operation.
let forwarding: EventForwarding | undefined;
function deliverAgentEvent(frame: EventForwarding, event: StartupEvent): Promise<void> {
	const call: EventForwarding = frame.event === undefined ? frame : { mode: frame.mode, session: frame.session };
	const previous = forwarding;
	try {
		forwarding = call;
		call.event = event;
		const delivery = call.mode.handleEvent(event);
		if (call.startup) call.startup.strict = call.stock !== delivery;
		return delivery; // Do not observe this promise; the runtime owns unhandled-rejection reporting.
	} finally {
		call.event = undefined;
		call.startup = undefined;
		call.stock = undefined;
		forwarding = previous;
	}
}

InteractiveModeBase.prototype.subscribeToAgent = function (this: InteractiveModeBase): void {
	refreshInteractiveTasks(this);
	const session = this.session;
	const frame: EventForwarding = { mode: this, session };
	const unsubscribe = session.subscribe(async (event) => {
		await deliverAgentEvent(frame, event);
	});
	// A rebind can miss the start of a wait. Subscribe and read it in one turn; don't restart its countdown.
	const wait = session.retryStatus;
	if (wait) {
		if (session.turnStartedAt !== undefined)
			this.workingRunMeter.awaitRetry(session.turnStartedAt, runInProgress(session.messages).settledTokens);
		void deliverAgentEvent(frame, wait);
	}
	const panelUi = this.runtimeHost instanceof IsolatedInteractiveRuntime ? undefined : this.createExtensionUIContext();
	const disposeAgentPanel =
		panelUi === undefined
			? () => {}
			: bindAgentPanel(session, panelUi, undefined, {
					custom: (factory, options) => this.showExtensionCustom(factory, options),
					getChatRenderSettings: panelUi.getChatRenderSettings,
					getFooterDataProvider: panelUi.getFooterDataProvider,
					getToolsExpanded: panelUi.getToolsExpanded,
					setToolsExpanded: panelUi.setToolsExpanded,
					notify: panelUi.notify,
				});
	this.unsubscribe = () => {
		unsubscribe();
		if (this.retryLoader && this.retryEscapeHandler) {
			this.statusContainer.removeChild(this.retryLoader);
			this.retryLoader.stop();
			this.retryLoader = undefined;
			this.retryCountdown?.dispose();
			this.retryCountdown = undefined;
		}
		if (this.retryEscapeHandler) {
			this.defaultEditor.onEscape = this.retryEscapeHandler;
			this.retryEscapeHandler = undefined;
		}
		if (this.fallbackLoader) {
			this.statusContainer.removeChild(this.fallbackLoader);
			this.fallbackLoader.stop();
			this.fallbackLoader = undefined;
		}
		disposeAgentPanel();
		disposeInteractiveTasks(this);
	};
};

InteractiveModeBase.prototype.handleEvent = function (this: InteractiveModeBase, event: StartupEvent): Promise<void> {
	const call = forwarding?.mode === this && forwarding.event === event ? forwarding : undefined;
	const result = handleAgentEvent.call(this, event, call);
	if (call?.startup) call.stock = result;
	return result;
};

async function handleAgentEvent(this: InteractiveModeBase, event: StartupEvent, call?: EventForwarding): Promise<void> {
	if ("parentToolCallId" in event && event.parentToolCallId && event.type.startsWith("tool_execution_")) return;
	if (!this.isInitialized) {
		// A caller awaiting handleEvent itself owns its error and may use it for recovery.
		const startup: EventStartup = { mode: new WeakRef(this), strict: true };
		if (call) {
			call.startup = startup;
			if (sessionCloseReason(call.session) === undefined) startup.open = new WeakRef(call.session);
		}
		const sessionStartup = this.sessionStartup;
		await eventStartupScope.run(startup, () => this.init());
		if (sessionStartup?.cancelled || this.sessionStartup?.cancelled) return;
	}

	this.footer.invalidate();
	this.programStatus.handleEvent(event);

	switch (event.type) {
		case "agent_start":
			this.lastWorkingMessage = this.workingMessage;
			// The attempt after a retry's wait or a model fallback continues its turn, and its time and tokens with it. A
			// fallback before a turn's first request (no key for the model) starts the turn's own count.
			if (
				this.retryLoader !== undefined ||
				(this.fallbackLoader !== undefined && this.workingRunMeter.endedOnFailedAttempt())
			)
				this.workingRunMeter.continueRun(event.turnStartedAt);
			else this.workingRunMeter.start(event.turnStartedAt);
			this.pendingTools.clear();
			mainTurnToolBatches.delete(this);
			endMainToolTurn(this);
			if (this.settingsManager.getShowTerminalProgress()) {
				this.ui.terminal.setProgress(true);
			}
			// Restore main escape handler if retry handler is still active
			// (retry success event fires later, but we need main handler now)
			if (this.retryEscapeHandler) {
				this.defaultEditor.onEscape = this.retryEscapeHandler;
				this.retryEscapeHandler = undefined;
			}
			if (this.retryCountdown) {
				this.retryCountdown.dispose();
				this.retryCountdown = undefined;
			}
			if (this.retryLoader) {
				this.retryLoader.stop();
				this.retryLoader = undefined;
			}
			if (this.fallbackLoader) {
				this.fallbackLoader.stop();
				this.fallbackLoader = undefined;
			}
			this.stopWorkingLoader();
			if (this.workingVisible) {
				const loader = this.createWorkingLoader();
				this.loadingAnimation = loader;
				this.workingIndicatorEmbedded = this.setEditorWorkingStatusIndicator?.(loader) ?? false;
				if (!this.workingIndicatorEmbedded) this.statusContainer.addChild(loader);
			}
			this.ui.requestRender();
			break;

		case "turn_start": {
			this.workingRunMeter.requestStarted();
			this.workingMessage = pickWhimsicalWorkingMessage();
			this.lastWorkingMessage = this.workingMessage;
			if (this.loadingAnimation) {
				if ("resetForTurn" in this.loadingAnimation) this.loadingAnimation.resetForTurn(this.workingMessage);
				else this.loadingAnimation.setMessage(this.workingMessage);
			} else if (!this.autoCompactionLoader) {
				// Post-tool compaction interposes this turn_start between
				// compaction_start and compaction_end. Mounting generic Working here
				// would evict the factual compaction status from the shared status
				// container and leave a stale `loadingAnimation` that then blocks the
				// restore at compaction_end, hiding all activity until the next run.
				this.showWorkingLoaderNow();
			}
			break;
		}

		case "turn_end": {
			this.workingMessage = undefined;
			this.stopWorkingLoader();
			this.ui.requestRender();
			break;
		}

		case "queue_update":
			reconcileQueuedSubmissions(this, event);
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			break;

		case "session_info_changed":
			this.updateTerminalTitle();
			this.footer.invalidate();
			this.ui.requestRender();
			break;

		case "model_changed":
			this.refreshBuiltInHeader();
			this.updateEditorBorderColor();
			break;

		case "thinking_level_changed":
			this.footer.invalidate();
			this.refreshBuiltInHeader();
			this.updateEditorBorderColor();
			break;

		case "entry_appended":
			if (event.entry.type === "custom") {
				this.addCustomEntryToChat(event.entry);
			} else if (event.entry.type === "custom_message" && event.entry.display) {
				// Boundary-appended context (turn_end / agent_before_settle drafts) never
				// passes through agent-core message events, so it is rendered from the entry.
				this.addMessageToChat(
					createCustomMessage(
						event.entry.customType,
						event.entry.content,
						event.entry.display,
						event.entry.details,
						event.entry.timestamp,
						event.entry.excludeFromContext,
					),
				);
			} else if (event.entry.type === "compaction") {
				// A boundary-committed compaction has no compaction_end event. Re-render the
				// transcript from the retained context once it becomes the active boundary.
				const entries = this.sessionManager.buildContextEntries();
				if (entries[0]?.id === event.entry.id) {
					this.rebuildChatFromMessages();
					this.footer.invalidate();
				}
			}
			this.ui.requestRender();
			break;

		case "agent_settled":
			this.flushPendingBashComponents();
			this.ui.requestRender();
			await this.checkShutdownRequested();
			break;

		case "message_start":
			if (event.message.role === "user" || (event.message.role === "custom" && event.message.display))
				breakMainToolGroup(this);
			if (event.message.role === "custom") {
				appendNewChildrenBeforeAttachedChild(this.chatContainer, this.streamingComponent, () =>
					this.addMessageToChat(event.message),
				);
				this.ui.requestRender();
			} else if (event.message.role === "user") {
				mainTurnToolBatches.delete(this);
				this.showSessionUserMessage(event.message);
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
			} else if (event.message.role === "assistant") {
				this.streamingComponent = new AssistantMessageComponent(
					undefined,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
					true,
					this.settingsManager.getLatexRenderingEnabled(),
				);
				this.streamingMessage = beginStreamingAssistantMessage(event.message);
				this.chatContainer.addChild(this.streamingComponent);
				this.streamingComponent.updateContent(this.streamingMessage, true);
				this.ui.requestRender();
			}
			break;

		case "message_update": {
			// `message_start` seeds the stream, ordered deltas build it, and
			// `message_end` supplies the authoritative final message.
			if (this.streamingMessage) {
				applyAssistantMessageDelta(this.streamingMessage, event.assistantMessageEvent);
				this.workingRunMeter.streaming(this.streamingMessage);
			}
			if (this.streamingComponent && this.streamingMessage?.role === "assistant") {
				this.streamingComponent.updateContent(this.streamingMessage, true);
				const breaks = mainToolCallBreaks(this, this.streamingMessage);

				for (const content of this.streamingMessage.content) {
					if (content.type === "toolCall") {
						recordMainPendingTool(this, content.id, content.name);
						if (!this.pendingTools.has(content.id)) {
							const component = createToolComponent(this, content.name, content.id, content.arguments);
							component.setExpanded(this.toolOutputExpanded);
							this.chatContainer.addChild(component);
							this.pendingTools.set(content.id, component);
							trackMainToolComponent(this, content.id, content.name, component, breaks.has(content.id));
						} else {
							const component = this.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments);
							}
						}
					}
				}
				this.ui.requestRender();
			}
			break;
		}

		case "message_end":
			if (event.message.role === "user") break;
			this.workingRunMeter.settled(event.message);
			if (this.streamingComponent && event.message.role === "assistant") {
				this.streamingMessage = event.message;
				let errorMessage: string | undefined;
				if (this.streamingMessage.stopReason === "aborted") {
					const existingAbortMessage =
						interruptedNotice(this.streamingMessage.errorMessage) === "Interrupted by user"
							? undefined
							: this.streamingMessage.errorMessage;
					errorMessage = existingAbortMessage ?? "Interrupted by user";
					this.streamingMessage.errorMessage = errorMessage;
				}
				const interruptedActivity =
					this.streamingMessage.stopReason === "aborted" &&
					!hasAssistantVisibleContent(this.streamingMessage.content)
						? currentInterruptedMainTools(this)
						: undefined;
				this.streamingComponent.updateContent(this.streamingMessage, false, interruptedActivity);
				if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
					mainTurnToolBatches.delete(this);
				} else {
					const batch = mainTurnToolBatches.get(this);
					if (batch) batch.aborted = [];
				}
				endMainAssistantMessage(this, this.streamingMessage);

				if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
					if (
						this.streamingMessage.stopReason === "error" &&
						!/\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i.test(this.streamingMessage.errorMessage ?? "")
					)
						void this.maybeShowInstallChangeWarning();
					if (!errorMessage) {
						errorMessage = this.streamingMessage.errorMessage || "Error";
					}
					for (const [toolCallId, component] of this.pendingTools.entries()) {
						component.updateResult({
							content: [{ type: "text", text: errorMessage }],
							isError: true,
						});
						settleMainTool(this, toolCallId, "failed");
					}
					this.pendingTools.clear();
				} else {
					// Args are now complete - trigger diff computation for edit tools
					for (const [, component] of this.pendingTools.entries()) {
						component.setArgsComplete();
					}
					this.maybeShowAssistantDiagnostics(this.streamingMessage);
				}
				this.streamingComponent = undefined;
				this.streamingMessage = undefined;
				this.footer.invalidate();
			}
			if (event.message.role === "assistant" && this.settingsManager.getShowCacheMissNotices()) {
				const miss = detectCacheMiss(
					this.sessionManager.getEntries(),
					event.message,
					createCacheMissModelSource(this.session.modelRuntime),
					this.session.publishingReplyId?.(event.message),
				);
				if (miss) this.chatContainer.addChild(new Text(theme.fg("warning", formatCacheMissNotice(miss)), 1, 0));
			}
			this.ui.requestRender();
			break;

		case "tool_execution_start": {
			recordMainPendingTool(this, event.toolCallId, event.toolName);
			let component = this.pendingTools.get(event.toolCallId);
			if (!component) {
				component = createToolComponent(this, event.toolName, event.toolCallId, event.args);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				this.pendingTools.set(event.toolCallId, component);
				trackMainToolComponent(this, event.toolCallId, event.toolName, component);
			}
			component.markExecutionStarted(observeMainToolStart(this, event.toolCallId));
			this.ui.requestRender();
			break;
		}

		case "tool_execution_update": {
			const component = this.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				this.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			settleMainTurnTool(this, event.toolCallId, event.toolName, event.isError);
			if (event.isError) void this.maybeShowInstallChangeWarning();
			const component = this.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
				this.pendingTools.delete(event.toolCallId);
				settleMainTool(this, event.toolCallId, toolResultGroupState(event.result, event.isError));
				this.ui.requestRender();
			}
			break;
		}

		case "agent_end": {
			const workedSnapshot = this.workingRunMeter.snapshot();
			this.workingRunMeter.stop();
			this.workingMessage = undefined;
			const compactionInProgress = this.compactionActive;
			if (!compactionInProgress && this.settingsManager.getShowTerminalProgress()) {
				this.ui.terminal.setProgress(false);
			}
			if (this.loadingAnimation) this.stopWorkingLoader();
			if (
				workedSnapshot !== undefined &&
				this.workingVisible &&
				!compactionInProgress &&
				!this.loadingAnimation &&
				!this.autoCompactionLoader &&
				!this.retryLoader &&
				!this.fallbackLoader
			) {
				this.statusContainer.clear();
				this.statusContainer.addChild(
					new AtomicWorkedStatusComponent({ message: this.lastWorkingMessage, snapshot: workedSnapshot }),
				);
			}
			if (this.streamingComponent) {
				this.chatContainer.removeChild(this.streamingComponent);
				this.streamingComponent = undefined;
				this.streamingMessage = undefined;
			}
			this.pendingTools.clear();
			mainTurnToolBatches.delete(this);
			endMainToolTurn(this);
			if (this.compactionQueuedMessages.length > 0 && !compactionInProgress) {
				void this.session.agent.waitForIdle().then(() => this.flushCompactionQueue({ willRetry: false }));
			}

			await this.checkShutdownRequested();

			this.ui.requestRender();
			break;
		}

		case "compaction_start": {
			if (this.settingsManager.getShowTerminalProgress()) {
				this.ui.terminal.setProgress(true);
			}
			// Release any loader left behind by an earlier start before mounting a
			// new one; dropping the reference alone leaks its animation timer.
			if (this.autoCompactionLoader) {
				this.autoCompactionLoader.stop();
				this.autoCompactionLoader = undefined;
			}
			// Keep editor active; submissions are queued during compaction.
			// Never clobber an already-saved handler with our own abort closure.
			if (!this.autoCompactionEscapeHandlerSaved) {
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.autoCompactionEscapeHandlerSaved = true;
			}
			this.defaultEditor.onEscape = () => {
				this.session.abortCompaction();
			};
			this.stopWorkingLoader();
			const isOverflowAutoCompaction = event.reason === "overflow";
			const label =
				event.reason === "manual"
					? "Compacting context..."
					: `${isOverflowAutoCompaction ? "Context overflow detected. " : ""}Auto-compacting...`;
			this.autoCompactionLoader = new AtomicWorkingLoader(
				this.ui,
				undefined,
				(text) => theme.fg(isOverflowAutoCompaction ? "warning" : "muted", text),
				label,
			);
			const compactionStartedAt = this.session.compactionStartedAt ?? Date.now();
			this.autoCompactionLoader.setLogo(true);
			this.autoCompactionLoader.setMeta(() => compactionMeta(compactionStartedAt, keyText("app.interrupt")));
			this.statusContainer.addChild(this.autoCompactionLoader);
			this.ui.requestRender();
			break;
		}

		case "compaction_end": {
			const manualTakeoverPending =
				event.reason !== "manual" &&
				(event.manualTakeoverPending === true ||
					this.manualCompactionTakeoverPending ||
					this.session.compactionReason === "manual");
			if (manualTakeoverPending) {
				this.manualCompactionTakeoverPending = true;
			} else if (event.reason === "manual") {
				this.manualCompactionTakeoverPending = false;
			}
			const resumesActiveRun = event.midTurn && !event.aborted && !event.errorMessage && !manualTakeoverPending;
			if (!manualTakeoverPending && !resumesActiveRun && this.settingsManager.getShowTerminalProgress()) {
				this.ui.terminal.setProgress(false);
			}
			if (!manualTakeoverPending && this.autoCompactionEscapeHandlerSaved) {
				this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
				this.autoCompactionEscapeHandler = undefined;
				this.autoCompactionEscapeHandlerSaved = false;
			}
			if (!manualTakeoverPending && this.autoCompactionLoader) {
				this.autoCompactionLoader.stop();
				this.autoCompactionLoader = undefined;
				this.statusContainer.clear();
				mountIdleStatus(this.statusContainer, this.settingsManager.getClearOnShrink());
			}
			if (event.aborted) {
				if (event.reason === "manual") {
					this.showError("Compaction cancelled");
				} else if (!manualTakeoverPending) {
					this.showStatus("Auto-compaction cancelled");
				}
			} else {
				// `result` and `errorMessage` are independent: a committed boundary stays visible when a
				// later step failed, such as the post-tool hard-limit check (#4977).
				if (event.result) {
					this.rebuildChatFromMessages({ suppressCompactionBoundary: event.result });
					this.addCompactionBoundaryToChat(event.result);
					if (event.result.usage) this.addCompactionCostNotice("compaction", event.result.usage);
					this.appendProjectTrustWarning();
					this.footer.invalidate();
				}
				if (event.errorMessage && !manualTakeoverPending) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
			}
			// Post-tool compaction resumes the same active run, so no new
			// agent_start event will recreate the working loader. A successful
			// no-op carries no `result` and still continues that stream.
			if (event.midTurn && !event.aborted && !event.errorMessage && !manualTakeoverPending) {
				this.showWorkingLoaderNow();
			}
			if (!manualTakeoverPending) void this.flushCompactionQueue({ willRetry: event.willRetry });
			this.ui.requestRender();
			break;
		}

		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
			handleSummarizationRetryEvent(this, event);
			break;

		case "auto_retry_start": {
			// Set up escape to abort retry
			this.retryEscapeHandler = this.defaultEditor.onEscape;
			this.defaultEditor.onEscape = () => {
				this.session.abortRetry();
			};
			// Show retry indicator
			this.statusContainer.clear();
			this.retryCountdown?.dispose();
			const pending = this.session.retryStatus;
			const now = Date.now();
			const until = pending?.type === "auto_retry_start" ? pending.retryAt : now + event.delayMs;
			const wait = retryWaitFromEvent({ ...event, retryAt: until });
			const cancel = retryCancelHint();
			// The line fits the columns its row leaves it when it renders, so it never wraps.
			const retryMessage = (seconds: number) => (columns: number) =>
				retryWaitMessage(wait, seconds, cancel, columns);
			this.retryLoader = new AtomicWorkingLoader(
				this.ui,
				undefined,
				(text) => theme.fg("muted", text),
				retryMessage(Math.max(0, Math.ceil((until - now) / 1000))),
			);
			this.retryCountdown =
				until <= now
					? undefined
					: new CountdownTimer(
							{ until },
							this.ui,
							(seconds) => {
								this.retryLoader?.setMessage(retryMessage(seconds));
							},
							() => {
								this.retryCountdown = undefined;
							},
						);
			this.statusContainer.addChild(this.retryLoader);
			this.ui.requestRender();
			break;
		}

		case "model_fallback_start": {
			this.statusContainer.clear();
			if (this.fallbackLoader) {
				this.fallbackLoader.stop();
				this.fallbackLoader = undefined;
			}
			this.fallbackLoader = new Loader(
				this.ui,
				(spinner) => theme.fg("warning", spinner),
				(text) => theme.fg("muted", text),
				`Falling back from ${formatModelLabel(event.from, { thinkingLevel: event.fromThinkingLevel })} to ${formatModelLabel(event.to, { thinkingLevel: event.toThinkingLevel })}...`,
			);
			this.statusContainer.addChild(this.fallbackLoader);
			this.ui.requestRender();
			break;
		}

		case "worktree_snapshot_unavailable": {
			if (!WORKSPACE_ABSENCE_CODES.has(event.reason.code ?? "")) this.showWarning(event.reason.message);
			break;
		}
		case "model_fallback_end": {
			if (!event.success) this.workingRunMeter.stop();
			// A fallback settles after the fallback model's turn ended, whose worked row stays. Only the switch's own
			// indicator goes; a switch that failed before the next request ends the turn's count now.
			if (this.fallbackLoader) {
				this.fallbackLoader.stop();
				this.fallbackLoader = undefined;
				this.statusContainer.clear();
				const failedTurn = this.workingRunMeter.endedOnFailedAttempt();
				mountEndedTurn(this, event.success || !failedTurn ? undefined : this.workingRunMeter.endedRunSnapshot());
			}
			if (!event.success) this.workingRunMeter.endTurn();
			this.ui.requestRender();
			break;
		}
		case "auto_retry_end": {
			// Restore escape handler
			if (this.retryEscapeHandler) {
				this.defaultEditor.onEscape = this.retryEscapeHandler;
				this.retryEscapeHandler = undefined;
			}
			if (this.retryCountdown) {
				this.retryCountdown.dispose();
				this.retryCountdown = undefined;
			}
			// Stop loader. A retry that ends during its wait (cancelled, or out of attempts) ends the turn's count now.
			if (this.retryLoader) {
				this.retryLoader.stop();
				this.retryLoader = undefined;
				this.statusContainer.clear();
				mountEndedTurn(this, event.success ? undefined : this.workingRunMeter.endedRunSnapshot());
			}
			// Show error only on final failure (success shows normal response)
			if (!event.success) {
				this.workingRunMeter.stop();
				this.workingRunMeter.endTurn();
				this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			this.ui.requestRender();
			break;
		}

		case "agent_continue_error": {
			this.workingRunMeter.stop();
			this.stopWorkingLoader();
			this.showError(event.errorMessage);
			this.ui.requestRender();
			break;
		}
	}
	const receipt = chatReceipt(event);
	if (receipt) {
		chatRecordsChanged(this, receipt);
		chatLineDrawnLive(this, receipt.id);
	}
}

InteractiveModeBase.prototype.getUserMessageText = function (this: InteractiveModeBase, message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((c: { type: string }) => c.type === "text");
	return textBlocks.map((c) => (c as { text: string }).text).join("");
};
