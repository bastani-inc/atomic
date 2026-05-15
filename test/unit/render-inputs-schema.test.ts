/**
 * Unit tests for the shared renderInputsSchema helper used by:
 *   - renderResult({action: "inputs"}) (LLM tool path)
 *   - /workflow inputs <name> slash command
 *   - /workflow <name> --help slash form
 *   - programmatic SDK validation failures
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderInputsSchema } from "../../src/shared/render-inputs-schema.js";

describe("renderInputsSchema", () => {
  test("renders header with workflow name and indented per-input lines", () => {
    const out = renderInputsSchema("deep-research", [
      { name: "prompt", type: "text", required: true, description: "Research topic" },
      { name: "max_partitions", type: "number", default: 4 },
    ]);
    const lines = out.split("\n");
    assert.equal(lines[0], 'Inputs for "deep-research":');
    assert.equal(lines[1], "  prompt: text (required) — Research topic");
    assert.equal(lines[2], "  max_partitions: number [default: 4]");
  });

  test("string default is JSON-quoted (distinguishes \"\" from absent)", () => {
    const out = renderInputsSchema("flow", [
      { name: "label", type: "text", default: "" },
    ]);
    assert.match(out, /label: text \[default: ""\]/);
  });

  test("boolean default rendered as JSON literal", () => {
    const out = renderInputsSchema("flow", [
      { name: "dry", type: "boolean", default: false },
    ]);
    assert.match(out, /dry: boolean \[default: false\]/);
  });

  test("omits default segment when default is undefined", () => {
    const out = renderInputsSchema("flow", [{ name: "x", type: "text" }]);
    assert.equal(out, 'Inputs for "flow":\n  x: text');
  });

  test("omits description segment when description is absent", () => {
    const out = renderInputsSchema("flow", [
      { name: "x", type: "text", required: true },
    ]);
    assert.match(out, /^Inputs for "flow":\n  x: text \(required\)$/);
  });

  test("empty inputs array reports no declared inputs", () => {
    assert.equal(
      renderInputsSchema("bare", []),
      'Workflow "bare" has no declared inputs.',
    );
  });
});
