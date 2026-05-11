import { test, expect, describe } from "bun:test";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import type { WorkflowDefinition } from "../../src/shared/types.js";

describe("defineWorkflow builder", () => {
  test("compiles a valid workflow definition", () => {
    const def = defineWorkflow("my-workflow")
      .description("test workflow")
      .input("prompt", { type: "text", required: true, description: "task" })
      .run(async (ctx) => {
        const result = await ctx.stage("step1").prompt(ctx.inputs.prompt as string);
        return { result };
      })
      .compile();

    expect(def.__piWorkflow).toBe(true);
    expect(def.name).toBe("my-workflow");
    expect(def.description).toBe("test workflow");
    expect(def.inputs["prompt"]).toEqual({ type: "text", required: true, description: "task" });
    expect(typeof def.run).toBe("function");
  });

  test("compile throws if .run() not called", () => {
    expect(() =>
      (defineWorkflow("broken") as unknown as ReturnType<typeof defineWorkflow> & { compile(): unknown }).compile()
    ).toThrow('.run(fn) must be called before .compile()');
  });

  test("defineWorkflow throws on empty name", () => {
    expect(() => defineWorkflow("")).toThrow("name must be a non-empty string");
  });

  test("definition is frozen", () => {
    const def = defineWorkflow("frozen-test")
      .run(async () => ({}))
      .compile();

    expect(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.name = "mutated";
    }).toThrow();
  });

  test("multiple inputs accumulate", () => {
    const def = defineWorkflow("multi-input")
      .input("a", { type: "text" })
      .input("b", { type: "number", default: 4 })
      .run(async () => ({}))
      .compile();

    expect(Object.keys(def.inputs)).toEqual(["a", "b"]);
    expect(def.inputs["b"]).toEqual({ type: "number", default: 4 });
  });
});
