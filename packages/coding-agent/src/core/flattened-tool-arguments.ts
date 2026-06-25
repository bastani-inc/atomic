/**
 * Canonical reconstruction of flattened tool-call arguments.
 *
 * Some upstream providers — notably GitHub Copilot Gemini models proxied through
 * Google's GenAI API — serialize array/object function-call arguments as
 * flattened, indexed keys on the wire. For example a tool called with
 * `{ keywords: ["a", "b"] }` arrives as `{ "keywords[0]": "a", "keywords[1]": "b" }`,
 * and `{ files: [{ path }] }` as `{ "files[0].path": "..." }`.
 *
 * This module is the single source of truth for turning those flattened keys
 * back into nested arrays/objects. Both the host runtime's per-tool
 * normalization (gated to Copilot Gemini, schema-aware) and the MCP `callTool`
 * boundary (provider-agnostic, bracket self-gating) delegate here so the two
 * paths cannot drift — in particular so the prototype-pollution guard lives in
 * exactly one place.
 *
 * Security: argument keys cross a trust boundary (model/provider wire → tool /
 * MCP server validation). A key path that walks through `__proto__`,
 * `constructor`, or `prototype` could otherwise reach `Object.prototype` and
 * mutate it process-wide. Any key whose path contains such a segment — at any
 * position, including the final segment and a literal plain key — is dropped.
 */

/** Key segments that must never be written or traversed (prototype pollution). */
const UNSAFE_KEY_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isUnsafeSegment(segment: string | number): boolean {
  return typeof segment === "string" && UNSAFE_KEY_SEGMENTS.has(segment);
}

/**
 * Parse a flattened key such as `a.b[0].c` into path segments
 * `["a", "b", 0, "c"]`. Returns `undefined` for a plain key with no `.`/`[`, or
 * for a malformed bracket expression (left untouched by the caller).
 */
