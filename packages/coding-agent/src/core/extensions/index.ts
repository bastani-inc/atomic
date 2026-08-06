/**
 * Extension system for lifecycle events and custom tools.
 */

export type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai/compat";
export type { AtomicProviderCompat } from "../model-capabilities.ts";
export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
export type { SourceInfo } from "../source-info.ts";
export type { WorkflowResourceProvider, WorkflowResourceProviderInput } from "./loader.ts";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.ts";
export type {
	InstallReactiveWidgetOptions,
	ReactiveWidgetAction,
	ReactiveWidgetComponent,
	ReactiveWidgetController,
	ReactiveWidgetFactory,
	ReactiveWidgetRefreshReason,
	ReactiveWidgetRenderContext,
	ReactiveWidgetRenderState,
	ReactiveWidgetScheduler,
	ReactiveWidgetTimerApi,
	ReactiveWidgetTimerHandle,
	ReactiveWidgetUi,
} from "./reactive-widget.ts";
export {
	decideReactiveWidgetAction,
	installReactiveWidget,
} from "./reactive-widget.ts";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// App keybindings (for custom editors)
	AppKeybinding,
	AutocompleteProviderFactory,
	// Events - Tool (ToolCallEvent types)
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	// Context
	CompactOptions,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomMessageDelivery,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	EditToolCallEvent,
	EditToolResultEvent,
	// Message Rendering
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionMode,
	// Runtime
	ExtensionRuntime,
	ExtensionScopedModels,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	HostCustomUiState,
	HostCustomUiStateListener,
	HostInputFormField,
	HostInputFormFieldType,
	HostInputFormRequest,
	HostSessionPickerHandle,
	HostSessionPickerRequest,
	HostSessionPickerRow,
	InlineExtension,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	// Events - Message
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	OrchestrationContext,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	ScopedModel,
	SendMessageHandler,
	SendMessageOptions,
	SendMessagesHandler,
	SendMessagesOptions,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	SubagentChildPolicy,
	SubagentIntercomIdentity,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	// Tool execution mode
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkflowStageOrchestrationContext,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.ts";
// Type guards
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isLsToolResult,
	isReadToolResult,
	isSearchToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";
