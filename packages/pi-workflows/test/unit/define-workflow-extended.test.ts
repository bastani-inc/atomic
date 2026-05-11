import { test, expect, describe } from "bun:test";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";

describe("defineWorkflow immutable builder semantics", () => {
  test("description does not mutate previous builder", () => {
    const b1 = defineWorkflow("test");
    const b2 = b1.description("v1");
    const b3 = b2.description("v2");

    // b2 and b3 are distinct objects
    expect(b2).not.toBe(b3);

    // Each compiles independently
    const d2 = b2.run(async () => ({})).compile();
    const d3 = b3.run(async () => ({})).compile();

    expect(d2.description).toBe("v1");
    expect(d3.description).toBe("v2");
  });

  test("input does not mutate previous builder", () => {
    const b1 = defineWorkflow("test");
    const b2 = b1.input("a", { type: "text" });
    const b3 = b2.input("b", { type: "number" });

    expect(b2).not.toBe(b3);

    const d2 = b2.run(async () => ({})).compile();
    const d3 = b3.run(async () => ({})).compile();

    // b2 only has input "a"
    expect(Object.keys(d2.inputs)).toEqual(["a"]);
    // b3 has both
    expect(Object.keys(d3.inputs).sort()).toEqual(["a", "b"]);
  });

  test("run does not mutate previous builder", () => {
    const fn1 = async () => ({ from: "fn1" });
    const fn2 = async () => ({ from: "fn2" });

    const b = defineWorkflow("test");
    const c1 = b.run(fn1);
    const c2 = b.run(fn2);

    const d1 = c1.compile();
    const d2 = c2.compile();

    expect(d1.run).toBe(fn1);
    expect(d2.run).toBe(fn2);
  });
});

describe("defineWorkflow select input", () => {
  test("select schema accepted", () => {
    const def = defineWorkflow("select-test")
      .input("mode", {
        type: "select",
        choices: ["fast", "thorough", "balanced"],
        description: "analysis mode",
        required: true,
      })
      .run(async () => ({}))
      .compile();

    const schema = def.inputs["mode"];
    expect(schema.type).toBe("select");
    if (schema.type === "select") {
      expect(schema.choices).toEqual(["fast", "thorough", "balanced"]);
    }
  });
});

describe("defineWorkflow normalizedName", () => {
  test("compile sets normalizedName from name", () => {
    const def = defineWorkflow("Deep Research Codebase")
      .run(async () => ({}))
      .compile();

    expect(def.normalizedName).toBe("deep-research-codebase");
    expect(def.name).toBe("Deep Research Codebase");
  });

  test("normalizedName used as registry key", () => {
    const def = defineWorkflow("My Workflow")
      .run(async () => ({}))
      .compile();

    expect(def.normalizedName).toBe("my-workflow");
  });
});

describe("WorkflowDefinition deep freeze", () => {
  test("inputs map is frozen", () => {
    const def = defineWorkflow("freeze-inputs")
      .input("x", { type: "text" })
      .run(async () => ({}))
      .compile();

    expect(Object.isFrozen(def.inputs)).toBe(true);

    expect(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.inputs["y"] = { type: "text" };
    }).toThrow();
  });

  test("top-level definition is frozen", () => {
    const def = defineWorkflow("freeze-top")
      .run(async () => ({}))
      .compile();

    expect(Object.isFrozen(def)).toBe(true);
  });
});
