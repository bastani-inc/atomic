/**
 * Unit tests — packages/mcp/utils.ts unflattenToolArguments
 *
 * GitHub Copilot Gemini models serialize array/object tool-call arguments as
 * flattened `name[index]` keys on the wire. The MCP package normalizes them at
 * the `callTool` boundary so MCP servers receive well-formed arguments.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { unflattenToolArguments } from "../../packages/mcp/utils.js";

describe("unflattenToolArguments", () => {
  test("reconstructs a flattened array argument", () => {
    const result = unflattenToolArguments({
      summary: "s",
      "keywords[0]": "RAG",
      "keywords[1]": "agents",
      "keywords[2]": "LLM",
      confidence: 0.9,
    });
    assert.deepEqual(result, {
      summary: "s",
      keywords: ["RAG", "agents", "LLM"],
      confidence: 0.9,
    });
  });

  test("is a no-op for well-formed arguments (returns same reference)", () => {
    const args = { keywords: ["a", "b"], summary: "s" };
    const result = unflattenToolArguments(args);
    assert.equal(result, args);
  });

  test("returns an empty object for null/undefined", () => {
    assert.deepEqual(unflattenToolArguments(null), {});
    assert.deepEqual(unflattenToolArguments(undefined), {});
  });

  test("reconstructs nested objects inside flattened arrays", () => {
    const result = unflattenToolArguments({
      "files[0].path": "a.ts",
      "files[0].status": "modified",
      "files[1].path": "b.ts",
      "files[1].status": "created",
    });
    assert.deepEqual(result, {
      files: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "created" },
      ],
    });
  });

  test("reconstructs flattened nested object keys (dot notation)", () => {
    // `metadata` is an object container in the schema, so the dotted keys
    // `metadata.confidence` and `metadata.tags[0]` are real nested paths.
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
          properties: {
            confidence: { type: "number" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        name: { type: "string" },
      },
    };
    const result = unflattenToolArguments({
      "metadata.confidence": 0.5,
      "metadata.tags[0]": "x",
      "metadata.tags[1]": "y",
      name: "n",
    }, schema);
    assert.deepEqual(result, {
      metadata: { confidence: 0.5, tags: ["x", "y"] },
      name: "n",
    });
  });

  test("compacts out-of-order / sparse array indices into a dense array", () => {
    const result = unflattenToolArguments({
      "items[2]": "c",
      "items[0]": "a",
      "items[1]": "b",
    });
    assert.deepEqual(result, { items: ["a", "b", "c"] });
  });

  test("leaves plain keys that merely contain digits untouched", () => {
    const args = { value1: "a", value2: "b" };
    const result = unflattenToolArguments(args);
    assert.equal(result, args);
  });

  test("drops __proto__ path keys and does not pollute Object.prototype", () => {
    // A bracket-indexed proto-pollution attempt is split into a path, then
    // dropped because `__proto__` is an unsafe path segment.
    const args = JSON.parse('{"x[0]":"a","__proto__[0].polluted":"yes"}');
    const result = unflattenToolArguments(args);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { x: ["a"] });
  });

  test("drops a literal __proto__ own key", () => {
    const args = JSON.parse('{"x[0]":"a","__proto__":{"polluted":true}}');
    const result = unflattenToolArguments(args);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { x: ["a"] });
  });

  test("drops constructor.prototype paths", () => {
    // A bracket-indexed constructor.prototype attempt is split into a path and
    // dropped because `constructor`/`prototype` are unsafe path segments.
    const args = JSON.parse('{"a[0]":1,"constructor.prototype[0].polluted":"x"}');
    const result = unflattenToolArguments(args);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { a: [1] });
  });

  test("literal dotted __proto__ key is preserved but does not pollute", () => {
    // Without a schema, `__proto__.polluted` is a pure dotted key and is
    // preserved as a literal own-property name — it does NOT traverse the
    // prototype chain and cannot pollute Object.prototype.
    const args = JSON.parse('{"x[0]":"a","__proto__.polluted":"yes"}');
    const result = unflattenToolArguments(args);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { x: ["a"], "__proto__.polluted": "yes" });
  });

  // -------------------------------------------------------------------------
  // Schema-aware dotted-key disambiguation (issue #1496)
  // -------------------------------------------------------------------------

  test("preserves a literal dotted top-level key when no schema is supplied", () => {
    // No bracket keys, no schema: `filter.name` is ambiguous and must be left
    // intact rather than silently split into `{ filter: { name } }`.
    const args = { "filter.name": "tony", limit: 10 };
    const result = unflattenToolArguments(args);
    assert.equal(result, args);
  });

  test("preserves a literal dotted key when the schema does not mark it a container", () => {
    // The schema declares `filter.name` as a literal string property — its head
    // segment `filter` is NOT a container, so the key must be preserved verbatim.
    const schema = {
      type: "object",
      properties: {
        "filter.name": { type: "string" },
        limit: { type: "number" },
      },
    };
    const args = { "filter.name": "tony", limit: 10 };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, { "filter.name": "tony", limit: 10 });
  });

  test("splits a dotted key when the schema marks its head as an object container", () => {
    // `options` is an object container in the schema, so `options.verbose` is a
    // real nested path and must be reconstructed.
    const schema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { verbose: { type: "boolean" }, depth: { type: "number" } },
        },
      },
    };
    const args = { "options.verbose": true, "options.depth": 3 };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, { options: { verbose: true, depth: 3 } });
  });

  test("splits a dotted key whose head is an array container in the schema", () => {
    const schema = {
      type: "object",
      properties: {
        filters: { type: "array", items: { type: "string" } },
      },
    };
    // Even without brackets, an array-typed head is a container.
    const args = { "filters.0": "a", "filters.1": "b" };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, { filters: { "0": "a", "1": "b" } });
  });

  test("always reconstructs bracket-indexed keys regardless of schema", () => {
    const schema = {
      type: "object",
      properties: { ids: { type: "array", items: { type: "number" } } },
    };
    const args = { "ids[0]": 1, "ids[1]": 2 };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, { ids: [1, 2] });
  });

  test("reconstructs bracket-indexed keys even without a schema", () => {
    const args = { "ids[0]": 1, "ids[1]": 2 };
    const result = unflattenToolArguments(args);
    assert.deepEqual(result, { ids: [1, 2] });
  });

  test("mixed schema: preserves literal dotted key while splitting container dotted key", () => {
    const schema = {
      type: "object",
      properties: {
        "filter.name": { type: "string" },
        options: { type: "object", properties: { verbose: { type: "boolean" } } },
      },
    };
    const args = {
      "filter.name": "tony",
      "options.verbose": true,
      limit: 5,
    };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, {
      "filter.name": "tony",
      options: { verbose: true },
      limit: 5,
    });
  });

  test("bracket keys do not force literal dotted siblings to split (issue #1496)", () => {
    // Without a schema, `meta.confidence` is a pure dotted key and must be
    // preserved verbatim even though a bracket sibling (`tags[0]`) is present.
    const args = {
      "tags[0]": "a",
      "tags[1]": "b",
      "meta.confidence": 0.5,
    };
    const result = unflattenToolArguments(args);
    assert.deepEqual(result, {
      tags: ["a", "b"],
      "meta.confidence": 0.5,
    });
  });

  test("bracket sibling + schema container proof: dotted key splits", () => {
    // With a schema proving `meta` is an object container, `meta.confidence`
    // splits into a nested path even alongside bracket siblings.
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: { confidence: { type: "number" } },
        },
      },
    };
    const args = {
      "tags[0]": "a",
      "tags[1]": "b",
      "meta.confidence": 0.5,
    };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, {
      tags: ["a", "b"],
      meta: { confidence: 0.5 },
    });
  });

  test("issue #1496 exact regression: literal dotted key preserved with bracket sibling", () => {
    // The exact payload from the bug report: a literal top-level property
    // `filter.name` (schema-declared string) alongside a flattened array `ids`.
    // The bracket-indexed `ids[0]` is always reconstructed, but `filter.name`
    // must NOT split because the schema declares it as a literal string
    // property (its head `filter` is not a container).
    const schema = {
      type: "object",
      properties: {
        "filter.name": { type: "string" },
        ids: { type: "array", items: { type: "string" } },
      },
    };
    const result = unflattenToolArguments(
      { "filter.name": "status", "ids[0]": "123" },
      schema,
    );
    assert.deepEqual(result, { "filter.name": "status", ids: ["123"] });
  });

  test("preserves a literal dotted key that happens to share a name with a non-container prop", () => {
    const schema = {
      type: "object",
      properties: {
        filter: { type: "string" }, // `filter` is a scalar, not a container
      },
    };
    const args = { "filter.name": "tony" };
    const result = unflattenToolArguments(args, schema);
    assert.deepEqual(result, { "filter.name": "tony" });
  });
});
