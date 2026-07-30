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
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
	StructuredOutputCapture,
	StructuredOutputFileCapture,
	StructuredOutputToolOptions,
	Tool,
} from "./tools/index.ts";

export {
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
	STRUCTURED_OUTPUT_TOOL_NAME,
	withFileMutationQueue,
} from "./tools/index.ts";
