export { getPowerShellConfig } from "../utils/shell.ts";
export * from "./agent-session-runtime.ts";
export type {
	AgentSettledEvent,
	BeforeProviderHeadersEvent,
	EntryRenderer,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	PowerShellToolCallEvent,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "./extensions/index.js";
export { isPowerShellToolResult } from "./extensions/index.js";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
	PowerShellOperations,
	PowerShellSpawnContext,
	PowerShellSpawnHook,
	PowerShellToolDetails,
	PowerShellToolInput,
	PowerShellToolOptions,
	ShellToolPresentation,
	StructuredOutputCapture,
	StructuredOutputFileCapture,
	StructuredOutputToolOptions,
	Tool,
} from "./tools/index.ts";
export {
	BASH_SHELL_PRESENTATION,
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createLocalPowerShellOperations,
	createLsTool,
	createPowerShellTool,
	createPowerShellToolDefinition,
	createReadOnlyTools,
	createReadTool,
	createSearchTool,
	createStructuredOutputCapture,
	createStructuredOutputTool,
	createWriteTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
	withFileMutationQueue,
} from "./tools/index.ts";
