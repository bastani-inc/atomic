/**
 * Unit tests for validateInputs — the schema validator used by slash-command
 * and programmatic SDK dispatch paths before starting a run.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { validateInputs } from "../../src/runs/shared/validate-inputs.js";
import type { WorkflowInputSchema } from "../../src/shared/types.js";

const schema = (obj: Record<string, WorkflowInputSchema>): Readonly<Record<string, WorkflowInputSchema>> => obj;

describe("validateInputs", () => {
  test("no errors for well-formed inputs", () => {
    const errors = validateInputs(
      schema({
        prompt: { type: "text", required: true },
        count: { type: "number", default: 3 },
      }),
      { prompt: "hi", count: 5 },
    );
    assert.deepEqual(errors, []);
  });

  test("rejects wrong type: number", () => {
    const errors = validateInputs(
      schema({ count: { type: "number" } }),
      { count: "three" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "count");
    assert.match(errors[0]!.reason, /number/);
  });

  test("rejects wrong type: boolean", () => {
    const errors = validateInputs(
      schema({ dry: { type: "boolean" } }),
      { dry: "true" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "dry");
    assert.match(errors[0]!.reason, /boolean/);
  });

  test("rejects wrong type: text/string", () => {
    const errors = validateInputs(
      schema({ prompt: { type: "text" } }),
      { prompt: 42 },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "prompt");
  });

  test("rejects select value not in choices", () => {
    const errors = validateInputs(
      schema({ mode: { type: "select", choices: ["a", "b"] } }),
      { mode: "c" },
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /a/);
    assert.match(errors[0]!.reason, /b/);
  });

  test("accepts select value when in choices", () => {
    const errors = validateInputs(
      schema({ mode: { type: "select", choices: ["a", "b"] } }),
      { mode: "a" },
    );
    assert.deepEqual(errors, []);
  });

  test("rejects unknown input keys (catches typos)", () => {
    const errors = validateInputs(
      schema({ prompt: { type: "text" } }),
      { prompt: "hi", propmt: "typo" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "propmt");
    assert.match(errors[0]!.reason.toLowerCase(), /unknown/);
  });

  test("reports missing required inputs", () => {
    const errors = validateInputs(
      schema({ prompt: { type: "text", required: true } }),
      {},
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "prompt");
    assert.match(errors[0]!.reason.toLowerCase(), /required/);
  });

  test("does NOT report missing optional inputs", () => {
    const errors = validateInputs(
      schema({ count: { type: "number" } }),
      {},
    );
    assert.deepEqual(errors, []);
  });

  test("collects multiple errors", () => {
    const errors = validateInputs(
      schema({
        prompt: { type: "text", required: true },
        count: { type: "number" },
      }),
      { count: "x", unknown: 1 },
    );
    // missing prompt + count wrong type + unknown key = 3
    assert.equal(errors.length, 3);
  });

  test("NaN rejected as not-a-number", () => {
    const errors = validateInputs(
      schema({ count: { type: "number" } }),
      { count: Number.NaN },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "count");
  });
});
