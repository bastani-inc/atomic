import type { Api, Model } from "@earendil-works/pi-ai";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";
import { unflattenArgumentsWithSchema } from "./flattened-tool-arguments.ts";

/**
 * Normalizes GitHub Copilot Gemini tool-call arguments.
 *
 * Why this exists
 * ---------------
 * `github-copilot` Gemini models are served through Copilot's CAPI gateway,
 * which proxies to Google's GenAI API. When a function/tool argument is an
 * array (or a nested object/array), Gemini serializes it on the wire as
 * **flattened, indexed keys** instead of a real JSON array/object. For example
 * a tool called with `{ keywords: ["a", "b"] }` arrives as:
 *
 * ```json
 * { "keywords[0]": "a", "keywords[1]": "b" }
 * ```
 *
 * This was confirmed by capturing the raw CAPI SSE stream: the
 * `tool_calls[].function.arguments` JSON itself contains the `name[index]`
 * keys, so the runtime parses valid-but-wrong JSON. Schema validation then
 * fails (`keywords: must have required properties keywords` and
 * `root: must not have additional properties`) and the model retries forever,
 * because it keeps re-emitting the same flattened shape. This is most visible
 * with the workflow `structured_output` tool but affects any Gemini tool call
 * whose schema contains an array or nested object.
 *
 * What it does
 * ------------
 * Reconstructs flattened keys (`name[i]`, `name[i].sub`, `parent.child`) back
 * into the intended nested arrays/objects, before tool-argument validation
 * runs. Bracket-indexed keys (`name[<digit>]`) are always reconstructed. A
 * purely dotted key (`parent.child`, with no array anywhere) is ambiguous —
 * a legitimate argument key can itself contain a dot — so it is only split when
 * the optional tool `schema` marks its head segment as an object/array
 * container property. When Gemini omits a required empty array entirely (there
 * are no `name[0]` keys to send), the schema is also used to synthesize `[]` for
 * missing required top-level array properties so normal validation can proceed.
 * The transform is gated to GitHub Copilot Gemini models, so it never touches
 * well-formed arguments from any other provider/model.
 */

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeIncludes(schema: JsonRecord, type: string): boolean {
  if (schema.type === type) return true;
  return Array.isArray(schema.type) && schema.type.includes(type);
}

function isArraySchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (schemaTypeIncludes(schema, "array")) return true;
  if ("items" in schema && !schemaTypeIncludes(schema, "object")) return true;
  const union = schema.anyOf ?? schema.oneOf;
  return Array.isArray(union) && union.some((branch) => isArraySchema(branch));
}

function requiredArrayPropertyNames(schema: unknown): readonly string[] {
  if (!isPlainObject(schema)) return [];
  const required = schema.required;
  const properties = schema.properties;
  if (!Array.isArray(required) || !isPlainObject(properties)) return [];
  return required.filter((name): name is string => (
    typeof name === "string" &&
    Object.hasOwn(properties, name) &&
    isArraySchema(properties[name])
  ));
}

function fillMissingRequiredArrayProperties(args: JsonRecord, schema: unknown): JsonRecord {
  const missing = requiredArrayPropertyNames(schema).filter((name) => !Object.hasOwn(args, name));
  if (missing.length === 0) return args;
  const next: JsonRecord = { ...args };
  for (const name of missing) next[name] = [];
  return next;
}

/**
 * Reconstruct flattened Gemini tool-call arguments into proper nested
 * arrays/objects. Returns the original reference unchanged when there is nothing
 * to reconstruct. Bracket-indexed keys are always reconstructed; purely dotted
 * keys are reconstructed only when the optional `schema` marks their head
 * segment as an object/array container property. Reconstruction (and its
 * prototype-pollution guard) is delegated to the shared canonical helper.
 */
export function unflattenGeminiToolArguments(args: unknown, schema?: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const reconstructed = unflattenArgumentsWithSchema(args, schema);
  return isPlainObject(reconstructed)
    ? fillMissingRequiredArrayProperties(reconstructed, schema)
    : reconstructed;
}

