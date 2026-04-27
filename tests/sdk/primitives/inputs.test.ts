import { test, expect, describe } from "bun:test";
import { defineWorkflow } from "../../../src/sdk/define-workflow.ts";
import { validateInputs } from "../../../src/sdk/primitives/inputs.ts";

const wf = defineWorkflow({
  name: "x",
  source: import.meta.path,
  inputs: [
    { name: "topic", type: "string", required: true },
    {
      name: "mode",
      type: "enum",
      required: true,
      values: ["fast", "thorough"],
      default: "fast",
    },
    { name: "limit", type: "integer", default: 10 },
  ],
})
  .for("claude")
  .run(async () => {})
  .compile();

describe("primitives/inputs.validateInputs", () => {
  test("applies declared defaults", () => {
    const out = validateInputs(wf, { topic: "auth" });
    expect(out["topic"]).toBe("auth");
    expect(out["mode"]).toBe("fast");
    expect(out["limit"]).toBe("10");
  });

  test("throws on missing required input", () => {
    expect(() => validateInputs(wf, {})).toThrow(/Missing required input/);
  });

  test("throws on unknown input", () => {
    expect(() => validateInputs(wf, { topic: "auth", junk: "x" })).toThrow(
      /Unknown input/,
    );
  });

  test("throws on invalid enum value", () => {
    expect(() =>
      validateInputs(wf, { topic: "auth", mode: "weird" }),
    ).toThrow(/Invalid value for "--mode"/);
  });

  test("throws on non-integer integer input", () => {
    expect(() =>
      validateInputs(wf, { topic: "auth", limit: "abc" }),
    ).toThrow(/Invalid value for "--limit"/);
  });

  test("free-form workflows pass inputs through as-is", () => {
    const free = defineWorkflow({ name: "f", source: import.meta.path })
      .for("claude")
      .run(async () => {})
      .compile();
    const out = validateInputs(free, { prompt: "hi", extra: "ok" });
    expect(out["prompt"]).toBe("hi");
    expect(out["extra"]).toBe("ok");
  });
});
