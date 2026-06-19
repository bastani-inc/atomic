import type { Api, Model } from "@earendil-works/pi-ai";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";
import { reconstructFlattenedKeys } from "./flattened-tool-arguments.ts";

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
 * container property. The transform is gated to GitHub Copilot Gemini models,
 * so it never touches well-formed arguments from any other provider/model.
 */

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A flattened key contains a bracket index like `foo[0]`. */
function hasFlattenedKey(keys: string[]): boolean {
  return keys.some((key) => /\[\d+\]/.test(key));
}

/** A schema node that holds a nested object/array (so dotted keys are real paths). */
function isContainerSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (schema.type === "object" || schema.type === "array") return true;
  if ("properties" in schema || "items" in schema) return true;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return union.some((branch) => isContainerSchema(branch));
  return false;
}

/** Top-level property names whose schema is an object/array container. */
function containerPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(schema)) return names;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return names;
  for (const [name, sub] of Object.entries(properties)) {
    if (isContainerSchema(sub)) names.add(name);
  }
  return names;
}

/** Whether `key` is a pure dotted path (`parent.child`) headed by a container prop. */
function isDottedContainerKey(key: string, containers: Set<string>): boolean {
  const dot = key.indexOf(".");
  if (dot <= 0) return false;
  return containers.has(key.slice(0, dot));
}

/**
 * Decide whether a flattened key should be split into nested path segments.
 * Bracket-indexed keys always split. When a bracket key is present anywhere in
 * the payload, dotted keys split too (they are part of the same flattened
 * object). Otherwise a dotted key only splits when the schema marks its head as
 * a container property, which keeps legitimate dot-containing keys intact.
 */
function shouldSplitKey(key: string, hasBracket: boolean, containers: Set<string>): boolean {
  if (/\[\d+\]/.test(key)) return true;
  if (hasBracket) return true;
  return isDottedContainerKey(key, containers);
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
  const keys = Object.keys(args);
  const hasBracket = hasFlattenedKey(keys);
  const containers = hasBracket ? new Set<string>() : containerPropertyNames(schema);
  const hasDottedContainer =
    !hasBracket && keys.some((key) => isDottedContainerKey(key, containers));
  if (!hasBracket && !hasDottedContainer) return args;

  return reconstructFlattenedKeys(args, (key) => shouldSplitKey(key, hasBracket, containers));
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
