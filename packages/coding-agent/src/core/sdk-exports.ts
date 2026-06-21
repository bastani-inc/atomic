export * from "./agent-session-runtime.ts";
export type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  SlashCommandInfo,
  SlashCommandSource,
  ToolDefinition,
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
  withFileMutationQueue,
  STRUCTURED_OUTPUT_TOOL_NAME,
  // Tool factories (for custom cwd)
  createCodingTools,
  createReadOnlyTools,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createStructuredOutputCapture,
  createStructuredOutputTool,
} from "./tools/index.ts";

