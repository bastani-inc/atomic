/**
 * Unit tests for validateInputs — the schema validator used by slash-command
 * and programmatic SDK dispatch paths before starting a run.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { validateInputs } from "../../packages/workflows/src/runs/shared/validate-inputs.js";
import type { WorkflowInputSchema } from "../../packages/workflows/src/shared/types.js";

const schema = (obj: Record<string, WorkflowInputSchema>): Readonly<Record<string, WorkflowInputSchema>> => obj;

describe("validateInputs", () => {
  test("no errors for well-formed inputs", () => {
    const errors = validateInputs(
      schema({
        prompt: Type.String(),
        count: Type.Number({ default: 3 }),
      }),
      { prompt: "hi", count: 5 },
    );
    assert.deepEqual(errors, []);
  });

  test("rejects wrong type: number", () => {
    const errors = validateInputs(
      schema({ count: Type.Optional(Type.Number()) }),
      { count: "three" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "count");
    assert.match(errors[0]!.reason, /number/);
  });

  test("rejects wrong type: boolean", () => {
    const errors = validateInputs(
      schema({ dry: Type.Optional(Type.Boolean()) }),
      { dry: "true" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "dry");
    assert.match(errors[0]!.reason, /boolean/);
  });

  test("rejects wrong type: text/string", () => {
    const errors = validateInputs(
      schema({ prompt: Type.Optional(Type.String()) }),
      { prompt: 42 },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "prompt");
  });

  test("rejects select value not in choices", () => {
    const errors = validateInputs(
      schema({ mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])) }),
      { mode: "c" },
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /a/);
    assert.match(errors[0]!.reason, /b/);
  });

  test("accepts select value when in choices", () => {
    const errors = validateInputs(
      schema({ mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])) }),
      { mode: "a" },
    );
    assert.deepEqual(errors, []);
  });

  test("rejects unknown input keys (catches typos)", () => {
    const errors = validateInputs(
      schema({ prompt: Type.Optional(Type.String()) }),
      { prompt: "hi", propmt: "typo" },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "propmt");
    assert.match(errors[0]!.reason.toLowerCase(), /unknown/);
  });

  test("reports missing required inputs", () => {
    const errors = validateInputs(
      schema({ prompt: Type.String() }),
      {},
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "prompt");
    assert.match(errors[0]!.reason.toLowerCase(), /required/);
  });

  test("does NOT report missing optional inputs", () => {
    const errors = validateInputs(
      schema({ count: Type.Optional(Type.Number()) }),
      {},
    );
    assert.deepEqual(errors, []);
  });

  test("collects multiple errors", () => {
    const errors = validateInputs(
      schema({
        prompt: Type.String(),
        count: Type.Optional(Type.Number()),
      }),
      { count: "x", unknown: 1 },
    );
    // missing prompt + count wrong type + unknown key = 3
    assert.equal(errors.length, 3);
  });

  test("NaN rejected as non-serializable number", () => {
    const errors = validateInputs(
      schema({ count: Type.Optional(Type.Number()) }),
      { count: Number.NaN },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "count");
    assert.match(errors[0]!.reason, /finite number/);
  });

  test("Infinity rejected as non-serializable number", () => {
    const errors = validateInputs(
      schema({ count: Type.Optional(Type.Number()) }),
      { count: Number.POSITIVE_INFINITY },
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.key, "count");
    assert.match(errors[0]!.reason, /finite number/);
  });

  test("rejects non-plain object instances as non-serializable", () => {
    for (const value of [new Date(), new Map(), /pattern/]) {
      const errors = validateInputs(schema({ value: Type.Unknown() }), { value: value as never });
      assert.equal(errors.length, 1, `${value.constructor.name} should be rejected`);
      assert.equal(errors[0]!.key, "value");
      assert.match(errors[0]!.reason, /JSON-serializable/);
    }
  });
});