export function parseFlattenedKeyPath(key: string): Array<string | number> | undefined {
  if (!/[.[]/.test(key)) return undefined;
  const segments: Array<string | number> = [];
  let current = "";
  let index = 0;
  const flush = () => {
    if (current !== "") {
      segments.push(current);
      current = "";
    }
  };
  while (index < key.length) {
    const char = key[index];
    if (char === ".") {
      flush();
      index += 1;
    } else if (char === "[") {
      flush();
      const end = key.indexOf("]", index);
      if (end === -1) return undefined; // malformed — leave key untouched
      const inner = key.slice(index + 1, end);
      const numeric = Number(inner);
      if (inner.trim() !== "" && Number.isInteger(numeric) && numeric >= 0) {
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
  flush();
  return segments.length > 0 ? segments : undefined;
}

/** Assign `value` at the given path inside `root`, creating arrays/objects as needed. */
function assignFlattenedKeyPath(
  root: Record<string | number, unknown>,
  segments: Array<string | number>,
  value: unknown,
): void {
  let node: Record<string | number, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextIsIndex = typeof segments[i + 1] === "number";
    const existing = node[segment];
    if (existing === null || existing === undefined || typeof existing !== "object") {
      node[segment] = nextIsIndex ? [] : {};
    }
    node = node[segment] as Record<string | number, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * Remove empty holes from sparse arrays produced by out-of-order indices.
 *
 * Note: this collapses holes rather than preserving them — `name[0]` + `name[2]`
 * (no index 1) becomes a dense 2-element array `[a, c]`, not `[a, <hole>, c]`.
 * That is the intended healing for Gemini's flattened output (which emits
 * contiguous indices in practice); it would, however, silently misalign two
 * arrays that were meant to be index-paired.
 */
function compactSparseArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map((entry) => compactSparseArrays(entry));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = compactSparseArrays(entry);
    return out;
  }
  return value;
}

/**
 * Reconstruct (unflatten) flattened keys into nested arrays/objects — for
 * example `"items[0]"` -> `{ items: [...] }` and `"parent.child"` ->
 * `{ parent: { child: ... } }`. `shouldSplit` decides, per key, whether it is a
 * flattened path (true) or an opaque literal key to be preserved (false);
 * callers apply their own gating/schema logic there.
 *
 * Prototype-pollution safe: a key whose parsed path contains `__proto__`,
 * `constructor`, or `prototype` (at any position) is dropped, as is a literal
 * plain key equal to one of those names.
 */
export function reconstructFlattenedKeys(
  args: Record<string, unknown>,
  shouldSplit: (key: string) => boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const segments = shouldSplit(key) ? parseFlattenedKeyPath(key) : undefined;
    if (!segments) {
      // Plain passthrough — but never assign a literal prototype-polluting key.
      if (!UNSAFE_KEY_SEGMENTS.has(key)) result[key] = value;
      continue;
    }
    if (segments.some(isUnsafeSegment)) continue; // drop a polluting path entirely
    assignFlattenedKeyPath(result, segments, value);
  }
  return compactSparseArrays(result) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema-aware unflattening
// ---------------------------------------------------------------------------
//
// A flattened key with a bracket index (`foo[0]`) is unambiguous and is always
// reconstructed. A purely dotted key (`parent.child`) is ambiguous: it could be
// a real nested path *or* a legitimate argument whose name literally contains
// a dot (for example an MCP tool whose JSON Schema declares a property named
// `filter.name`). To avoid corrupting such literal dotted keys, a dotted key is
// only split when the tool's `inputSchema` proves its head segment is an
// object/array container property. The presence of a bracket-indexed sibling
// does NOT force a pure dotted key to split — the two are decided per key, so
// a literal property such as `filter.name` survives intact even when a bracket
// sibling like `ids[0]` is present (issue #1496). Callers that only want the
// unambiguous bracket case can omit the schema.

type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A flattened key contains a bracket index like `foo[0]`. */
function hasBracketIndex(key: string): boolean {
  return /\[\d+\]/.test(key);
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

/** Exact top-level `schema.properties` names (literal property keys). */
function literalPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(schema)) return names;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return names;
  for (const name of Object.keys(properties)) names.add(name);
  return names;
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
 *
 * - Bracket-indexed keys (`foo[0]`, `foo[0].bar`) always split: they are
 *   unambiguous evidence of provider flattening.
 * - Purely dotted keys (`parent.child`) split only when the schema marks their
 *   head segment as an object/array container property AND the schema does not
 *   declare the full key as a literal top-level property. The latter guard
 *   protects a schema that intentionally defines both a literal dotted property
 *   (e.g. `filter.name`) and a same-head container (e.g. `filter`): the literal
 *   property wins and is preserved verbatim (reviewer-b P2, issue #1496). The
 *   presence of a bracket-indexed sibling does NOT force a pure dotted key to
 *   split, so a literal property name such as `filter.name` is preserved
 *   verbatim even when a sibling like `ids[0]` is reconstructed.
 */
function shouldSplitKey(key: string, containers: Set<string>, literals: Set<string>): boolean {
  if (hasBracketIndex(key)) return true;
  if (literals.has(key)) return false; // explicit literal property wins
  return isDottedContainerKey(key, containers);
}

/**
 * Reconstruct flattened tool-call arguments into nested arrays/objects using
 * schema-aware disambiguation for dotted keys.
 *
 * - Bracket-indexed keys (`ids[0]`, `files[0].path`) are always reconstructed.
 * - Purely dotted keys (`parent.child`) are reconstructed only when the optional
 *   `schema` marks their head segment as an object/array container property.
 *   The presence of a bracket-indexed sibling does NOT force a pure dotted key
 *   to split, so a literal property name such as `filter.name` survives intact
 *   even when a sibling like `ids[0]` is present (issue #1496).
 * - Otherwise dotted keys are preserved verbatim — fixing the regression where a
 *   literal property name like `filter.name` was silently corrupted.
 *
 * Returns the original reference unchanged when there is nothing to
 * reconstruct. Prototype-pollution safety is delegated to
 * {@link reconstructFlattenedKeys}.
 */
export function unflattenArgumentsWithSchema(
  args: Record<string, unknown>,
  schema?: unknown,
): Record<string, unknown> {
  const keys = Object.keys(args);
  const literals = literalPropertyNames(schema);
  const containers = containerPropertyNames(schema);
  const hasBracket = keys.some((key) => hasBracketIndex(key));
  // A dotted key needs splitting only if it is not a literal property AND its
  // head is a schema container. Literal dotted properties are always preserved.
  const hasSplittableDotted = keys.some(
    (key) => !literals.has(key) && isDottedContainerKey(key, containers),
  );
  if (!hasBracket && !hasSplittableDotted) return args;
  return reconstructFlattenedKeys(args, (key) => shouldSplitKey(key, containers, literals));
}
