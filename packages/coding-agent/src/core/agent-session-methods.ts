import type { ProviderHeaders } from "@bastani/pi-ai";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "@bastani/pi-ai/compat";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { PendingPostToolCompactionGuard } from "./agent-session-post-tool-compaction.ts";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	AgentSessionReloadOptions,
	ClearQueueOptions,
	DrainedAgentQueues,
	ExtensionBindings,
	InterruptQueueHold,
	ModelCycleResult,
	ModelMutationOptions,
	PromptOptions,
	SessionStats,
	ToolDefinitionEntry,
} from "./agent-session-types.js";
import type { BashResult } from "./bash-executor.ts";
import type {
	CompactionUrgency,
	PlannerAuth,
	VerbatimCompactionParameters,
	VerbatimCompactionResult,
} from "./compaction/index.ts";
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
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ExtensionProviderTransaction, ModelRuntime } from "./model-runtime.js";
import type { PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { NormalizedBuildSystemPromptOptions } from "./system-prompt.ts";
import type { BashOperations } from "./tools/bash.js";

export interface VerbatimCompactionApplyOptions {
	/** Per-model planner credentials; a borrowed fallback uses its own, never the session model's. */
	resolvePlannerAuth: (model: Model<Api>) => Promise<PlannerAuth | undefined>;
	abortController: AbortController;
	backupLabel: string;
	compression_ratio?: number;
	preserve_recent?: number;
	query?: string;
	reason: "manual" | "threshold" | "overflow";
	/** Reports when a session_before_compact override becomes the active compaction source. */
	onCompactionSource?: (fromExtension: boolean) => void;
	/** Only `load_bearing` may reach the context-destroying fresh rung. */
	urgency: CompactionUrgency;
	/**
	 * Admit a compactable region below the planner minimum.
	 *
	 * Narrow on purpose. Overflow recovery sets it because a real provider
	 * overflow is already known, and the post-tool preflight sets it only when its
	 * projected context is genuinely over the provider hard input limit. A
	 * threshold crossing that still fits must not clear context: the follow-up
	 * request can be sent as-is.
	 */
	allowSmallRegion?: boolean;
}

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
	readonly isCompacting: boolean;
	readonly compactionReason?: import("./agent-session-types.js").CompactionReason;
	readonly messages: AgentMessage[];
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	readonly pendingMessageCount: number;
	readonly resourceLoader: ResourceLoader;
	readonly autoCompactionEnabled: boolean;
	readonly isRetrying: boolean;
	readonly autoRetryEnabled: boolean;
	readonly isBashRunning: boolean;
	readonly hasPendingBashMessages: boolean;
	readonly extensionRunner: ExtensionRunner;

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
	_applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[];
	_createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager;
	_getPendingBoundaryMessages(): AgentMessage[];
	_buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview;
	_commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void;
	_reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void;
	_findPersistedMessageEntryId(message: AgentMessage): string | undefined;
	_omitRecoveryAttempt(message: AssistantMessage, toolResults?: AgentMessage[]): void;
	_omitTrailingAssistantAttempt(accept?: (message: AssistantMessage) => boolean): boolean;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_emit(event: AgentSessionEvent): void;
	_emitQueueUpdate(): void;
	_createRetryPromiseForAgentEnd(event: AgentEvent): void;
	_findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined;
	_processAgentEvent(event: AgentEvent): Promise<void>;
	_applyInterruptAbortMessage(event: AgentEvent): void;
	_applyProviderErrorGuidance(event: AgentEvent): void;
	_resolveRetry(): void;
	_getUserMessageText(message: Message): string;
	_findLastAssistantMessage(): AssistantMessage | undefined;
	_replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void;
	_emitExtensionEvent(event: AgentEvent): Promise<void>;
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
	getAllTools(): ToolInfo[];
	getToolDefinition(name: string): ToolDefinition | undefined;
	setActiveToolsByName(toolNames: string[]): void;
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void;
	_normalizePromptSnippet(text: string | undefined): string | undefined;
	_normalizePromptGuidelines(guidelines: string[] | undefined): string[];
	_rebuildSystemPrompt(toolNames: string[]): void;
	_preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages?: AgentMessage[],
	): import("@bastani/pi-ai").SystemMessage | undefined;
	_restoreToolsFromTranscript(): void;
	_refreshBaseSystemPromptFromActiveTools(): void;

	prompt(text: string, options?: PromptOptions): Promise<void>;
	_runAgentPrompt(messages: AgentMessage | AgentMessage[], promptStarted?: () => void): Promise<void>;
	_runAgentContinue(): Promise<void>;
	_continueQueuedAgentMessages(): Promise<void>;
	_tryExecuteExtensionCommand(text: string): Promise<boolean>;
	_expandSkillCommand(text: string): string;
	steer(text: string, images?: ImageContent[], options?: Pick<PromptOptions, "source">): Promise<void>;
	followUp(text: string, images?: ImageContent[], options?: Pick<PromptOptions, "source">): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;

	_queueSteer(text: string, images?: ImageContent[]): Promise<void>;
	_queueFollowUp(text: string, images?: ImageContent[]): Promise<void>;
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
	_appendCustomMessage<T>(message: CustomMessage<T>): void;
	_flushPendingCustomMessages(): void;
	_enqueueInterruptCustomMessage<T>(message: CustomMessage<T>, options?: SendMessageOptions): Promise<void>;
	_sendInterruptCustomMessageNow<T>(message: CustomMessage<T>, options?: SendMessageOptions): Promise<void>;
	_ensureActiveInterruptQueueHold(): InterruptQueueHold;
	_restoreAndClearActiveInterruptQueueHold(): void;
	_queueAgentMessage(message: AgentMessage, delivery: "steer" | "followUp" | "interrupt"): void;
	_drainQueuedAgentMessages(): DrainedAgentQueues;
	_restoreQueuedAgentMessages(queues: DrainedAgentQueues): void;
	clearQueue(options?: ClearQueueOptions): { steering: string[]; followUp: string[] };
	getSteeringMessages(): readonly string[];
	getFollowUpMessages(): readonly string[];
	abort(): Promise<void>;
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
	setModel(model: Model<Api>, options?: ModelMutationOptions): Promise<void>;
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
	setThinkingLevel(level: ThinkingLevel, options?: ModelMutationOptions): void;
	cycleThinkingLevel(options?: ModelMutationOptions): ThinkingLevel | undefined;
	getAvailableThinkingLevels(): ThinkingLevel[];
	supportsThinking(): boolean;
	_getThinkingLevelForModelSwitch(targetModel?: Model<Api>, explicitLevel?: ThinkingLevel): ThinkingLevel;
	_clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel;

	_applyVerbatimCompaction(options: VerbatimCompactionApplyOptions): Promise<VerbatimCompactionResult | undefined>;
	compact(options?: Partial<VerbatimCompactionParameters>): Promise<VerbatimCompactionResult>;
	abortCompaction(): void;
	abortBranchSummary(): void;
	abortSessionSummary(): void;
	_maybeGenerateSessionSummary(): Promise<void>;
	_checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck?: boolean): Promise<void>;
	_dropTrailingAutoCompactionRetryAssistantIfPresent(): void;
	_schedulePostAutoCompactionContinuationProbe(reason: "overflow" | "threshold", willRetry: boolean): void;
	_awaitPendingPostCompactionContinuation(): Promise<void>;
	_resumeAfterAutoCompaction(): Promise<void>;
	_resumeAfterLengthTruncation(): void;
	_runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		urgency?: CompactionUrgency,
	): Promise<AutoCompactionRunOutcome>;
	_preflightPostToolContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
	_finishPostToolCompactionPreflight(messages: AgentMessage[]): AgentMessage[];
	setAutoCompactionEnabled(enabled: boolean): void;

	bindExtensions(bindings: ExtensionBindings): Promise<void>;
	extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void>;
	buildExtensionResourcePaths(entries: ExtensionResourcePathEntry[]): ExtensionResourcePathResult[];
	getExtensionSourceLabel(extensionPath: string): string;
	_applyExtensionBindings(runner: ExtensionRunner): void;
	_refreshCurrentModelFromRegistry(): void;
	refreshCurrentModelFromRegistry(): void;
	_bindExtensionCore(
		runner: ExtensionRunner,
		publication?: {
			resourceLoader: ResourceLoader;
			providerTransaction: ExtensionProviderTransaction;
			providerIds: Set<string>;
			defer(effect: () => void | Promise<void>): void;
		},
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
	): void;
	abortBash(id?: string): void;
	_flushPendingBashMessages(): void;

	setSessionName(name: string): void;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }>;
	getUserMessagesForForking(): Array<{ entryId: string; text: string }>;
	_extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string;

	getSessionStats(): SessionStats;
	getContextUsage(): ContextUsage | undefined;
	exportToHtml(outputPath?: string, options?: { themeName?: string }): Promise<string>;
	exportToJsonl(outputPath?: string, options?: { includeShareContext?: boolean }): string;
	getLastAssistantText(): string | undefined;
	createReplacedSessionContext(): ReplacedSessionContext;
	sealWorkflowStageGeneration(): void;
	closeWorkflowStageGeneration(): Promise<void>;
	transferWorkflowStageDeliveriesTo(target: object): void;
	hasExtensionHandlers(eventType: string): boolean;
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
		| "isCompacting"
		| "compactionReason"
		| "messages"
		| "steeringMode"
		| "followUpMode"
		| "sessionFile"
		| "sessionId"
		| "sessionName"
		| "scopedModels"
		| "promptTemplates"
		| "pendingMessageCount"
		| "resourceLoader"
		| "autoCompactionEnabled"
		| "isRetrying"
		| "autoRetryEnabled"
		| "abortSessionSummary"
		| "isBashRunning"
		| "hasPendingBashMessages"
		| "extensionRunner"
		| "queuedMessagesPaused"
		| "pauseQueuedMessages"
		| "resumeQueuedMessages"
		| "subscribe"
		| "dispose"
		| "getActiveToolNames"
		| "getAllTools"
		| "getToolDefinition"
		| "setActiveToolsByName"
		| "setScopedModels"
		| "prompt"
		| "steer"
		| "followUp"
		| "sendCustomMessage"
		| "sendUserMessage"
		| "clearQueue"
		| "getSteeringMessages"
		| "getFollowUpMessages"
		| "abort"
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
	_terminatingToolCallIds: Set<string>;
	_stopAfterTurnBlockedContinuation: boolean;
	_pendingInterruptDeliveries: number;
	_priorityInterruptPending: boolean;
	_activePromptCount: number;
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
	_autoCompactionCompletion: Promise<void> | undefined;
	_compactionReason: import("./agent-session-types.js").CompactionReason | undefined;
	_overflowRecoveryAttempted: boolean;
	_recoverableLengthRecoveryAttempted: boolean;
	_contextOverflowUnresolved: boolean;
	_branchSummaryAbortController: AbortController | undefined;
	_branchSummaryCompletion: Promise<void> | undefined;
	_retryAbortController: AbortController | undefined;
	_retryAttempt: number;
	_retryPromise: Promise<void> | undefined;
	_retryResolve: (() => void) | undefined;
	_bashAbortControllers: Map<string | symbol, Set<AbortController>>;
	_pendingBashMessages: BashExecutionMessage[];
	_extensionRunner: ExtensionRunner;
	_turnIndex: number;
	readonly _entryIdsByMessage: WeakMap<object, string>;
	readonly _boundaryDispatchedMessages: WeakSet<object>;
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
	_allowedToolNames?: Set<string>;
	_excludedToolNames?: Set<string>;
	_childSessionOptions?: import("./child-session-options.ts").ChildSessionOptionsResolver;
	_baseToolsOverride?: Record<string, AgentTool>;
	_sessionStartEvent: SessionStartEvent;
	_orchestrationContext?: OrchestrationContext;
	_subagentPolicy?: import("./extensions/index.js").SubagentChildPolicy;
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
	_toolDefinitions: Map<string, ToolDefinitionEntry>;
	_toolPromptSnippets: Map<string, string>;
	_toolPromptGuidelines: Map<string, string[]>;
	_baseSystemPromptOptions: NormalizedBuildSystemPromptOptions;
	_systemPromptTransform?: (prompt: string) => string;
	_contextProjectionTransform?: (messages: AgentMessage[]) => AgentMessage[];
	_runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;
	_lastAssistantMessage: AssistantMessage | undefined;
	_tempStorageLease: import("./tools/session-temp-dir.ts").ProtectedPathLease | undefined;
	_workflowStageAdmission: import("./workflow-stage-admission.ts").WorkflowStageAdmissionBoundary | undefined;
	_agentTaskHost: import("./tasks/agent-adapter.js").AgentTaskHost | undefined;
	_parentCommandTaskOwner: import("./tasks/child-command-owner.js").ChildCommandTaskOwner | undefined;
	_childTaskWaits: import("./tasks/child-command-owner.js").ChildTaskWaits;
	_taskCompletionOutbox: import("./tasks/completion.js").TaskCompletionOutbox | undefined;
	_taskAdmission: import("./workflow-stage-admission.ts").WorkflowStageAdmissionBoundary | undefined;
}
