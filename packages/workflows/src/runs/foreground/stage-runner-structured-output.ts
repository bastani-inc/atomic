import {
  createStructuredOutputTool,
  type StructuredOutputCapture,
} from "@bastani/atomic";
import type { StageOptions } from "../../shared/types.js";
import type { Static, TSchema } from "typebox";

export const STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS = 3;
export const STRUCTURED_OUTPUT_MISSING_ERROR = "atomic-workflows: stage configured with schema must finish by calling structured_output.";

const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

type ToolResultContentBlock = {
  readonly type?: unknown;
  readonly text?: unknown;
};

function toolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block: ToolResultContentBlock) => block.type === "text" && typeof block.text === "string" ? block.text : "")
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function structuredOutputToolErrorFromEvent(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  if (record["type"] !== "tool_execution_end") return undefined;
  if (record["toolName"] !== STRUCTURED_OUTPUT_TOOL_NAME) return undefined;
  const result = record["result"];
  const resultRecord = result !== null && typeof result === "object" ? result as Record<string, unknown> : undefined;
  const isError = record["isError"] === true || resultRecord?.["isError"] === true;
  if (!isError) return undefined;
  return toolResultText(resultRecord?.["content"]) ?? "structured_output tool call failed schema validation.";
}

export function formatStructuredOutputCorrectionPrompt(error: string, attempt: number): string {
  return [
    "The previous response failed this stage's structured-output contract.",
    "",
    `Corrective attempt ${attempt}/${STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS}.`,
    "",
    "Error:",
    error,
    "",
    "You must finish by calling the `structured_output` tool exactly once with arguments matching the registered schema.",
    "Do not answer with plain JSON text, Markdown, or prose. If you attempted `structured_output` and validation failed, correct the tool arguments and call `structured_output` again.",
  ].join("\n");
}

export function stringifyStructuredOutputValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`atomic-workflows: structured_output returned a non-serializable value: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function stageOptionsWithStructuredOutput(
  options: StageOptions | undefined,
  capture: StructuredOutputCapture<unknown> | undefined,
): StageOptions | undefined {
  if (!options?.schema || !capture) return options;
  const tools = options.tools === undefined
    ? options.noTools === "all" ? [STRUCTURED_OUTPUT_TOOL_NAME] : undefined
    : Array.from(new Set([...options.tools, STRUCTURED_OUTPUT_TOOL_NAME]));
  const excludedTools = options.excludedTools?.filter((toolName) => toolName !== STRUCTURED_OUTPUT_TOOL_NAME);
  return {
    ...options,
    ...(tools !== undefined ? { tools } : {}),
    ...(excludedTools !== undefined ? { excludedTools } : {}),
    customTools: [
      ...(options.customTools ?? []),
      createStructuredOutputTool({
        schema: options.schema as TSchema,
        capture: capture as StructuredOutputCapture<Static<TSchema>>,
      }),
    ],
  };
}
