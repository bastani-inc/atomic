import type { Api, Model } from "@earendil-works/pi-ai/compat";

/**
 * Sanitizes outbound OpenAI-compatible request payloads for GitHub Copilot
 * Gemini models so their tool/function JSON Schemas survive translation to
 * Google's GenAI `FunctionDeclaration` schema.
 *
 * Why this exists
 * ---------------
 * `github-copilot` Gemini models (e.g. `gemini-3.1-pro-preview`) are served
 * through Copilot's CAPI gateway at `api.*.githubcopilot.com` using the
 * `openai-completions` API. CAPI receives the OpenAI chat-completions request
 * and translates it into a Google GenAI `GenerateContent` request. During that
 * translation CAPI forwards JSON Schema `anyOf`/`oneOf` verbatim into the Gemini
 * `FunctionDeclaration` schema. Gemini's function-declaration schema rejects an
 * `anyOf`/`oneOf` whose branch is a complex *object* schema, so Google returns
 * HTTP 400 and CAPI relabels it `{"error":{"code":"invalid_request_body"}}`.
 *
 * Atomic's bundled tools (notably the `workflow` tool) use the TypeBox
 * `Type.Union([Type.Object(...), Type.String()])` pattern for fields like
 * `task`, `chain`, and `parallel`, which emit exactly that construct. Because
 * those tools are present in normal chat turns, every Gemini request fails with
 * `400 invalid request body` until the schema is sanitized.
 *
 * What it does
 * ------------
 * Recursively rewrites each tool's `parameters` JSON Schema into the reduced
 * subset that CAPI/Gemini actually honors (`type`, `description`, `enum`,
 * `properties`, `required`, `items`, `nullable`, and scalar-only `anyOf`):
 *  - Resolves `anyOf`/`oneOf` that contain an object/array branch to the most
 *    expressive object/array branch (the core fix), preserving `description`
 *    and collapsing a `"null"` branch into `nullable: true`.
 *  - Converts `const` (and `anyOf` of `const`/`enum` scalars) into `enum`,
 *    which Gemini supports, so `Type.Literal(...)` unions keep their constraint.
 *  - Drops JSON Schema keywords CAPI strips or Gemini rejects (`$schema`,
 *    `$ref`, `$defs`, `patternProperties`, `additionalProperties`, `allOf`,
 *    `not`, `format`, `pattern`, numeric/length bounds, `default`, etc.).
 *  - Filters `required` down to keys still present under `properties`.
 *
 * The transform is gated to GitHub Copilot Gemini models only, so it never
 * changes payloads for any currently-working provider/model.
 */

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** JSON Schema keywords Gemini's function-declaration schema honors. */
const KEPT_SCHEMA_KEYWORDS = new Set<string>([
  "type",
  "description",
  "enum",
  "properties",
  "required",
  "items",
  "nullable",
]);

/**
 * Keywords that are dropped because CAPI strips them before Google and/or
 * Gemini's function schema rejects them. Listing them explicitly keeps the
 * intent auditable; any keyword not in {@link KEPT_SCHEMA_KEYWORDS} and not a
 * union keyword is dropped regardless. Exported so the documented drop-list has
 * a real consumer (and stays linted) without a per-iteration `void` reference.
 */
export const DROPPED_SCHEMA_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "additionalProperties",
  "additionalItems",
  "unevaluatedItems",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "default",
  "examples",
  "title",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentEncoding",
  "contentMediaType",
]);

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether this model is a GitHub Copilot Gemini model routed through the
 * OpenAI-completions CAPI path that needs schema sanitization.
 */
export function isCopilotGeminiModel(model: Pick<Model<Api>, "provider" | "api" | "id">): boolean {
  return (
    model.provider === "github-copilot" &&
    model.api === "openai-completions" &&
    /(^|[/-])gemini/i.test(model.id)
  );
}

function jsonScalarType(value: JsonValue): string | undefined {
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return value === null ? "null" : undefined;
  }
}

function isObjectOrArraySchema(schema: JsonValue): boolean {
  if (!isPlainObject(schema)) return false;
  return (
    schema.type === "object" ||
    schema.type === "array" ||
    "properties" in schema ||
    "items" in schema
  );
}

function isNullSchema(schema: JsonValue): boolean {
  return isPlainObject(schema) && schema.type === "null";
}

/** Collect literal values from a scalar branch expressed as `const` or `enum`. */
function literalValues(schema: JsonValue): JsonValue[] | undefined {
  if (!isPlainObject(schema)) return undefined;
  if ("const" in schema) return [schema.const as JsonValue];
  if (Array.isArray(schema.enum)) return schema.enum as JsonValue[];
  return undefined;
}

/**
 * Recursively rewrite a JSON Schema node into the Gemini-compatible subset.
 */
export function sanitizeGeminiSchema(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchema(entry));
  }
  if (!isPlainObject(schema)) {
    return schema;
  }

  const union = (schema.anyOf ?? schema.oneOf) as JsonValue | undefined;
  if (Array.isArray(union)) {
    return sanitizeUnion(schema, union);
  }

  const result: JsonObject = {};

  // const -> enum (Gemini supports enum, not const).
  if ("const" in schema && !("enum" in schema)) {
    const constValue = schema.const as JsonValue;
    const inferred = jsonScalarType(constValue);
    if (inferred && inferred !== "null") result.type = inferred;
    result.enum = [constValue];
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === "const") continue;
    if (key === "properties" && isPlainObject(value)) {
      const props: JsonObject = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      result.properties = props;
      continue;
    }
    if (key === "items") {
      result.items = sanitizeItems(value);
      continue;
    }
    if (KEPT_SCHEMA_KEYWORDS.has(key)) {
      result[key] = value;
      continue;
    }
    // Everything else (the documented DROPPED_SCHEMA_KEYWORDS plus any unknown
    // keyword) is omitted: the rule is simply "keep only KEPT_SCHEMA_KEYWORDS".
  }

  inferContainerType(result);
  pruneRequired(result);
  return result;
}

