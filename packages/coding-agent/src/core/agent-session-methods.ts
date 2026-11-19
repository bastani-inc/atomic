import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@bastani/atomic-agent-core";
import type { ProviderHeaders } from "@bastani/atomic-ai";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "@bastani/atomic-ai/compat";
import type { DetachedToolCall, DetachedToolResult, ToolDetachmentPolicy } from "./agent-session-detached-tools.ts";
import type { PersistenceFailure, UnsavedInput } from "./agent-session-persistence-failures.ts";
import type { PendingPostToolCompactionGuard } from "./agent-session-post-tool-compaction.ts";
import type { RecordedToolLoadout } from "./agent-session-state.ts";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionReloadOptions,
	ClearedQueue,
	ClearQueueOptions,
	DrainedAgentQueues,
	ExtensionBindings,
	InterruptQueueHold,
	ModelCycleResult,
	ModelMutationOptions,
	PromptDisposition,
	PromptOptions,
	QueuedInputDisposition,
	SessionAbortOptions,
	SessionRecoveryReport,
	SessionStats,
	ToolDefinitionEntry,
} from "./agent-session-types.js";
import type { BashResult } from "./bash-executor.ts";
import type { VerbatimCompactionResult } from "./compaction/index.ts";
import type {
	AgentActivityOutcome,
	BoundaryContextPreview,
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionRunner,
	ExtensionUIContext,
	OrchestrationContext,
	ReplacedSessionContext,
	SendMessageOptions,
	SendMessagesOptions,
	SessionBoundaryDraft,
	SessionRecoveryReason,
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.js";
import type { SessionWorkflows } from "./extensions/workflow-run-control.js";
import type { SessionWorkflowsHandle } from "./extensions/workflow-run-control-hub.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ExtensionProviderTransaction, ModelRuntime } from "./model-runtime.js";
import type { PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, SessionEntry, SessionManager, SessionSummaryEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { NormalizedBuildSystemPromptOptions } from "./system-prompt.ts";
import type { ToolStatusReport } from "./tool-status.js";
import type { BashOperations } from "./tools/bash.js";
import type { ToolExecutionScheduler } from "./tools/tool-concurrency.ts";
import type { WorktreeRootMapping } from "./worktree-snapshot/types.ts";

export interface SessionCompactOptions {
	/** Instructions for this compaction: what to recover first, and the compactor's query. */
	query?: string;
	/**
	 * `auto` or an exact compactor model `provider/model` for this run only; overrides the `compactionModel` setting
	 * without saving it. Any other value clears the context with a notice.
	 */
	compactionModel?: string;
}

export interface VerbatimCompactionApplyOptions {
	abortController: AbortController;
	backupLabel: string;
	query?: string;
	compactionModel?: string;
	reason: "manual" | "threshold" | "overflow";
	/** Reports when a session_before_compact override becomes the active compaction source. */
	onCompactionSource?: (fromExtension: boolean) => void;
}

/**
 * How much an automatic compaction is load-bearing: `load_bearing` when the turn cannot continue without it (a provider
 * overflow), `recoverable` otherwise. Only a load-bearing failure marks the overflow unresolved.
 */
export type AutoCompactionUrgency = "recoverable" | "load_bearing";

/** Outcome of an automatic compaction admission and persistence attempt. */
export type AutoCompactionRunOutcome = "compacted" | "not_compactable" | "deferred" | "failed";

export interface ExtensionResourcePathEntry {
	path: string;
	extensionPath: string;
}

export interface ExtensionResourcePathResult {
	path: string;
	metadata: PathMetadata;
}

export interface RuntimeBuildOptions {
	activeToolNames?: string[];
	flagValues?: Map<string, boolean | string>;
	includeAllExtensionTools?: boolean;
	preserveRunner?: boolean;
	powerShellAvailable: boolean;
}

export interface AgentSessionQueuePauseControl {
	readonly queuedMessagesPaused: boolean;
	pauseQueuedMessages(): void;
	/** Release the hold without starting a turn; true means raw queued work was released. */
	resumeQueuedMessages(beforeRelease?: () => void): Promise<boolean>;
}

export interface AgentSessionMethodSurface extends AgentSessionQueuePauseControl {
	readonly orchestrationContext: import("./extensions/index.js").OrchestrationContext | undefined;
	readonly modelRuntime: ModelRuntime;
	readonly state: AgentState;
	readonly model: Model<Api> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly systemPrompt: string;
	readonly retryAttempt: number;
	readonly retryStatus?: import("./session-retry-status.js").SessionRetryStatus;
	/** Time of the current turn's first request, including waits and later attempts; absent between turns. */
	readonly turnStartedAt?: number;
	readonly isCompacting: boolean;
	readonly compactionReason?: import("./agent-session-types.js").CompactionReason;
	readonly compactionStartedAt?: number;
	readonly messages: AgentMessage[];
	/** The settled chat rows, including admitted messages whose save is still in flight. */
	readonly transcriptMessages: AgentMessage[];
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly sessionSummary: SessionSummaryEntry | undefined;
	readonly scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	readonly pendingMessageCount: number;
	readonly resourceLoader: ResourceLoader;
	readonly autoCompactionEnabled: boolean;
	readonly isRetrying: boolean;
	/**
	 * The session waits out a retry's backoff before its next attempt. A session with fallback models keeps its run
	 * open through the wait, so it also reads as streaming then.
	 */
	readonly isWaitingToRetry: boolean;
	readonly autoRetryEnabled: boolean;
	readonly isBashRunning: boolean;
	readonly hasPendingBashMessages: boolean;
	readonly extensionRunner: ExtensionRunner;
	/** Typed management of the workflow runs this session owns. */
	readonly workflows: SessionWorkflows;

	_handleAgentEvent(event: AgentEvent): Promise<void> | void;
	_getRequiredRequestAuth(
		model: Model<Api>,
		signal?: AbortSignal,
	): Promise<{ apiKey?: string; headers?: ProviderHeaders; baseUrl?: string }>;
	_installAgentToolHooks(): void;
	_installAgentNextTurnRefresh(): void;
	_installAgentRequestProjection(): void;
	_installAgentBoundaryHooks(): void;
	_refreshFinalizedContext(): void;
	_projectFinalizedMessages(): AgentMessage[];
	refreshContext(): void;
	_dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
		awaitPersistence?: boolean,
	): Promise<boolean>;
	_applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): Promise<SessionEntry[]>;
	_createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): Promise<SessionManager>;
	_getPendingBoundaryMessages(): AgentMessage[];
	_buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): Promise<BoundaryContextPreview>;
	_commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): Promise<void>;
	_reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void;
	_findPersistedMessageEntryId(message: AgentMessage): string | undefined;
	_omitRecoveryAttempt(message: AssistantMessage, toolResults?: AgentMessage[]): Promise<void>;
	_omitTrailingAssistantAttempt(accept?: (message: AssistantMessage) => boolean): Promise<boolean>;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_emit(event: AgentSessionEvent): void;
	_emitQueueUpdate(): void;
	_createRetryPromiseForAgentEnd(event: AgentEvent): void;
	_findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined;
	_processAgentEvent(event: AgentEvent, retryGeneration?: number): Promise<void>;
	_applyInterruptAbortMessage(event: AgentEvent): void;
	_applyProviderErrorGuidance(event: AgentEvent): void;
	_resolveRetry(): void;
	_getUserMessageText(message: Message): string;
	_findLastAssistantMessage(): AssistantMessage | undefined;
	_replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void;
	_emitExtensionEvent(event: AgentEvent): Promise<void>;
	subscribe(
		source: import("./event-subscriptions/types.js").EventSource,
		handler: import("./event-subscriptions/session-subscription.js").SessionEventHandler,
		options?: import("./event-subscriptions/session-subscription.js").SessionSubscribeOptions,
	): import("./event-subscriptions/types.js").Subscription;
	subscribe(listener: AgentSessionEventListener): () => void;
	_disconnectFromAgent(): void;
	dispose(): Promise<void>;
	getAgentTaskHost(): import("./tasks/agent-adapter.js").AgentTaskHost;
	_getCommandTaskOwner(): import("./tools/bash-pty-native.js").SupervisedCommandOwner | undefined;
	closeSessionTasks(): Promise<void>;
	/** Internal workflow pause: cancel owned execution without closing message admission. */
	pauseTasks(): Promise<void>;
	resumeTasks(): void;

	getActiveToolNames(): string[];
	getCallableToolNames(): string[];
	getAllTools(): ToolInfo[];
	getToolDefinition(name: string): ToolDefinition | undefined;
	/** Explain which tools are active, which are not (and why), and which selected names nothing registered. */
	getToolStatus(): ToolStatusReport;
	getToolStatusAsync(): Promise<ToolStatusReport>;
	setActiveToolsByName(toolNames: string[]): void;
	_setActiveTools(toolNames: string[]): void;
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void;
	_normalizePromptSnippet(text: string | undefined): string | undefined;
	_normalizePromptGuidelines(guidelines: string[] | undefined): string[];
	_rebuildSystemPrompt(toolNames: string[]): void;
	_preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages?: AgentMessage[],
	): import("@bastani/atomic-ai").SystemMessage | undefined;
	_restoreToolsFromTranscript(options?: { startup?: boolean }): void;
	_refreshBaseSystemPromptFromActiveTools(): void;
	_currentRunSystemPromptOptions(): NormalizedBuildSystemPromptOptions;
	_recordSystemPromptForModelSwitch(): Promise<void>;

	prompt(text: string, options?: PromptOptions): Promise<void>;
	_runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		promptStarted?: () => void,
		reportDispatch?: (disposition: PromptDisposition) => void,
		prepared?: boolean,
		customStarter?: CustomMessage,
		fallbackGeneration?: number,
	): Promise<void>;
	_runAgentContinue(): Promise<void>;
	_runAgentContinuation(beforeContinue: () => Promise<void>, mode?: "continue" | "recovery" | "settle"): Promise<void>;
	_continueQueuedAgentMessages(): Promise<void>;
	_tryExecuteExtensionCommand(text: string): Promise<boolean>;
	_expandSkillCommand(text: string): Promise<string>;
	steer(
		text: string,
		images?: ImageContent[],
		options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
	): Promise<QueuedInputDisposition>;
	followUp(
		text: string,
		images?: ImageContent[],
		options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
	): Promise<QueuedInputDisposition>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;

	_queueSteer(text: string, images?: ImageContent[], typed?: string, rawText?: string): Promise<void>;
	_queueFollowUp(text: string, images?: ImageContent[], typed?: string, rawText?: string): Promise<void>;
	_throwIfExtensionCommand(text: string): void;
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendMessageOptions,
	): Promise<void>;
	sendCustomMessages<T = unknown>(
		messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
		options?: SendMessagesOptions,
	): Promise<void>;
	_commitAdmittedCustomMessage<T>(message: CustomMessage<T>, options?: SendMessageOptions): Promise<void>;
	_commitAdmittedCustomMessages<T>(messages: CustomMessage<T>[], options?: SendMessagesOptions): Promise<void>;
	_appendCustomMessage<T>(message: CustomMessage<T>): Promise<void>;
	_flushPendingCustomMessages(withinRun?: boolean): Promise<void>;
	_enqueueInterruptCustomMessage<T>(message: CustomMessage<T>, options?: SendMessageOptions): Promise<void>;
	_sendInterruptCustomMessageNow<T>(message: CustomMessage<T>, options?: SendMessageOptions): Promise<void>;
	_ensureActiveInterruptQueueHold(): InterruptQueueHold;
	_restoreAndClearActiveInterruptQueueHold(): void;
	_queueAgentMessage(message: AgentMessage, delivery: "steer" | "followUp" | "interrupt"): void;
	_drainQueuedAgentMessages(): DrainedAgentQueues;
	_restoreQueuedAgentMessages(queues: DrainedAgentQueues): void;
	clearQueue(options?: ClearQueueOptions): ClearedQueue;
	getSteeringMessages(): readonly string[];
	getFollowUpMessages(): readonly string[];
	abort(options?: SessionAbortOptions): Promise<void>;
	/** Ends the current turn without closing the session to further messages, as Esc does in a subagent's chat. */
	interruptTurn(): Promise<void>;
	_sealMessageAdmissionIfDrained(): boolean;
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;

	_emitModelChanged(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore" | "fallback",
	): void;
	_emitModelSelect(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore" | "fallback",
	): Promise<void>;
	setModel(model: Model<Api>, options?: ModelMutationOptions & { thinkingLevel?: ThinkingLevel }): Promise<void>;
	cycleModel(
		direction?: "forward" | "backward",
		options?: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined>;
	_cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined>;
	_cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined>;
	setThinkingLevel(level: ThinkingLevel, options?: ModelMutationOptions): Promise<void>;
	cycleThinkingLevel(options?: ModelMutationOptions): Promise<ThinkingLevel | undefined>;
	getAvailableThinkingLevels(): ThinkingLevel[];
	supportsThinking(): boolean;
	_getThinkingLevelForModelSwitch(targetModel?: Model<Api>, explicitLevel?: ThinkingLevel): ThinkingLevel;
	_clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel;
	_recordThinkingLevel(): Promise<string> | undefined;

	_applyVerbatimCompaction(options: VerbatimCompactionApplyOptions): Promise<VerbatimCompactionResult | undefined>;
	compact(options?: SessionCompactOptions): Promise<VerbatimCompactionResult>;
	abortCompaction(): void;
	abortBranchSummary(): void;
	abortSessionSummary(): void;
	_maybeGenerateSessionSummary(): Promise<void>;
	_checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck?: boolean): Promise<void>;
	_compactBeforeContinuation(): Promise<boolean>;
	_continueAgentAfterCompactionCheck(): Promise<void>;
	_dropTrailingAutoCompactionRetryAssistantIfPresent(): Promise<void>;
	_schedulePostAutoCompactionContinuationProbe(reason: "overflow" | "threshold", willRetry: boolean): void;
	_awaitPendingPostCompactionContinuation(): Promise<void>;
	_resumeAfterAutoCompaction(): Promise<void>;
	_resumeAfterLengthTruncation(): Promise<void>;
	_runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		urgency?: AutoCompactionUrgency,
	): Promise<AutoCompactionRunOutcome>;
	_preflightPostToolContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
	_finishPostToolCompactionPreflight(messages: AgentMessage[]): AgentMessage[];
	setAutoCompactionEnabled(enabled: boolean): void;
	/** Give an agent without `read` or `search` the read-only `session_history` tool after a compaction boundary. */
	_enableSessionHistoryTool(): void;

	bindExtensions(bindings: ExtensionBindings): Promise<void>;
	startPendingRecovery(reason?: SessionRecoveryReason): Promise<SessionRecoveryReport>;
	/** Keep only the stored history and let go of everything live; rehydrate with `AgentSessionRuntime.rehydrate`. */
	release(): Promise<import("./agent-session-release.ts").ReleasedAgentSession>;
	/** Let calls of `detachable` tools that run longer than `policy.afterMs` go on without the run; `undefined` runs them inline. */
	setToolDetachment(policy: ToolDetachmentPolicy | undefined): void;
	/** The calls the session's runs detached and the host has not taken yet; taking them clears the list. */
	takeDetachedToolCalls(): DetachedToolCall[];
	/** Whether the transcript ends on a turn that issued a detachable call and has no answer from the model yet. */
	hasPendingDetachedTurn(): boolean;
	/** Whether the transcript still waits on the result of a call of a detachable tool: nothing may start a turn. */
	isWaitingOnDetachedResults(): boolean;
	/** Start again the detachable calls the transcript ends on without a result, with their original ids and arguments. */
	redispatchDetachedToolCalls(): DetachedToolCall[];
	/** Record detached calls' results; the turn that issued them continues once each of its detachable calls has one. */
	resumeDetachedTurn(
		results: readonly DetachedToolResult[],
		onRecorded?: (toolCallIds: readonly string[]) => void,
	): Promise<void>;
	_waitForExtensionStart(): Promise<void>;
	extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void>;
	buildExtensionResourcePaths(entries: ExtensionResourcePathEntry[]): ExtensionResourcePathResult[];
	getExtensionSourceLabel(extensionPath: string): string;
	_applyExtensionBindings(runner: ExtensionRunner): void;
	_refreshCurrentModelFromRegistry(): Promise<void>;
	refreshCurrentModelFromRegistry(): Promise<void>;
	_bindExtensionCore(
		runner: ExtensionRunner,
		publication?: {
			resourceLoader: ResourceLoader;
			providerTransaction: ExtensionProviderTransaction;
			providerIds: Set<string>;
			defer(effect: () => void | Promise<void>): void;
		},
		startupToolNames?: readonly string[],
		startupLoadout?: RecordedToolLoadout,
	): void;
	_refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void;
	_buildRuntime(options: RuntimeBuildOptions): void;
	reload(options?: AgentSessionReloadOptions): Promise<void>;
	completeStartupResources(resourceLoader: ResourceLoader): Promise<void>;

	_isRetryableError(message: AssistantMessage): boolean;
	_isFallbackableError(message: AssistantMessage): boolean;
	_isEmptyCompletion(message: AssistantMessage): boolean;
	_isSafetyRefusal(message: AssistantMessage): boolean;
	_handleRetryableError(message: AssistantMessage): Promise<boolean>;
	_trySwitchToFallbackModel(message: AssistantMessage): Promise<boolean>;
	_selectModelWithCredentials(): Promise<void>;
	_beginFallbackModelScope(): void;
	_clearFallbackModelScope(): void;
	_settleFallbackModelScope(): Promise<boolean>;
	abortRetry(): void;
	waitForRetry(): Promise<void>;
	setAutoRetryEnabled(enabled: boolean): void;

	executeBash(
		command: string,
		onChunk?: (chunk: string, channel: "stdout" | "stderr") => void,
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
			pty?: boolean;
			emitEvent?: boolean;
			recordResult?: boolean;
		},
	): Promise<BashResult>;
	recordBashResult(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean; persist?: boolean; defer?: boolean },
	): Promise<void>;
	abortBash(id?: string): void;
	_flushPendingBashMessages(): Promise<void>;

	setSessionName(name: string): Promise<void>;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }>;
	getUserMessagesForForking(): Array<{ entryId: string; text: string }>;
	_extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string;

	getSessionStats(): SessionStats;
	getContextUsage(): ContextUsage | undefined;
	exportToHtml(outputPath?: string, options?: { themeName?: string }): Promise<string>;
	/**
	 * `snapshotContent: false` leaves worktree snapshot patch and bundle content out of the file, and
	 * `toolOutputContent: false` the tool outputs kept as session blobs.
	 */
	exportToJsonl(
		outputPath?: string,
		options?: { includeShareContext?: boolean; snapshotContent?: boolean; toolOutputContent?: boolean },
	): Promise<string>;
	getLastAssistantText(): string | undefined;
	createReplacedSessionContext(): ReplacedSessionContext;
	sealWorkflowStageGeneration(): void;
	closeWorkflowStageGeneration(): Promise<void>;
	transferWorkflowStageDeliveriesTo(target: object): void;
	hasExtensionHandlers(eventType: string): boolean;
	getPersistenceFailure(): PersistenceFailure | undefined;
	getUnsavedInput(): UnsavedInput | undefined;
	discardUnsavedInput(): void;
}

