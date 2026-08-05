// Core session management

export { type Args, parseArgs } from "./cli/args.ts";
// Config paths
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	CONFIG_DIR_NAMES,
	ENV_CODEX_FAST_MODE,
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
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "./config.ts";
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
	type SessionStats,
} from "./core/agent-session.ts";
// Auth and model runtime
export { AuthStorage, readStoredCredential } from "./core/auth-storage.ts";
export {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./core/auth-storage-backends.ts";
export { type BashResult, executeBashWithOperations } from "./core/bash-executor.ts";
export { getBuiltinPackagePaths } from "./core/builtin-packages.ts";
export {
	type CallbackActivityDescriptor,
	type CallbackActivityKind,
	runCallback,
	runSynchronousCallback,
} from "./core/callback-activity.ts";
export {
	CODEX_FAST_MODE_SERVICE_TIER,
	type CodexFastModeResolvedSettings,
	type CodexFastModeScope,
	formatCodexFastModeModelLabel,
	getCodexFastModeScope,
	hasSupportedCodexFastModeModel,
	isCodexFastModeCandidateModelId,
	isCodexFastModeEnabledForScope,
	isCodexFastModeSupportedModel,
	isCodexFastModeSupportedProvider,
	shouldApplyCodexFastMode,
	shouldApplyCodexFastModeForScope,
} from "./core/codex-fast-mode.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactedTranscript,
	type CompactionPlannerModel,
	type CompactionPlanOptions,
	type CompactionRung,
	type CompactionRungResult,
	type CompactionRunRequest,
	type CompactionUrgency,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	getLastAssistantUsage,
	type LineRange,
	type PlannerAuth,
	type PlannerBudget,
	type PlannerLimitClass,
	type PlannerOutcome,
	prepareBranchEntries,
	prepareCompactionBoundary,
	runVerbatimCompaction,
	serializeConversation,
	serializeConversationForCompaction,
	shouldCompact,
	startNewContextWindow,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
	type VerbatimCompactionResult,
} from "./core/compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./core/experimental.ts";
export {
	parseFlattenedKeyPath,
	reconstructFlattenedKeys,
	unflattenArgumentsWithSchema,
} from "./core/flattened-tool-arguments.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export { convertToLlm } from "./core/messages.ts";
export type {
	ModelFallbackFailureKind,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "./core/model-fallback-failures.ts";
export {
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "./core/model-fallback-failures.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export { type CreateModelRuntimeOptions, ModelRuntime, type ModelRuntimeAuthOverrides } from "./core/model-runtime.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export type {
	DefaultResourceLoaderInheritanceSnapshot,
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
} from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
export { nextRetryDecision, type RetryDecision, type RetryPolicySettings } from "./core/retry-policy.ts";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
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
	STRUCTURED_OUTPUT_TOOL_NAME,
	type StructuredOutputCapture,
	type StructuredOutputFileCapture,
	type StructuredOutputToolOptions,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
} from "./core/sdk.ts";
export {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionBoundaryEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type SessionTreeNode,
	type SessionWorkflowMetadata,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
export {
	WORKFLOW_SESSION_METADATA_ENV,
	workflowSessionMetadataFromEnv,
} from "./core/session-manager-classification.ts";
export type { DefaultProjectTrust } from "./core/settings-manager.ts";
export {
	type CompactionSettings,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
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
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// Builtin tool definitions reusable by first-party extensions (e.g. workflows
// invoking the structured ask_user_question UI deterministically).
// Tools
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createAskUserQuestionToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createSearchToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	formatSize,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export {
	hasProjectTrustInputs,
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
	TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES,
} from "./core/trust-manager.ts";
export { StringEnum, type StringEnumOptions } from "./core/typebox-compat.ts";
export * from "./index-extensions.js";
// Main entry point
export { type MainOptions, main } from "./main.ts";
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
	ArminComponent,
	AssistantMessageComponent,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	// Internal host seam for bundled workflow stage chat; not yet a stable extension API.
	ChatSessionHost,
	type ChatSessionHostBashRequest,
	type ChatSessionHostCommands,
	type ChatSessionHostEntry,
	type ChatSessionHostOpts,
	type ChatSessionHostStyle,
	type ChatSessionSubmitMode,
	ChatTranscriptComponent,
	type ChatTranscriptEntryLike,
	type ChatTranscriptRenderer,
	type ChatTranscriptRole,
	CustomEditor,
	CustomEntryComponent,
	CustomMessageComponent,
	chatEntriesFromAgentMessages,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	keyHint,
	keyHintIfBound,
	keyText,
	LiveChatEntriesController,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderChatMessageEntry,
	renderDiff,
	ScrollableChatTranscriptComponent,
	ScrollableComponentViewport,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TreeSelectorComponent,
	truncateToVisualLines,
	UsageMeterComponent,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
	WorkingStatusComponent,
	type WorkingStatusComponentOptions,
} from "./modes/interactive/components/index.ts";
// Theme utilities for custom tools and extensions
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.ts";
// Run modes for programmatic SDK usage
export { pickWhimsicalWorkingMessage } from "./modes/interactive/whimsical-messages.ts";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.ts";
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
export { convertToPng } from "./utils/image-convert.ts";
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
export { INTERACTIVE_ENGINE_ENV_VARS, scrubInteractiveEngineEnv } from "./utils/interactive-engine-env.ts";
// Shell utilities
export { getShellConfig } from "./utils/shell.ts";
