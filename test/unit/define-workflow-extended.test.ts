import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type, type TSchema } from "typebox";
import {
  schemaChoices,
  schemaFieldKind,
} from "../../packages/workflows/src/shared/schema-introspection.js";

describe("workflow config object semantics", () => {
  test("freezes current schema maps without mutating the source spec", () => {
    const inputs: Record<string, TSchema> = { a: Type.Optional(Type.String()) };
    const outputs: Record<string, TSchema> = { from: Type.String() };
    const def = workflow({
      name: "test",
      description: "v1",
      inputs,
      outputs,
      run: async () => ({ from: "fn1" }),
    });

    inputs.a = Type.Optional(Type.Number());
    assert.notEqual(def.inputs["a"], inputs.a);
    assert.equal(Object.isFrozen(def.inputs), true);
    assert.equal(Object.isFrozen(def.outputs), true);
  });

  test("run is wrapped as an async definition function", async () => {
    const fn = () => ({ from: "fn1" });
    const def = workflow({
      name: "async-wrapper-test",
      description: "",
      inputs: {},
      outputs: { from: Type.String() },
      run: fn,
    });

    assert.notEqual(def.run, fn);
    assert.deepEqual(await def.run({ inputs: {} } as Parameters<typeof def.run>[0]), { from: "fn1" });
  });
});

describe("workflow select input", () => {
  test("select schema accepted", () => {
    const def = workflow({
      name: "select-test",
      description: "",
      inputs: {
        mode: Type.Union(
          [Type.Literal("fast"), Type.Literal("thorough"), Type.Literal("balanced")],
          { description: "analysis mode" },
        ),
      },
      outputs: {},
      run: async () => ({}),
    });

    const schema = def.inputs["mode"];
    assert.equal(schemaFieldKind(schema), "select");
    assert.deepEqual(schemaChoices(schema), ["fast", "thorough", "balanced"]);
  });
});

describe("workflow normalizedName", () => {
  test("workflow sets normalizedName from name", () => {
    const def = workflow({
      name: "Deep Research Codebase",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });

    assert.equal(def.normalizedName, "deep-research-codebase");
    assert.equal(def.name, "Deep Research Codebase");
  });

  test("normalizedName used as registry key", () => {
    const def = workflow({
      name: "My Workflow",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });

    assert.equal(def.normalizedName, "my-workflow");
  });
});

describe("WorkflowDefinition deep freeze", () => {
  test("inputs map is frozen", () => {
    const def = workflow({
      name: "freeze-inputs",
      description: "",
      inputs: {
        x: Type.Optional(Type.String()),
      },
      outputs: {},
      run: async () => ({}),
    });

    assert.equal(Object.isFrozen(def.inputs), true);

    assert.throws(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.inputs["y"] = Type.String();
    });
  });

  test("top-level definition is frozen", () => {
    const def = workflow({
      name: "freeze-top",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });

    assert.equal(Object.isFrozen(def), true);
  });
});
