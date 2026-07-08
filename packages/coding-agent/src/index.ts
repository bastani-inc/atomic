// Core session management

export { type Args, parseArgs } from "./cli/args.ts";
// Config paths
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	CONFIG_DIR_NAMES,
	LEGACY_CONFIG_DIR_NAME,
	LEGACY_ENV_PREFIX,
	getAgentConfigPaths,
	getAgentDir,
	getAgentDirs,
	getBundledInteractiveAssetPath,
	getChangelogPath,
	getDocsPath,
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
	getEnvNames,
	getEnvValue,
	ENV_CODEX_FAST_MODE,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
	isBunBinary,
	getUserConfigDirs,
	getUserConfigPaths,
	hasEnvValue,
	PACKAGE_NAME,
	setEnvValue,
	VERSION,
} from "./config.ts";
export { type BashResult, executeBashWithOperations } from "./core/bash-executor.ts";
export {
  parseFlattenedKeyPath,
  reconstructFlattenedKeys,
  unflattenArgumentsWithSchema,
} from "./core/flattened-tool-arguments.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.ts";
// Auth and model registry
export {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthStatus,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type OAuthCredential,
} from "./core/auth-storage.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactableTranscript,
	type ContextCompactionPreparation,
	type ContextCompactionResult,
	type ContextDeletionRequest,
	type ValidatedContextDeletionResult,
	buildContextCompactionPrompt,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	contextCompact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	getLastAssistantUsage,
	prepareBranchEntries,
	prepareContextCompaction,
	serializeConversation,
	shouldCompact,
	validateContextDeletionRequest,
} from "./core/compaction/index.ts";
export {
	CODEX_FAST_MODE_SERVICE_TIER,
	formatCodexFastModeModelLabel,
	getCodexFastModeScope,
	hasSupportedCodexFastModeModel,
	isCodexFastModeEnabledForScope,
	isCodexFastModeCandidateModelId,
	isCodexFastModeSupportedModel,
	isCodexFastModeSupportedProvider,
	shouldApplyCodexFastMode,
	shouldApplyCodexFastModeForScope,
	type CodexFastModeResolvedSettings,
	type CodexFastModeScope,
} from "./core/codex-fast-mode.ts";
export {
	formatContextWindow,
	getEffectiveInputBudget,
	getModelDefaultContextWindow,
	getSupportedContextWindows,
	normalizeContextWindowOptions,
	parseContextWindowValue,
	selectContextWindow,
	validateContextWindowValue,
	withContextWindowOptions,
	type ContextWindowParseResult,
	type ContextWindowSelection,
	type ContextWindowSelectionError,
	type ContextWindowSelectionOptions,
} from "./core/context-window.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./core/experimental.ts";
export * from "./index-extensions.js";
// Builtin tool definitions reusable by first-party extensions (e.g. workflows
// invoking the structured ask_user_question UI deterministically).
export { createAskUserQuestionToolDefinition } from "./core/tools/index.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export { convertToLlm } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export type { DefaultProjectTrust } from "./core/settings-manager.ts";
export {
	hasProjectTrustInputs,
	hasTrustRequiringProjectResources,
	TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES,
	type ProjectTrustDecision,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
} from "./core/trust-manager.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { getBuiltinPackagePaths } from "./core/builtin-packages.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export type {
	DefaultResourceLoaderInheritanceSnapshot,
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
} from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
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
	createSearchTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createStructuredOutputCapture,
	STRUCTURED_OUTPUT_TOOL_NAME,
	createStructuredOutputTool,
	createWriteTool,
	type JsonObject,
	type JsonPrimitive,
	type JsonValue,
	type PromptTemplate,
	type StructuredOutputCapture,
	type StructuredOutputFileCapture,
	type StructuredOutputToolOptions,
} from "./core/sdk.ts";
export {
	type BranchSummaryEntry,
	buildSessionContext,
	type ContextCompactionEntry,
	type ContextCompactionStats,
	type ContextDeletionTarget,
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
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
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
// Tools
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createSearchToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
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
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
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
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// Main entry point
export { type MainOptions, main } from "./main.ts";
// Run modes for programmatic SDK usage
export { pickWhimsicalWorkingMessage } from "./modes/interactive/whimsical-messages.ts";
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcContextWindowInfo,
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
	chatEntriesFromAgentMessages,
	// Internal host seam for bundled workflow stage chat; not yet a stable extension API.
	ChatSessionHost,
	type ChatSessionHostBashRequest,
	type ChatSessionHostCommands,
	type ChatSessionHostEntry,
	type ChatSessionHostOpts,
	type ChatSessionHostStyle,
	ChatTranscriptComponent,
	LiveChatEntriesController,
	renderChatMessageEntry,
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	ScrollableChatTranscriptComponent,
	ScrollableComponentViewport,
	type ChatTranscriptEntryLike,
	type ChatTranscriptRenderer,
	type ChatTranscriptRole,
	BranchSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	UsageMeterComponent,
	keyHint,
	keyText,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderDiff,
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
	UserMessageComponent,
	UserMessageSelectorComponent,
	WorkingStatusComponent,
	type WorkingStatusComponentOptions,
	type VisualTruncateResult,
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
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { createGitEnvironment, GIT_LOCAL_ENV_VARS } from "./utils/git-env.ts";
export {
	isSafeFsWatchPathError,
	isUnsafeWindowsShortPath,
	resolveNativeWatchPath,
	SAFE_FS_WATCH_CANONICALIZATION_FAILED,
	SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
	watchWithErrorHandler,
	type SafeFsWatchErrorCode,
	type SafeFsWatchPathError,
} from "./utils/fs-watch.ts";
export { convertToPng } from "./utils/image-convert.ts";
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
// Shell utilities
export { getShellConfig } from "./utils/shell.ts";
