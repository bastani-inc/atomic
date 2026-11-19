export type { ExtensionBindings } from "./core/agent-session-types.js";
export {
	CacheWarmer,
	type CacheWarmingDecisionEvent,
	type CacheWarmingDecisionEventResult,
	type CacheWarmingStatus,
} from "./core/cache-warmer.ts";
export * from "./core/event-subscriptions/index.js";
export type { ExecuteToolOptions, ExtensionToolContext } from "./core/extensions/context-types.ts";
export {
	type HeldPrompt,
	type HeldPromptAnswer,
	type HeldPromptKind,
	type HeldPromptResult,
	type HeldPrompts,
	type HeldPromptValue,
	heldPrompts,
	isHeldPromptInput,
	isPresentationHostInput,
	routeNamesPrompt,
	watchHeldPromptAttention,
} from "./core/extensions/held-prompts.ts";
export type {
	HostDiagnostic,
	HostInput,
	HostInputOptions,
	QuestionAnswer,
	QuestionnaireError,
	QuestionnaireResult,
	QuestionParams,
} from "./core/extensions/host-input.js";
export {
	type ExtensionContextEffectPhase,
	publishExtensionContextEffect,
	registerExtensionContextRetirementEffect,
} from "./core/extensions/runner-context.ts";
export type {
	DetachableCallPredicate,
	ToolAnnotations,
	ToolExposure,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
	ToolRenderContext,
	ToolRendererResolver,
	ToolRenderers,
	ToolScriptAccess,
} from "./core/extensions/tool-types.ts";
export {
	type AsyncTakeoverMutex,
	type TakeoverMutex,
	takeTakeoverMutex,
	takeTakeoverMutexAsync,
} from "./core/lock-takeover.js";
export { resolveRestoredModelReference } from "./core/model-resolver-initial.ts";
export * from "./core/resume/index.ts";
export type { UsageEntry } from "./core/session-manager.ts";
export { resolveSessionStore } from "./core/session-storage.js";
export {
	assertSessionBlobStore,
	type BlobCopyOptions,
	copySessionBlobs,
	type MissingBlobReporter,
	sessionBlobHashes,
	TOOL_OUTPUT_ENTRY_TYPE,
	type ToolOutputReference,
	toolOutputUrl,
} from "./core/session-tool-output.ts";
export { CACHE_WARMING_MODES, type CacheWarmingMode } from "./core/settings-manager.ts";
export { type ParsedSlashCommand, parseSlashCommand } from "./core/slash-commands.js";
export * from "./core/storage/index.js";
// Outside the storage barrel: workflow durability setup imports that barrel in every test worker.
export {
	type ProcessStorageChoice,
	processSharedStorageSelection,
	processSharedStorageSelectionAsync,
	processStorageEnvironment,
	processStorageEnvironmentAsync,
	type StorageDomain,
	selectProcessStorage,
	selectProcessStorageAsync,
} from "./core/storage/process-selection.js";
export { JsonlSessionStore } from "./core/storage/session/jsonl-session-store.js";
// Internal trusted-host task integration (not model authority).
export { AgentTaskHost, type AgentTaskHostBinding, type AgentTaskRunnerFactory } from "./core/tasks/agent-adapter.js";
export {
	type AgentPanelActionResult,
	type AgentPanelAnswerOptions,
	type AgentPanelItem,
	type AgentPanelOpenOptions,
	type AgentPanelSession,
	type AgentPanelSource,
	type AgentPanelSourceRegistration,
	type AgentPanelState,
	agentPanelItems,
	agentPanelTaskId,
	answerAgentPanelItem,
	dismissedAgentPanelItems,
	openAgentPanelItem,
	stopAgentPanelItem,
	subscribeAgentPanel,
} from "./core/tasks/agent-panel-source.ts";
export {
	isRetryableTaskError,
	isTaskCleanupAdmissionTimeoutError,
	isTaskCleanupError,
	rehydrateTaskCleanupError,
	TaskCleanupAdmissionTimeoutError,
	type TaskCleanupAdmissionTiming,
	TaskCleanupError,
	type TaskCleanupErrorCode,
	type TaskCleanupFailure,
	type TaskCleanupPhase,
} from "./core/tasks/cleanup-error.js";
export {
	finishedSubagentResumeText,
	ranOnModelLine,
	resumableSubagentResult,
	subagentResumeId,
} from "./core/tasks/completion.js";
export type {
	AgentIntent,
	Cleanup,
	OperationId,
	ResourceFailure,
	TaskElapsedSpan,
	TaskId,
	TaskRecord,
	TaskResult,
	WaitPolicy,
} from "./core/tasks/contracts.js";
export { spanElapsedMs } from "./core/tasks/contracts.js";
export {
	FINISHED_TASK_RETENTION,
	findTaskEvictedError,
	isTaskEvictedError,
	rehydrateTaskEvictedError,
	TaskEvictedError,
	type TaskEvictedErrorCode,
	type TaskEvictedErrorFields,
} from "./core/tasks/eviction-error.js";
export { type AdmittedAgentTask, collectAgentTasks } from "./core/tasks/execution-scope.js";
export {
	DEFAULT_TASK_HEARTBEAT_MS,
	MIN_TASK_HEARTBEAT_MS,
	TASK_HEARTBEAT_MESSAGE_TYPE,
	type TaskHeartbeatDetails,
	validateTaskHeartbeatMs,
} from "./core/tasks/heartbeat-notice.js";
export {
	findTaskMessageError,
	isRetryableTaskMessageError,
	isTaskMessageError,
	isTaskMessageTimeoutError,
	rehydrateTaskMessageError,
	type SerializedTaskMessageError,
	TaskMessageError,
	type TaskMessageErrorCode,
	type TaskMessageErrorFields,
	TaskMessageTimeoutError,
	type TaskMessageTimeoutErrorFields,
	type TaskMessageTimeoutPhase,
} from "./core/tasks/message-error.js";
export {
	bindOwnerTaskStore,
	getOwnerTaskSession,
	getOwnerTaskStore,
	isTaskTurnInterrupted,
	OwnerTaskStore,
	type TaskActivity,
	taskResumedTurns,
	watchOwnerTaskStoreBinding,
} from "./core/tasks/owner-store.js";
export { belongsToSession, scopedBackgroundTasks, sessionTasks, taskSessionKey } from "./core/tasks/session-scope.js";
export { automaticWaitBudgetMs } from "./core/tasks/supervisor.js";
export { bindTaskResumer, type TaskResumer } from "./core/tasks/task-resumer.ts";
export {
	bindTaskTranscriptFragments,
	ownerTaskViewSource,
	type TaskCommandCatalog,
	type TaskDetailText,
	type TaskOutputView,
	type TaskTranscriptFollow,
	type TaskTranscriptFragments,
	type TaskTranscriptView,
	type TaskViewResult,
	type TaskViewSource,
	taskTranscriptFragments,
	withTaskTranscriptArchive,
} from "./core/tasks/task-view-source.js";
export { formatReadLineRange, formatToolCallWithArgs } from "./core/tools/render-utils.ts";
export {
	createTranscript,
	type Transcript,
	type TranscriptOptions,
	type TranscriptPart,
	type TranscriptTextPart,
	type TranscriptThinkingPart,
	type TranscriptToolCallPart,
	type TranscriptToolResult,
	type TranscriptToolResultFormat,
} from "./core/transcript.js";
export * from "./core/worktree-snapshot/index.ts";
export { type CodemodeExtensionOptions, createCodemodeExtension } from "./extensions/codemode/index.js";
export {
	type CodemodeToolDetails,
	type CodemodeToolOptions,
	createCodemodeDescription,
	createCodemodeTool,
	createCodemodeToolDefinition,
} from "./extensions/codemode/tool.js";
export { createToolSearchExtension } from "./extensions/tool-search/index.js";
export { createToolSearchToolDefinition, type ToolSearchToolOptions } from "./extensions/tool-search/tool.js";
export {
	HeartbeatBlock,
	type HeartbeatBlockSpec,
	type HeartbeatRow,
} from "./modes/interactive/components/heartbeat-block.ts";
export {
	clickableHintText,
	clickableKeyTextHint,
	hintKeyParts,
	isNavHelpKey,
	NAV_CONFIRM_WINDOW_MS,
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navEntryKeyParts,
	navEntryKeys,
	renderAutocompleteHintLine,
	renderNavHintLine,
	renderNavKeyOverlay,
	slashCommandHint,
	TwoPressConfirm,
} from "./modes/interactive/components/nav-keys.ts";
export {
	NoticeLine,
	type NoticeLineSpec,
	type NoticeStatus,
	noticeLineText,
} from "./modes/interactive/components/notice-line.ts";
export { renderTaskFooter, TaskList, taskListSections } from "./modes/interactive/components/task-list.js";
export { TaskRow } from "./modes/interactive/components/task-row.js";
export {
	collapseToolBlockLines,
	isToolBlock,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockGroup,
	ToolBlockMarkdown,
	ToolBlockRecords,
	type ToolBlockSpec,
	type ToolBlockStatus,
} from "./modes/interactive/components/tool-block.ts";
export {
	type BuiltinToolBlockContentPart,
	type BuiltinToolBlockInput,
	type BuiltinToolBlockPresentation,
	type BuiltinToolBlockResult,
	builtinToolBlockPresentation,
} from "./modes/interactive/components/tool-block-families.ts";
export { formatToolActionSummary } from "./modes/interactive/components/tool-block-summary.ts";
// Internal host seam for bundled workflow stage chats' click-expandable blocks; not yet a stable extension API.
export {
	type ClickExpandableBlock,
	type RowRange,
	repaintAfterSingleClick,
	rowsFrom,
} from "./modes/interactive/components/transcript-block-clicks.ts";
export {
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
} from "./modes/interactive/streaming-assistant-message.ts";

