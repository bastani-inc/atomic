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