/**
 * Resolve an `items` schema. Gemini's function-declaration schema expects a
 * single `items` schema, so a tuple-form `items` (array of schemas) is collapsed
 * to its most expressive (object/array) entry, falling back to the first entry.
 */
function sanitizeItems(items: JsonValue): JsonValue {
  if (!Array.isArray(items)) return sanitizeGeminiSchema(items);
  const sanitized = items.map((entry) => sanitizeGeminiSchema(entry));
  const objectOrArray = sanitized.find((entry) => isObjectOrArraySchema(entry));
  return objectOrArray ?? sanitized[0] ?? { type: "string" };
}

/**
 * Gemini resolves function arguments more reliably when container nodes carry an
 * explicit `type`. Infer it when omitted: a node with `properties`/`required` is
 * an object, and a node with `items` is an array.
 */
function inferContainerType(schema: JsonObject): void {
  if (schema.type !== undefined) return;
  if (isPlainObject(schema.properties) || Array.isArray(schema.required)) {
    schema.type = "object";
  } else if (schema.items !== undefined) {
    schema.type = "array";
  }
}

/** Resolve an `anyOf`/`oneOf` union node into the Gemini-compatible subset. */
function sanitizeUnion(parent: JsonObject, branches: JsonValue[]): JsonValue {
  const sanitizedBranches = branches.map((branch) => sanitizeGeminiSchema(branch));
  const nullable =
    branches.some((branch) => isNullSchema(branch)) || parent.nullable === true;
  const nonNull = sanitizedBranches.filter((branch) => !isNullSchema(branch));

  const carryDescription = (target: JsonValue): JsonValue => {
    if (isPlainObject(target) && typeof parent.description === "string" && !("description" in target)) {
      target.description = parent.description;
    }
    if (nullable && isPlainObject(target)) target.nullable = true;
    return target;
  };

  // Core fix: if any branch is an object/array schema, collapse to the first
  // such branch (Gemini rejects unions whose branch is a complex object). For
  // the TypeBox `Type.Union([Type.Object(...), Type.String()])` pattern this is
  // the object branch; a union of two distinct object shapes keeps only the
  // first, so the others' properties are intentionally dropped.
  const objectOrArray = nonNull.find((branch) => isObjectOrArraySchema(branch));
  if (objectOrArray) {
    return carryDescription(objectOrArray);
  }

  if (nonNull.length === 0) {
    return carryDescription({ type: "string" });
  }
  if (nonNull.length === 1) {
    return carryDescription(nonNull[0]);
  }

  // All-scalar union: prefer an `enum` when every branch is a literal/enum of
  // one underlying type; otherwise keep a scalar `anyOf` (Gemini accepts it).
  const literals: JsonValue[] = [];
  const scalarTypes = new Set<string>();
  let allLiteral = true;
  for (const branch of nonNull) {
    const values = literalValues(branch);
    if (!values) {
      allLiteral = false;
      break;
    }
    for (const value of values) {
      literals.push(value);
      const inferred = jsonScalarType(value);
      if (inferred) scalarTypes.add(inferred);
    }
  }
  if (allLiteral && literals.length > 0) {
    const collapsed: JsonObject = { enum: literals };
    if (scalarTypes.size === 1) collapsed.type = [...scalarTypes][0];
    return carryDescription(collapsed);
  }

  const node: JsonObject = { anyOf: nonNull };
  return carryDescription(node);
}

/** Drop `required` entries that are not present under `properties`. */
function pruneRequired(schema: JsonObject): void {
  if (!Array.isArray(schema.required)) return;
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (!properties) {
    delete schema.required;
    return;
  }
  const filtered = schema.required.filter(
    (key): key is string => typeof key === "string" && key in properties,
  );
  if (filtered.length > 0) schema.required = filtered;
  else delete schema.required;
}

/** Sanitize a single tool's `parameters` schema in place-safe (returns new value). */
function sanitizeToolParameters(parameters: JsonValue): JsonValue {
  return sanitizeGeminiSchema(parameters);
}

/**
 * Sanitize an outbound provider payload for GitHub Copilot Gemini models.
 *
 * Returns the payload unchanged for any other provider/model, or when the
 * payload has no sanitizable `tools`. Mirrors the `onPayload`
 * `(payload: unknown) => unknown` contract used elsewhere in the SDK wiring.
 */
export function sanitizeCopilotGeminiPayload(
  payload: unknown,
  model: Pick<Model<Api>, "provider" | "api" | "id">,
): unknown {
  if (!isCopilotGeminiModel(model)) return payload;
  if (!isPlainObject(payload as JsonValue)) return payload;
  const payloadObject = payload as JsonObject;
  const tools = payloadObject.tools;
  if (!Array.isArray(tools) || tools.length === 0) return payload;

  let mutated = false;
  const sanitizedTools = tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    // OpenAI chat-completions tool shape: { type: "function", function: { parameters } }
    if (isPlainObject(tool.function) && tool.function.parameters !== undefined) {
      mutated = true;
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeToolParameters(tool.function.parameters),
        },
      };
    }
    // Defensive: flat tool shape { name, parameters }.
    if (tool.parameters !== undefined) {
      mutated = true;
      return { ...tool, parameters: sanitizeToolParameters(tool.parameters) };
    }
    return tool;
  });

  if (!mutated) return payload;
  return { ...payloadObject, tools: sanitizedTools };
}