// Core session management

// GitHub Copilot request failures, typed at the provider; see docs/providers.md.
export {
	classifyGitHubCopilotFailure,
	describeGitHubCopilotModel,
	deserializeGitHubCopilotError,
	findGitHubCopilotError,
	GITHUB_COPILOT_ERROR_DIAGNOSTIC,
	GitHubCopilotAuthenticationError,
	GitHubCopilotContentFilterError,
	GitHubCopilotEmptyResponseError,
	GitHubCopilotError,
	type GitHubCopilotErrorCode,
	type GitHubCopilotErrorContext,
	type GitHubCopilotErrorFields,
	type GitHubCopilotErrorName,
	type GitHubCopilotFailureContext,
	GitHubCopilotInvalidRequestError,
	type GitHubCopilotInvalidRequestReason,
	type GitHubCopilotModelCapabilities,
	GitHubCopilotModelUnavailableError,
	type GitHubCopilotModelUnavailableReason,
	GitHubCopilotPromptTooLargeError,
	GitHubCopilotQuotaExhaustedError,
	GitHubCopilotRateLimitError,
	GitHubCopilotServiceUnavailableError,
	GitHubCopilotStreamEndedEarlyError,
	type GitHubCopilotStreamSnapshot,
	type GitHubCopilotUnrecognizedReason,
	GitHubCopilotUnrecognizedResponseError,
	getGitHubCopilotError,
	isGitHubCopilotAuthenticationError,
	isGitHubCopilotContentFilterError,
	isGitHubCopilotEmptyResponseError,
	isGitHubCopilotError,
	isGitHubCopilotInvalidRequestError,
	isGitHubCopilotModelUnavailableError,
	isGitHubCopilotPromptTooLargeError,
	isGitHubCopilotQuotaExhaustedError,
	isGitHubCopilotRateLimitError,
	isGitHubCopilotServiceUnavailableError,
	isGitHubCopilotStreamEndedEarlyError,
	isGitHubCopilotUnrecognizedResponseError,
	isRetryableGitHubCopilotError,
	type SerializedGitHubCopilotError,
	serializeGitHubCopilotError,
} from "@bastani/atomic-ai";
export { clampThinkingLevel, getSupportedThinkingLevels } from "@bastani/atomic-ai/compat";
export { type Args, parseArgs } from "./cli/args.ts";
// Config paths
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	CONFIG_DIR_NAMES,
	getAgentConfigPaths,
	getAgentDir,
	getAgentDirs,
	getBundledInteractiveAssetPath,
	getChangelogPath,
	getDocsPath,
	getEnvNames,
	getEnvValue,
	getExamplesPath,
	getExportTemplateDir,
	getInteractiveAssetsDir,
	getLegacyAgentDir,
	getPackageDir,
	getPackageJsonPath,
	getProjectConfigDirs,
	getProjectConfigPaths,
	getReadmePath,
	getThemesDir,
	getUserConfigDirs,
	getUserConfigPaths,
	hasEnvValue,
	isBunBinary,
	LEGACY_CONFIG_DIR_NAME,
	LEGACY_ENV_PREFIX,
	PACKAGE_NAME,
	setEnvValue,
	VERSION,
} from "./config.js";
export {
	AgentRehydrateError,
	type AgentRehydrateErrorCode,
	type AgentRehydrateErrorFields,
	AgentReleaseConfigError,
	type AgentReleaseConfigSource,
	type AgentSessionActivity,
	isAgentRehydrateError,
	isAgentReleaseConfigError,
	isLocalOnlySessionStorage,
	isRetryableAgentRehydrateError,
	rehydrateAgentRehydrateError,
	type SerializedAgentErrorCause,
	type SerializedAgentRehydrateError,
	serializeAgentRehydrateError,
	TEAM_JOIN_COMMAND,
} from "./core/agent-rehydrate-errors.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type CompactionReason,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionAbortOptions,
	type SessionCompactOptions,
	type SessionRecoveryReport,
	type SessionStats,
} from "./core/agent-session.js";
export { AgentSessionBusyError, isAgentSessionBusyError } from "./core/agent-session-busy-error.ts";
export type {
	DetachedCallFailure,
	DetachedCallFailureCause,
	DetachedToolCall,
	DetachedToolResult,
	ToolDetachmentPolicy,
} from "./core/agent-session-detached-tools.ts";
export { markToolCallReadyForDetachment, toolCallNeedsDetachmentHandoff } from "./core/agent-session-detached-tools.ts";
export type { ReleasedAgentSession, ReleaseWhenIdleOptions } from "./core/agent-session-release.ts";
export {
	type AgentWake,
	type AgentWakeClock,
	AgentWakeDispatcher,
	type AgentWakeDispatcherOptions,
	type AgentWakeDispatcherStats,
	type AgentWakeFailureListener,
	type AgentWakeHandler,
	type AgentWakeHandlerOptions,
	type AgentWakeKind,
	type AgentWakeSlot,
	type AgentWakeTimer,
	agentWakeDispatcher,
	wakeKeyNamespace,
} from "./core/agent-wake-dispatcher.ts";
// Auth and model runtime
export { AuthStorage, readStoredCredential } from "./core/auth-storage.ts";
export {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./core/auth-storage-backends.ts";
export {
	type AutoModelSelection,
	type AutoModelSettings,
	type ResolveAutoModelOptions,
	resolveAutoModel,
} from "./core/auto-model.ts";
export { type BashResult, executeBashWithOperations } from "./core/bash-executor.ts";
export { getBuiltinPackagePaths } from "./core/builtin-packages.ts";
export {
	type CallbackActivityDescriptor,
	type CallbackActivityKind,
	runCallback,
	runSynchronousCallback,
} from "./core/callback-activity.ts";
// Cloudflare AI Gateway over the Workers AI binding (no API token; see docs/providers.md)
export {
	type AiGatewayBinding,
	type AiGatewayBindingGateway,
	type AiGatewayUniversalRequestLike,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createGatewayBindingFetch,
	type GatewayBindingFetchOptions,
} from "./core/cloudflare-gateway-binding.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	buildBoundaryText,
	buildCompactorMessages,
	COMPACTED_OUTPUT_MAX_TOKENS,
	COMPACTOR_COMPRESSION_RATIO,
	COMPACTOR_REQUEST_TIMEOUT_MS,
	type CollectEntriesResult,
	type CompactionBackend,
	type CompactionForm,
	type CompactionHistoryLocation,
	type CompactionModelSelection,
	CompactorFailure,
	type CompactorMessage,
	type CompactorRequest,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	getLastAssistantUsage,
	type LineRange,
	prepareBranchEntries,
	prepareCompactionBoundary,
	requestCompactorOutput,
	resolveCompactionModel,
	SESSION_HISTORY_TOOL_NAME,
	serializeConversation,
	serializeConversationForCompaction,
	shouldCompact,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
	type VerbatimCompactionResult,
} from "./core/compaction/index.ts";
export {
	appendDebugRecord,
	appendDebugRecordAsync,
	DEBUG_AREA_VARIABLES,
	type DebugArea,
	type DebugFields,
	type DebugValue,
	flushDebugLog,
	getDebugLogFailure,
	isDebugEnabled,
	reportDebug,
	reportDebugAsync,
} from "./core/debug.ts";
export {
	DebugConfigError,
	type DebugConfigErrorFields,
	DebugError,
	type DebugErrorCode,
	DebugLogUnwritableError,
	type DebugSettingSource,
	isDebugConfigError,
	isDebugError,
	isDebugLogUnwritableError,
	rehydrateDebugError,
	type SerializedDebugError,
	serializeDebugError,
} from "./core/debug-errors.ts";
export { onDebugSettingChange, setDebugSetting } from "./core/debug-setting.ts";
export * from "./core/decision/index.js";
export type {
	ErrorFieldValue,
	SerializedErrorCause,
	SerializedTypedError,
} from "./core/error-contract.ts";
export { redactUrlCredentials } from "./core/error-contract.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.js";
export { areExperimentalFeaturesEnabled } from "./core/experimental.ts";
export { sessionScopedExtensionState } from "./core/extension-session-state.ts";
export {
	ExtensionStartupError,
	type ExtensionStartupFailure,
	isExtensionStartupFailure,
	isTransientExtensionStartupFailure,
} from "./core/extension-startup-failure.ts";
// Run modes for programmatic SDK usage
export { noOpUIContext } from "./core/extensions/runner-ui.ts";
export { resolveFallbackModel } from "./core/fallback-models.ts";
export {
	getModelFastRoute,
	resolveUpstreamModelId,
	usesChatGptCodexTransport,
	usesFirstPartyCodexRouting,
	withCodexFastRouteHeaders,
	withFastRouteStreamOptions,
} from "./core/fast-model-routing.ts";
export {
	CODEX_FAST_ROUTE_HEADER,
	CODEX_FAST_ROUTE_ORIGINATOR,
} from "./core/fast-model-routing-transport.ts";
export {
	ANTHROPIC_FAST_MODE_MODEL_IDS,
	copilotAdvertisedFastModelIds,
	deriveFastModelVariants,
	FAST_MODEL_ID_SUFFIX,
	FAST_MODEL_SERVICE_TIER,
	FAST_MODEL_SPEED,
	type FastModelVariantDerivation,
	type FastModelVariantDiagnostic,
	type FastModelVariantsOptions,
	fastModelId,
	isNativeFastRouteApi,
	usesAnthropicFastMode,
	usesOpenAIFastServiceTier,
	usesXaiFastServiceTier,
	withFastModelVariants,
} from "./core/fast-model-variants.ts";
export {
	parseFlattenedKeyPath,
	reconstructFlattenedKeys,
	unflattenArgumentsWithSchema,
} from "./core/flattened-tool-arguments.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export {
	IntercomBrokerError,
	type IntercomBrokerErrorCode,
	type IntercomBrokerErrorFields,
	type IntercomBrokerErrorFieldValue,
	type IntercomBrokerErrorOptions,
	type IntercomBrokerProtocolCode,
	IntercomBrokerProtocolError,
	type IntercomBrokerProtocolFields,
	type IntercomBrokerStopTimeoutCode,
	IntercomBrokerStopTimeoutError,
	type IntercomBrokerStopTimeoutFields,
	type IntercomBrokerStopTimeoutPhase,
	type IntercomBrokerSuccessorTimeoutCode,
	IntercomBrokerSuccessorTimeoutError,
	type IntercomBrokerSuccessorTimeoutFields,
	type IntercomBrokerSuccessorTimeoutPhase,
	type IntercomBrokerUpgradeCode,
	IntercomBrokerUpgradeError,
	type IntercomBrokerUpgradeFields,
	type IntercomBrokerUpgradePhase,
	isIntercomBrokerError,
	isIntercomBrokerProtocolError,
	isIntercomBrokerStopTimeoutError,
	isIntercomBrokerSuccessorTimeoutError,
	isIntercomBrokerUpgradeError,
	isRetryableIntercomBrokerError,
	rehydrateIntercomBrokerError,
	type SerializedIntercomBrokerError,
	serializeIntercomBrokerError,
} from "./core/intercom-broker-error.ts";
export {
	confinedIntercomChildGroup,
	IntercomPolicyError,
	type IntercomPolicyView,
	type IntercomReachApplier,
	type IntercomSessionOptions,
	MAX_INTERCOM_REACHABLE_GROUPS,
	type SessionIntercom,
} from "./core/intercom-policy.ts";
export {
	isProjectGroupError,
	ProjectGroupError,
	type ProjectGroupErrorCode,
} from "./core/intercom-project-group-error.ts";
export {
	IntercomRoutingChangedError,
	IntercomRoutingError,
	type IntercomRoutingErrorCode,
	IntercomRoutingMismatchError,
	type IntercomRoutingMismatchReason,
	type IntercomRoutingPhase,
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
	type IntercomRoutingUnavailableReason,
	isIntercomRoutingChangedError,
	isIntercomRoutingError,
	isIntercomRoutingMismatchError,
	isIntercomRoutingTimeoutError,
	isIntercomRoutingUnavailableError,
	isRetryableIntercomRoutingError,
} from "./core/intercom-routing-error.ts";
export {
	RUNTIME_INTERCOM_GROUP_ENV,
	readRuntimeIntercomGroup,
	runtimeIntercomGroupEnvKey,
} from "./core/intercom-runtime-group.ts";
export { keybindingIdentity } from "./core/keybinding-identity.js";
export { matchesMcpDirectToolSelection } from "./core/mcp-child-policy.ts";
export {
	type McpExposure,
	type McpOAuthConfig,
	type McpServerConfig,
	type McpServerContribution,
	mcpNamespace,
	validateMcpServerConfig,
} from "./core/mcp-servers.ts";
export { convertToLlm } from "./core/messages.ts";
export { modelCallUsage } from "./core/model-call-usage.ts";
export {
	type CredentialPartition,
	formatNoUsableModelMessage,
	NoUsableModelError,
	partitionByCredentials,
	providerOfModelReference,
	type SkippedCandidate,
	type SkippedModel,
	type SkippedModelReason,
} from "./core/model-credential-filter.ts";
export type {
	ModelFallbackFailureKind,
	ModelFallbackFailureOptions,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "./core/model-fallback-failures.ts";
export {
	errorMessage,
	isProviderCredentialRejection,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isUnrecognizedModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "./core/model-fallback-failures.ts";
export {
	formatModelLabel,
	formatModelReferenceLabel,
	MODEL_LABEL_SEPARATOR,
	type ModelLabelOptions,
	type ModelLabelSubject,
} from "./core/model-label.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	type CredentialSynchronizationOperation,
	ModelRuntime,
	type ModelRuntimeAuthOverrides,
} from "./core/model-runtime.js";
export type {
	PackageInstallFailure,
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedMcpServer,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
// Shell utilities
export {
	containProcessTree,
	type ProcessTreeContainment,
	processTreeEnded,
} from "./core/process-tree-containment.ts";
export { formatProjectTrustPrompt } from "./core/project-trust.ts";
export {
	applyProviderRateLimitObservation,
	configureProviderRequestBudget,
	isProviderRateLimit,
	modelIdForModel,
	observeProviderRateLimits,
	type ProviderRateLimitObservation,
	type ProviderRateLimitSnapshot,
	type ProviderRequestBudget,
	type ProviderRequestGate,
	providerCooldownMs,
	providerIdForModel,
	providerRateLimitObservations,
	providerRateLimitSnapshot,
	providerRetryHint,
	providerUnavailableMs,
	recordProviderRateLimit,
	setProviderRequestGate,
} from "./core/provider-rate-limits.js";
export type {
	DefaultResourceLoaderInheritanceSnapshot,
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
	SkillCandidate,
	SkillCatalog,
	SkillCatalogCommand,
	SkillResolution,
} from "./core/resource-loader.ts";
export {
	buildSkillCatalog,
	buildSkillCatalogAsync,
	DefaultResourceLoader,
	emptySkillCatalog,
	getSkillCatalog,
	loadProjectContextFiles,
} from "./core/resource-loader.ts";
export {
	isLongStreamCut,
	LONG_STREAM_CUT_MS,
	MAX_LONG_STREAM_CUT_RETRIES,
	nextRetryDecision,
	type RetryDecision,
	type RetryPolicySettings,
} from "./core/retry-policy.ts";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type AtomicBuiltin,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	// Factory
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createSearchTool,
	createStructuredOutputCapture,
	createStructuredOutputTool,
	createWriteTool,
	type JsonObject,
	type JsonPrimitive,
	type JsonValue,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type PromptTemplate,
	type ResourceAdmission,
	type ResourceAdmissionRequest,
	type ResourcePermit,
	type ResourceProcessIdentity,
	type SessionStorageOption,
	STRUCTURED_OUTPUT_TOOL_NAME,
	type StructuredOutputCapture,
	type StructuredOutputFileCapture,
	type StructuredOutputToolOptions,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	withResourceAdmission,
} from "./core/sdk.ts";
export {
	isMissingSessionCwdError,
	isSerializedMissingSessionCwdError,
	MissingSessionCwdError,
	type MissingSessionCwdErrorCode,
	type MissingSessionCwdFields,
	rehydrateMissingSessionCwdError,
	type SerializedMissingSessionCwdError,
	type SessionCwdIssue,
	serializeMissingSessionCwdError,
} from "./core/session-cwd.ts";
export {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	type CompactionEntry,
	type ContextEditableContent,
	type ContextEditEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getDefaultSessionDirPath,
	getLatestCompactionBoundaryEntry,
	getSessionLeafId,
	type ModelChangeEntry,
	type ModelFallbackRecord,
	type NewSessionOptions,
	type ProjectedSessionEntry,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	SessionEntryError,
	type SessionHeader,
	SessionHistoryNotLoadedError,
	SessionIdError,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type SessionNameState,
	type SessionOpenOptions,
	type SessionProjection,
	type SessionSummaryEntry,
	type SessionTreeNode,
	type SessionWorkflowMetadata,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
	type WorktreeRestoreHostWarning,
	type WorktreeSnapshotEntry,
} from "./core/session-manager.ts";
export {
	type PublishedChatActivity,
	retryStatusUpdate,
	type SessionRetryStatus,
	sessionWaitsToRetry,
} from "./core/session-retry-status.js";
export {
	findSessionStartError,
	isRetryableSessionStartError,
	isSessionStartConfigError,
	isSessionStartError,
	isSessionStartTimeoutError,
	MAX_SESSION_START_TIMEOUT_MS,
	parseSessionStartTimeoutMs,
	rehydrateSessionStartError,
	type SerializedSessionStartCause,
	type SerializedSessionStartError,
	SessionStartConfigError,
	type SessionStartConfigReason,
	type SessionStartConfigSource,
	SessionStartError,
	type SessionStartErrorCode,
	type SessionStartEventLoopSample,
	type SessionStartFailureCause,
	type SessionStartFields,
	type SessionStartFieldValue,
	type SessionStartPhase,
	type SessionStartStep,
	type SessionStartStepTiming,
	type SessionStartTimeoutDetails,
	SessionStartTimeoutError,
	serializeSessionStartError,
	sessionStartStepText,
} from "./core/session-start-errors.ts";
export {
	DEGRADED_RESTORE_RETENTION_DAYS,
	type DegradedRestorePin,
	type DiscardDegradedRestoreOptions,
	degradedRestorePin,
	discardDegradedRestore,
	formatDegradedRestoreNotice,
	formatUnrestoredNotice,
	formatWorktreeRestoreNotice,
	formatWorktreeRestoreWarning,
	isRecoverableRestoreFailure,
	type MissingSnapshotRecord,
	mapRestoredPath,
	mapRestoredPathAsync,
	openSessionInWorktree,
	type ResumeSessionWorktreeOptions,
	resumeSessionWorktree,
	type SessionWorktreeResume,
	type UnrestoredWorktree,
	type WorktreeRestoreOwner,
} from "./core/session-worktree-snapshots.ts";
export type { DefaultProjectTrust, QuietStartup } from "./core/settings-manager.ts";
export {
	type CompactionSettings,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
	type Settings,
	SettingsManager,
	type SettingsManagerCreateOptions,
} from "./core/settings-manager.ts";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export {
	type ConfiguredSecretRedactorOptions,
	configuredSecretRedactor,
} from "./core/storage/sqlite-facade.js";
export {
	generateStructuredOutput,
	type StructuredOutputRequest,
	type StructuredOutputResult,
} from "./core/structured-output/index.js";
export type { NormalizedBuildSystemPromptOptions } from "./core/system-prompt.ts";
export {
	deserializeToolDetachmentError,
	findToolDetachmentError,
	isToolDetachmentError,
	MAX_TOOL_DETACHMENT_AFTER_MS,
	type SerializedToolDetachmentError,
	type SerializedToolDetachmentErrorCause,
	ToolDetachmentError,
	type ToolDetachmentErrorCode,
	type ToolDetachmentErrorFields,
} from "./core/tool-detachment-errors.ts";
export {
	formatToolStatus,
	type ToolSelectionSource,
	type ToolSelectionStatus,
	type ToolStatus,
	type ToolStatusFormatStyle,
	type ToolStatusReport,
	type UnavailableToolStatus,
} from "./core/tool-status.js";
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// Builtin tool definitions reusable by first-party extensions (e.g. workflows
// invoking the structured ask_user_question UI deterministically).
// Tools
export {
	BASH_SHELL_PRESENTATION,
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashToolSystemPromptContribution,
	createAskUserQuestionToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createKillTool,
	createKillToolDefinition,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createSearchToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	EditInputError,
	type EditInputErrorCode,
	EditMatchError,
	type EditMatchErrorCode,
	type EditOperations,
	EditTargetError,
	type EditTargetErrorCode,
	type EditToolDetails,
	EditToolError,
	type EditToolErrorCode,
	type EditToolErrorFields,
	type EditToolInput,
	type EditToolOptions,
	editToolSystemPromptContribution,
	FileToolAbortedError,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findToolSystemPromptContribution,
	formatSize,
	isEditInputError,
	isEditMatchError,
	isEditTargetError,
	isEditToolError,
	isFileToolAbortedError,
	isWriteSelectorError,
	type KillToolOptions,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsToolSystemPromptContribution,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readToolSystemPromptContribution,
	rehydrateEditToolError,
	rehydrateWriteSelectorError,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
	type SerializedFileToolError,
	type ShellToolPresentation,
	searchToolSystemPromptContribution,
	serializeFileToolError,
	sliceHead,
	sliceTail,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	WriteSelectorError,
	type WriteSelectorErrorCode,
	type WriteSelectorErrorFields,
	type WriteToolInput,
	type WriteToolOptions,
	withFileMutationQueue,
	writeToolSystemPromptContribution,
} from "./core/tools/index.js";
/** Bounds extension text in the model's context the way oversized tool results are bounded. */
export { boundOversizedText } from "./core/tools/oversized-tool-result.js";
export {
	assertPrivateDirectory,
	assertPrivateDirectoryAsync,
	ensurePrivateTempDir,
	ensurePrivateTempDirAsync,
	TempDirRefusedError,
} from "./core/tools/session-temp-dir.ts";
export {
	isShellTimeoutError,
	isShellToolError,
	rehydrateShellToolError,
	type ShellExitBeforeTimeout,
	ShellTimeoutError,
	type ShellTimeoutPhase,
	ShellToolError,
	type ShellToolErrorCode,
} from "./core/tools/shell-errors.ts";
export {
	isTaskToolError,
	rehydrateTaskToolError,
	type SerializedTaskToolError,
	TaskToolError,
	type TaskToolErrorFields,
	type TaskToolFailureCode,
} from "./core/tools/shell-task-status.ts";
export {
	getProjectTrustOptions,
	getProjectTrustOptionsAsync,
	hasProjectTrustInputs,
	hasProjectTrustInputsAsync,
	hasTrustRequiringProjectResources,
	hasTrustRequiringProjectResourcesAsync,
	type ProjectTrustDecision,
	type ProjectTrustOption,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
	TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES,
} from "./core/trust-manager.ts";
export { StringEnum, type StringEnumOptions } from "./core/typebox-compat.ts";
export { parkWorkflowStageForRelease } from "./core/workflow-stage-admission.ts";
// Workspace bindings (#3109)
export {
	type AcquireWorkspaceWriterLeaseOptions,
	acquireWorkspaceWriterLease,
	assertWorkspace,
	attachCleanupCause,
	type BoundWorkspace,
	bindSessionWorkspace,
	findWorkspaceError,
	inheritWorkspace,
	isBoundWorkspace,
	isRetryableWorkspaceError,
	isWorkspace,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	isWorkspaceError,
	isWorkspacePublicationError,
	isWorkspaceRestoreError,
	isWorkspaceSandboxError,
	isWorkspaceTimeoutError,
	type PublishedPullRequest,
	type PublishPullRequestOptions,
	publishPullRequest,
	type ResolveWorkspaceOptions,
	type RestoreWorkspaceOptions,
	rehydrateWorkspaceError,
	resolveWorkspace,
	restoreWorkspace,
	type SerializedWorkspaceError,
	serializeWorkspaceError,
	WORKSPACE_BINDING_ENTRY_TYPE,
	type Workspace,
	type WorkspaceBinding,
	WorkspaceBindingError,
	type WorkspaceBindingErrorCode,
	type WorkspaceBindingErrorReason,
	type WorkspaceChangeSet,
	type WorkspaceChangeSetOptions,
	WorkspaceConfigError,
	type WorkspaceConfigErrorCode,
	type WorkspaceConfigErrorReason,
	type WorkspaceConfigSource,
	type WorkspaceDiffStat,
	WorkspaceError,
	type WorkspaceErrorCode,
	type WorkspaceErrorFields,
	type WorkspaceErrorFieldValue,
	type WorkspaceGitPhase,
	type WorkspaceOptions,
	WorkspacePublicationError,
	type WorkspacePublicationErrorCode,
	type WorkspacePublicationErrorReason,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorCode,
	type WorkspaceRestoreErrorReason,
	type WorkspaceSandbox,
	WorkspaceSandboxError,
	type WorkspaceSandboxErrorCode,
	WorkspaceTimeoutError,
	type WorkspaceTimeoutErrorCode,
	type WorkspaceWriterLease,
	type WorkspaceWriterLeaseHolder,
	type WorktreeBinding,
	workspace,
	workspaceChangeSet,
	workspaceSessionCwd,
	workspaceSessionCwdAsync,
} from "./core/workspace/index.ts";
export {
	findLlamaServerError,
	isLlamaServerError,
	isLlamaServerRequestError,
	isLlamaServerUnreachableError,
	isRetryableLlamaServerError,
	LlamaServerError,
	type LlamaServerErrorCode,
	LlamaServerRequestError,
	LlamaServerUnreachableError,
	rehydrateLlamaServerError,
} from "./extensions/llama/errors.ts";
export {
	type LoadedMcpConfig,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
	updateMcpServerConfigAsync,
} from "./extensions/mcp/config.ts";
export { createMcpExtension, type McpExtensionOptions } from "./extensions/mcp/index.js";
export { McpOAuthCredentialStore } from "./extensions/mcp/oauth.ts";
export * from "./index-extensions.js";
// Main entry point
export { type MainOptions, main } from "./main.ts";
export {
	isStartupBenchmarkConfigError,
	isStartupBenchmarkError,
	rehydrateStartupBenchmarkError,
	StartupBenchmarkConfigError,
	StartupBenchmarkError,
	type StartupBenchmarkErrorCode,
	type StartupBenchmarkUnsupportedMode,
} from "./main-startup-benchmark.js";
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcEvent,
	type RpcEventListener,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	runPrintMode,
	runRpcMode,
} from "./modes/index.ts";
// UI components for extensions
export {
	AgentTokenMeter,
	type AgentTokenMeterSnapshot,
	ArminComponent,
	AssistantMessageComponent,
	agentTokenTotal,
	applyAttachedComposer,
	applyInputLabelToEditorTopRule,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	buildInputLabel,
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	// Internal host seam for bundled workflow stage chat; not yet a stable extension API.
	ChatSessionHost,
	type ChatSessionHostBashRequest,
	type ChatSessionHostCommands,
	type ChatSessionHostEntry,
	type ChatSessionHostOpts,
	type ChatSessionHostStyle,
	type ChatSessionInterruptedTurnSnapshot,
	type ChatSessionSubmitMode,
	type ChatSessionViewportSettings,
	ChatTranscriptComponent,
	type ChatTranscriptEntryLike,
	type ChatTranscriptRenderer,
	type ChatTranscriptRole,
	CustomEditor,
	type CustomEditorOptions,
	CustomEntryComponent,
	CustomMessageComponent,
	chatEntriesFromAgentMessages,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	formatTokenCount,
	formatTokenSegment,
	INPUT_LABEL_MIN_COLUMNS,
	type InputLabel,
	type InputLabelKind,
	type InputLabelStyle,
	inputLabelMarker,
	keyHint,
	keyHintIfBound,
	keyText,
	LiveChatEntriesController,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	PLAIN_SELECTOR_STYLE,
	type RenderDiffOptions,
	rawKeyHint,
	renderChatMessageEntry,
	renderDiff,
	ruleOpenColor,
	ScrollableChatTranscriptComponent,
	ScrollableComponentViewport,
	type ScrollableComponentViewportOptions,
	Selector,
	type SelectorExtraKey,
	type SelectorItem,
	type SelectorOptions,
	SelectorState,
	type SelectorStyle,
	type SelectorTone,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	selectorHintEntries,
	TASK_CHAT_OVERLAY_KEYS,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	type TokenSegmentMode,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TRANSCRIPT_JUMP_TO_END_URL,
	TranscriptFollowIndicator,
	TreeSelectorComponent,
	taskChatKeys,
	themeSelectorStyle,
	truncateToVisualLines,
	UsageMeterComponent,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
	WorkingStatusComponent,
	type WorkingStatusComponentOptions,
} from "./modes/interactive/components/index.ts";
export {
	classifyChatCommand,
	createSessionSkillAutocompleteProvider,
	getSessionCommandCatalog,
	getSessionSkillCommands,
	type PendingSessionCommandCatalog,
	type SessionCommandCatalog,
} from "./modes/interactive/skill-command-autocomplete.ts";
// Theme utilities for custom tools and extensions
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	hexColorAnsi,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.js";
export { pickWhimsicalWorkingMessage } from "./modes/interactive/whimsical-messages.ts";
export { createChildProcessEnvironment, spawnProcess } from "./utils/child-process.ts";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.js";
export { redactCredentialShapes } from "./utils/credential-redaction.js";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export {
	isSafeFsWatchPathError,
	isUnsafeWindowsShortPath,
	resolveNativeWatchPath,
	SAFE_FS_WATCH_CANONICALIZATION_FAILED,
	SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
	type SafeFsWatchErrorCode,
	type SafeFsWatchPathError,
	watchWithErrorHandler,
} from "./utils/fs-watch.ts";
export { createGitEnvironment, GIT_LOCAL_ENV_VARS } from "./utils/git-env.ts";
export {
	findGitProvisionError,
	GIT_MINIMUM_VERSION,
	type GitInstallPhase,
	type GitProvisionConfigCode,
	GitProvisionConfigError,
	type GitProvisionConfigFields,
	GitProvisionError,
	type GitProvisionErrorCode,
	type GitProvisionFields,
	type GitProvisionJsonValue,
	type GitProvisionPhase,
	type GitProvisionTimeoutCode,
	GitProvisionTimeoutError,
	type GitProvisionTimeoutFields,
	type GitRejectedSystemGit,
	type GitUnavailableCode,
	GitUnavailableError,
	type GitUnavailableFields,
	type GitUnsupportedPlatformReason,
	isGitProvisionConfigError,
	isGitProvisionError,
	isGitProvisionTimeoutError,
	isGitUnavailableError,
	isRetryableGitProvisionError,
	rehydrateGitProvisionError,
	type SerializedGitProvisionError,
} from "./utils/git-errors.ts";
export { convertToPng } from "./utils/image-convert.ts";
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
export { INTERACTIVE_ENGINE_ENV_VARS, scrubInteractiveEngineEnv } from "./utils/interactive-engine-env.ts";
export {
	isManagedToolDownloadError,
	isManagedToolError,
	isManagedToolTimeoutError,
	isRetryableManagedToolError,
	type ManagedToolDownloadCode,
	ManagedToolDownloadError,
	type ManagedToolDownloadFields,
	ManagedToolError,
	type ManagedToolErrorCode,
	type ManagedToolErrorFields,
	type ManagedToolName,
	type ManagedToolRequestPhase,
	type ManagedToolTimeoutCode,
	ManagedToolTimeoutError,
	type ManagedToolTimeoutFields,
} from "./utils/managed-tool-errors.ts";
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";
export { isPathInside, type PathInsideApi } from "./utils/path-inside.ts";
export {
	getPowerShellConfig,
	getShellConfig,
	killChildProcessTree,
	killProcessTree,
	markDetachedChildExited,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "./utils/shell.ts";
// Terminal-safe display text
export { terminalDisplayText } from "./utils/terminal-text.ts";
export {
	type GitToolStatus,
	type GitUpdateStatus,
	getGitStatus,
	getGitStatusAsync,
	type ResolvedGit,
	type ResolvedGitSource,
	type ResolveGitOptions,
	resolveGit,
	resolveGitSync,
	resolveInstalledGit,
	type ToolStatus as ManagedToolStatus,
} from "./utils/tools-manager.ts";