export interface AgentSessionPublicSurface
	extends Pick<
		AgentSessionMethodSurface,
		| "orchestrationContext"
		| "getAgentTaskHost"
		| "closeSessionTasks"
		| "modelRuntime"
		| "state"
		| "model"
		| "thinkingLevel"
		| "isStreaming"
		| "systemPrompt"
		| "retryAttempt"
		| "retryStatus"
		| "turnStartedAt"
		| "isCompacting"
		| "compactionReason"
		| "compactionStartedAt"
		| "messages"
		| "transcriptMessages"
		| "steeringMode"
		| "followUpMode"
		| "sessionFile"
		| "sessionId"
		| "sessionName"
		| "sessionSummary"
		| "scopedModels"
		| "promptTemplates"
		| "pendingMessageCount"
		| "resourceLoader"
		| "autoCompactionEnabled"
		| "isRetrying"
		| "isWaitingToRetry"
		| "autoRetryEnabled"
		| "abortSessionSummary"
		| "isBashRunning"
		| "hasPendingBashMessages"
		| "extensionRunner"
		| "workflows"
		| "queuedMessagesPaused"
		| "pauseQueuedMessages"
		| "resumeQueuedMessages"
		| "subscribe"
		| "dispose"
		| "getActiveToolNames"
		| "getCallableToolNames"
		| "getAllTools"
		| "getToolDefinition"
		| "getToolStatus"
		| "getToolStatusAsync"
		| "setActiveToolsByName"
		| "setScopedModels"
		| "prompt"
		| "steer"
		| "followUp"
		| "sendCustomMessage"
		| "sendCustomMessages"
		| "sendUserMessage"
		| "clearQueue"
		| "getSteeringMessages"
		| "getFollowUpMessages"
		| "abort"
		| "interruptTurn"
		| "setModel"
		| "cycleModel"
		| "setThinkingLevel"
		| "cycleThinkingLevel"
		| "getAvailableThinkingLevels"
		| "supportsThinking"
		| "setSteeringMode"
		| "setFollowUpMode"
		| "compact"
		| "abortCompaction"
		| "abortBranchSummary"
		| "setAutoCompactionEnabled"
		| "bindExtensions"
		| "startPendingRecovery"
		| "release"
		| "setToolDetachment"
		| "takeDetachedToolCalls"
		| "hasPendingDetachedTurn"
		| "isWaitingOnDetachedResults"
		| "redispatchDetachedToolCalls"
		| "resumeDetachedTurn"
		| "refreshCurrentModelFromRegistry"
		| "reload"
		| "completeStartupResources"
		| "abortRetry"
		| "setAutoRetryEnabled"
		| "executeBash"
		| "recordBashResult"
		| "abortBash"
		| "setSessionName"
		| "navigateTree"
		| "getUserMessagesForForking"
		| "getSessionStats"
		| "getContextUsage"
		| "refreshContext"
		| "exportToHtml"
		| "exportToJsonl"
		| "getLastAssistantText"
		| "createReplacedSessionContext"
		| "hasExtensionHandlers"
		| "getPersistenceFailure"
		| "getUnsavedInput"
		| "discardUnsavedInput"
	> {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
}

