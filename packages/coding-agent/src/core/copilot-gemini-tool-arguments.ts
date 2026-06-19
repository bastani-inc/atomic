import type { Api, Model } from "@earendil-works/pi-ai";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";

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
 * runs. It is a no-op unless at least one bracket-indexed key (`name[<digit>]`)
 * is present, and it is gated to GitHub Copilot Gemini models, so it never
 * touches well-formed arguments from any other provider/model.
 */

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A flattened key contains a bracket index like `foo[0]`. */
function hasFlattenedKey(keys: string[]): boolean {
  return keys.some((key) => /\[\d+\]/.test(key));
}

/**
 * Parse a flattened key such as `a.b[0].c` into path segments
 * `["a", "b", 0, "c"]`. Returns `undefined` for a plain key with no `.`/`[`.
 */
function parseFlattenedPath(key: string): Array<string | number> | undefined {
  if (!/[.[]/.test(key)) return undefined;
  const segments: Array<string | number> = [];
  let current = "";
  let index = 0;
  const flushCurrent = () => {
    if (current !== "") {
      segments.push(current);
      current = "";
    }
  };
  while (index < key.length) {
    const char = key[index];
    if (char === ".") {
      flushCurrent();
      index += 1;
    } else if (char === "[") {
      flushCurrent();
      const end = key.indexOf("]", index);
      if (end === -1) return undefined; // malformed — leave key untouched
      const inner = key.slice(index + 1, end);
      const numeric = Number(inner);
      if (Number.isInteger(numeric) && numeric >= 0 && inner.trim() !== "") {
        segments.push(numeric);
      } else {
        segments.push(inner.replace(/^["']|["']$/g, ""));
      }
      index = end + 1;
    } else {
      current += char;
      index += 1;
    }
  }
  flushCurrent();
  return segments.length > 0 ? segments : undefined;
}

/** Assign `value` at the given path inside `root`, creating arrays/objects as needed. */
function assignPath(root: JsonRecord, segments: Array<string | number>, value: unknown): void {
  let node: JsonRecord | unknown[] = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextIsIndex = typeof segments[i + 1] === "number";
    const container = node as Record<string | number, unknown>;
    const existing = container[segment];
    if (existing === undefined || existing === null || typeof existing !== "object") {
      container[segment] = nextIsIndex ? [] : {};
    }
    node = container[segment] as JsonRecord | unknown[];
  }
  (node as Record<string | number, unknown>)[segments[segments.length - 1]] = value;
}

/** Remove empty holes from sparse arrays produced by out-of-order indices. */
function compactSparseArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map((entry) => compactSparseArrays(entry));
  }
  if (isPlainObject(value)) {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) out[key] = compactSparseArrays(entry);
    return out;
  }
  return value;
}

/**
 * Reconstruct flattened Gemini tool-call arguments into proper nested
 * arrays/objects. Returns the original reference unchanged when no flattened
 * (`name[index]`) keys are present.
 */
export function unflattenGeminiToolArguments(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  const keys = Object.keys(args);
  if (!hasFlattenedKey(keys)) return args;

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(args)) {
    const segments = parseFlattenedPath(key);
    if (!segments) {
      result[key] = value;
      continue;
    }
    assignPath(result, segments, value);
  }
  return compactSparseArrays(result);
}

/**
 * If `model` is a GitHub Copilot Gemini model, normalize flattened tool-call
 * arguments; otherwise return them unchanged. Used to gate
 * {@link unflattenGeminiToolArguments} by model at tool-call time.
 */
export function normalizeToolArgumentsForModel(
  args: unknown,
  model: Pick<Model<Api>, "provider" | "api" | "id"> | undefined,
): unknown {
  if (!model || !isCopilotGeminiModel(model)) return args;
  return unflattenGeminiToolArguments(args);
}