/**
 * If `model` is a GitHub Copilot Gemini model, normalize flattened tool-call
 * arguments; otherwise return them unchanged. Used to gate
 * {@link unflattenGeminiToolArguments} by model at tool-call time. The optional
 * `schema` is the tool's parameter schema, used to disambiguate dotted keys.
 */
export function normalizeToolArgumentsForModel(
  args: unknown,
  model: Pick<Model<Api>, "provider" | "api" | "id"> | undefined,
  schema?: unknown,
): unknown {
  if (!model || !isCopilotGeminiModel(model)) return args;
  return unflattenGeminiToolArguments(args, schema);
}

/** Map each tool name in an OpenAI chat-completions payload to its parameter schema. */
function toolParameterSchemas(tools: unknown): Map<string, unknown> {
  const schemas = new Map<string, unknown>();
  if (!Array.isArray(tools)) return schemas;
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    // OpenAI chat-completions tool shape: { type: "function", function: { name, parameters } }.
    const fn = tool.function;
    if (isPlainObject(fn) && typeof fn.name === "string") {
      schemas.set(fn.name, fn.parameters);
      continue;
    }
    // Defensive: flat tool shape { name, parameters }.
    if (typeof tool.name === "string") schemas.set(tool.name, tool.parameters);
  }
  return schemas;
}

/**
 * Reconstruct flattened GitHub Copilot Gemini tool-call arguments on the
 * **outbound replay payload**, so prior assistant tool calls are sent back to
 * CAPI in the nested array/object shape Gemini originally produced.
 *
 * Why this exists
 * ---------------
 * {@link normalizeToolArgumentsForModel} only unflattens at tool *execution*
 * time; the persisted assistant message keeps the raw flattened arguments CAPI
 * delivered (for example `{ "edits[0].newText": "..." }`). When that message is
 * replayed on the next turn, CAPI parses those literal keys straight into the
 * Gemini `FunctionCall.Args`, producing a function call that does not match the
 * tool's declared schema (nor the structure Gemini signed). Gemini then ends
 * the turn with `MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL` / `OTHER`,
 * which CAPI surfaces as a bare `finish_reason: "error"` — so multi-turn tool
 * use dies one turn after any array/object tool call (such as `edit`).
 *
 * This rewrites each replayed assistant `tool_calls[].function.arguments` JSON
 * into the reconstructed nested shape (reusing {@link unflattenGeminiToolArguments}
 * with the tool's own parameter schema, looked up from the payload's `tools`),
 * fixing both new and already-persisted sessions. Gated to GitHub Copilot Gemini
 * models, fail-open on non-JSON arguments, and a no-op for well-formed args.
 */
export function normalizeCopilotGeminiReplayToolArguments(
  payload: unknown,
  model: Pick<Model<Api>, "provider" | "api" | "id">,
): unknown {
  if (!isCopilotGeminiModel(model)) return payload;
  if (!isPlainObject(payload)) return payload;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;

  const schemas = toolParameterSchemas(payload.tools);
  let mutated = false;

  const nextMessages = messages.map((message) => {
    if (!isPlainObject(message) || message.role !== "assistant") return message;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message;

    let messageMutated = false;
    const nextToolCalls = toolCalls.map((toolCall) => {
      if (!isPlainObject(toolCall)) return toolCall;
      const fn = toolCall.function;
      if (!isPlainObject(fn) || typeof fn.arguments !== "string") return toolCall;

      let parsed: unknown;
      try {
        parsed = JSON.parse(fn.arguments);
      } catch {
        return toolCall; // fail open: never corrupt a replayed argument string
      }
      if (!isPlainObject(parsed)) return toolCall;

      const schema = typeof fn.name === "string" ? schemas.get(fn.name) : undefined;
      const reconstructed = unflattenGeminiToolArguments(parsed, schema);
      if (reconstructed === parsed) return toolCall;

      messageMutated = true;
      return { ...toolCall, function: { ...fn, arguments: JSON.stringify(reconstructed) } };
    });

    if (!messageMutated) return message;
    mutated = true;
    return { ...message, tool_calls: nextToolCalls };
  });

  if (!mutated) return payload;
  return { ...payload, messages: nextMessages };
}