export interface AgentSessionInternalSurface extends AgentSessionMethodSurface, AgentSessionPublicSurface {
	_scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	_fallbackModels: string[];
	_isFallbackModelAllowed?: (model: Model<Api>, effort: string | undefined) => boolean;
	_fallbackAttemptedKeys: Set<string>;
	_fallbackBlockedModels: Array<Model<Api>>;
	_fallbackBlockedProviders: Set<string>;
	_fallbackOriginModel: Model<Api> | undefined;
	_fallbackOriginThinkingLevel: ThinkingLevel | undefined;
	_fallbackScopeGeneration: number;
	_fallbackOriginGeneration: number | undefined;
	_fallbackRestoreError: string | undefined;

	_unsubscribeAgent?: () => void;
	_eventListeners: AgentSessionEventListener[];
	_agentEventQueue: Promise<void>;
	_steeringMessages: string[];
	_followUpMessages: string[];
	_interruptDeliveryQueue: Promise<void>;
	_pendingPostCompactionContinuation: Promise<void> | undefined;
	_postCompactionContinuationToken: number;
	_lengthContinuationAttempts: number;
	_outputBudgetErrorContinuationAttempts: number;
	_postToolCompactionPreflightError: string | undefined;
	_pendingPostToolCompactionGuard: PendingPostToolCompactionGuard | undefined;
	/** Set once a compaction boundary gave this restricted agent the `session_history` tool. */
	_sessionHistoryToolEnabled: boolean;
	_terminatingToolCallIds: Set<string>;
	_stopAfterTurnBlockedContinuation: boolean;
	/** The current turn was ended by {@link interruptTurn}: a child's message admission stays open after it. */
	_turnInterruptedByUser: boolean;
	_abortPreparedRunAtStart: boolean;
	_startAbortedForInterrupt: boolean;
	_awaitingStartAfterInterrupt: boolean;
	_undeliveredAgentStarts: number;
	/** A child whose turn the user interrupted waits here: the next message it receives starts its next turn. */
	_awaitingMessageAfterInterrupt: boolean;
	_pendingInterruptDeliveries: number;
	_priorityInterruptPending: boolean;
	_activePromptCount: number;
	_isPreparingRun: false | "user" | "custom";
	_promptPreflightCount: number;
	_agentRunAbortRequested: boolean;
	_cacheWarmer?: import("./cache-warmer.ts").CacheWarmer;
	_activeInterruptQueueHold: InterruptQueueHold | undefined;
	_queuedMessagesPaused: boolean;
	_queuedMessagesPauseAbortBoundary: Promise<void> | undefined;
	_admittedQueuedMessageAwaitingReply: string | undefined;
	_admittedRecoveryTurn: Promise<void> | undefined;
	_workflowStageDeliveryForwardTarget: AgentSessionInternalSurface | undefined;
	_activeInterruptAbortMessage: string | undefined;
	_pendingNextTurnMessages: CustomMessage[];
	_pendingCustomMessages: CustomMessage[];
	_protectedStreamingCustomMessages: Array<{
		message: CustomMessage;
		delivery: "steer" | "followUp";
		phase: "queued" | "consumed-unpersisted" | "persistence-failed";
	}>;
	_compactionAbortController: AbortController | undefined;
	_manualCompactionPromise: Promise<VerbatimCompactionResult> | undefined;
	_autoCompactionAbortController: AbortController | undefined;
	/** Stops the compactor request of the running compaction, which then clears the context instead. */
	_compactorAbortController: AbortController | undefined;
	_autoCompactionCompletion: Promise<void> | undefined;
	_compactionReason: import("./agent-session-types.js").CompactionReason | undefined;
	_compactionStartedAt: number | undefined;
	_overflowRecoveryAttempted: boolean;
	_recoverableLengthRecoveryAttempted: boolean;
	_contextOverflowUnresolved: boolean;
	_branchSummaryAbortController: AbortController | undefined;
	_branchSummaryCompletion: Promise<void> | undefined;
	_retryAbortController: AbortController | undefined;
	_retryAttempt: number;
	_retryStatus?: import("./session-retry-status.js").SessionRetryStatus;
	_turnStartedAt?: number;
	_longStreamCutRetries: number;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_retryGeneration: number;
	_agentRunRetryGeneration: number;
	_bashAbortControllers: Map<string | symbol, Set<AbortController>>;
	_pendingBashMessages: BashExecutionMessage[];
	_runOnlyBashMessages?: WeakSet<object>;
	_extensionRunner: ExtensionRunner;
	_workflows?: SessionWorkflowsHandle;
	_turnIndex: number;
	readonly _entryIdsByMessage: WeakMap<object, string>;
	readonly _boundaryDispatchedMessages: WeakSet<object>;
	readonly _messagesAwaitingPersistence: WeakMap<object, Promise<void>>;
	_transcriptAppend: { message: AgentMessage; previousLeaf: string | null } | undefined;
	readonly _messagesWithFailedPersistence: WeakSet<object>;
	_persistenceFailure: string | undefined;
	_turnStopReason: string | undefined;
	_worktreeSnapshots: import("./session-worktree-snapshots.ts").SessionWorktreeSnapshotRecorder;
	readonly _reissuedToolCallIds: Set<string>;
	_lastAssistantToolResults: AgentMessage[];
	_lastActivityOutcome: AgentActivityOutcome;
	_isBeforeSettle: boolean;
	_abortDuringBeforeSettle: boolean;
	_isEmittingAgentSettled: boolean;
	readonly _deferredSettledActions: Array<() => Promise<void>>;
	_callerReplacedNextRequestContext: boolean;
	_resourceLoader: ResourceLoader;
	_customTools: ToolDefinition[];
	_baseToolDefinitions: Map<string, ToolDefinition>;
	_cwd: string;
	_extensionRunnerRef?: { current?: ExtensionRunner };
	_initialActiveToolNames?: string[];
	_pendingToolNames: Set<string>;
	_restoredToolNames: Set<string>;
	_explicitToolDeactivations: Set<string>;
	_usesDefaultTools: boolean;
	_defaultToolModifiers: string[];
	_appliedDefaultTools: Set<string>;
	_allowedToolNames?: Set<string>;
	_excludedToolNames?: Set<string>;
	_allowedTools?: (name: string) => boolean;
	_excludedTools?: (name: string) => boolean;
	_childSessionOptions?: import("./child-session-options.ts").ChildSessionOptionsResolver;
	_workflowJournal?: import("./storage/provider.js").RunJournalOption;
	_storageAgentDir?: string;
	_baseToolsOverride?: Record<string, AgentTool>;
	_sessionStartEvent: SessionStartEvent;
	_orchestrationContext?: OrchestrationContext;
	_workspace?: import("./workspace/resolve.ts").BoundWorkspace;
	_subagentPolicy?: import("./extensions/index.js").SubagentChildPolicy;
	_intercomPolicy?: import("./intercom-policy.ts").SessionIntercomPolicy;
	_subagentMessageAdmission?: import("./workflow-stage-admission.ts").WorkflowStageAdmissionBoundary;
	_extensionUIContext?: ExtensionUIContext;
	_extensionHumanInput?: import("./extensions/host-input.js").HostInput | null;
	_extensionDiagnosticListener?: (diagnostic: import("./extensions/host-input.js").HostDiagnostic) => void;
	_extensionMode: ExtensionMode;
	_disposed: boolean;
	_close(event: import("./extensions/types.ts").SessionShutdownEvent, beforeInvalidate?: () => void): Promise<void>;
	_sessionSummaryAbortController: AbortController | undefined;
	_sessionSummaryToken: number;
	_sessionSummaryRun: import("./agent-session-summary.ts").SessionSummaryRun | undefined;
	_lastSummarizedMessageId: string | undefined;
	_extensionCommandContextActions?: ExtensionCommandContextActions;
	_extensionShutdownHandler?: () => void;
	_extensionErrorListener?: ExtensionErrorListener;
	_extensionErrorUnsubscriber?: () => void;
	_modelRuntime: ModelRuntime;
	_extensionProviderIds: Set<string>;
	_toolRegistry: Map<string, AgentTool>;
	_toolExecutionScheduler: ToolExecutionScheduler;
	_outerWorktreeRootMappings: readonly WorktreeRootMapping[];
	_worktreeRestoreNotices: readonly string[];
	_toolDefinitions: Map<string, ToolDefinitionEntry>;
	_toolPromptSnippets: Map<string, string>;
	_toolPromptGuidelines: Map<string, string[]>;
	_baseSystemPromptOptions: NormalizedBuildSystemPromptOptions;
	_systemPromptTransform?: (prompt: string) => string;
	_contextProjectionTransform?: (messages: AgentMessage[]) => AgentMessage[];
	_runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;
	_lastAssistantMessage: AssistantMessage | undefined;
	_tempStorageLease: import("./tools/session-temp-dir.ts").ProtectedPathLease | undefined;
	_sessionOpenMarker: (() => Promise<void>) | undefined;
	_workflowStageAdmission: import("./workflow-stage-admission.ts").WorkflowStageAdmissionBoundary | undefined;
	_workflowStageAwaitingFirstPrompt: boolean;
	_agentTaskHost: import("./tasks/agent-adapter.js").AgentTaskHost | undefined;
	_parentCommandTaskOwner: import("./tasks/child-command-owner.js").ChildCommandTaskOwner | undefined;
	_inheritedHistory: import("./tools/history-protocol.ts").ProjectHistory | undefined;
	_resourceAdmission: import("./sdk-types.ts").ResourceAdmission | undefined;
	_childTaskWaits: import("./tasks/child-command-owner.js").ChildTaskWaits;
	_taskCompletionOutbox: import("./tasks/completion.js").TaskCompletionOutbox | undefined;
	_taskAdmission: import("./workflow-stage-admission.ts").WorkflowStageAdmissionBoundary | undefined;
}
