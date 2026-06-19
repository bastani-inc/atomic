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
    const result = unflattenToolArguments({
      "metadata.confidence": 0.5,
      "metadata.tags[0]": "x",
      "metadata.tags[1]": "y",
      name: "n",
    });
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
    // JSON.parse keeps `__proto__` as an own property (the real wire shape).
    const args = JSON.parse('{"x[0]":"a","__proto__.polluted":"yes"}');
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
    const args = JSON.parse('{"a[0]":1,"constructor.prototype.polluted":"x"}');
    const result = unflattenToolArguments(args);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { a: [1] });
  });
});
