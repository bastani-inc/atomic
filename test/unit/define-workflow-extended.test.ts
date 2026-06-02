import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
import {
  schemaChoices,
  schemaFieldKind,
} from "../../packages/workflows/src/shared/schema-introspection.js";

describe("defineWorkflow immutable builder semantics", () => {
  test("description does not mutate previous builder", () => {
    const b1 = defineWorkflow("test");
    const b2 = b1.description("v1");
    const b3 = b2.description("v2");

    // b2 and b3 are distinct objects
    assert.notEqual(b2, b3);

    // Each compiles independently
    const d2 = b2.run(async () => ({})).compile();
    const d3 = b3.run(async () => ({})).compile();

    assert.equal(d2.description, "v1");
    assert.equal(d3.description, "v2");
  });

  test("input does not mutate previous builder", () => {
    const b1 = defineWorkflow("test");
    const b2 = b1.input("a", Type.Optional(Type.String()));
    const b3 = b2.input("b", Type.Optional(Type.Number()));

    assert.notEqual(b2, b3);

    const d2 = b2.run(async () => ({})).compile();
    const d3 = b3.run(async () => ({})).compile();

    // b2 only has input "a"
    assert.deepEqual(Object.keys(d2.inputs), ["a"]);
    // b3 has both
    assert.deepEqual(Object.keys(d3.inputs).sort(), ["a", "b"]);
  });

  test("run does not mutate previous builder", () => {
    const fn1 = async () => ({ from: "fn1" });
    const fn2 = async () => ({ from: "fn2" });

    const b = defineWorkflow("test");
    const c1 = b.run(fn1);
    const c2 = b.run(fn2);

    const d1 = c1.compile();
    const d2 = c2.compile();

    assert.equal(d1.run, fn1);
    assert.equal(d2.run, fn2);
  });
});

describe("defineWorkflow select input", () => {
  test("select schema accepted", () => {
    const def = defineWorkflow("select-test")
      .input("mode", Type.Union(
        [Type.Literal("fast"), Type.Literal("thorough"), Type.Literal("balanced")],
        { description: "analysis mode" },
      ))
      .run(async () => ({}))
      .compile();

    const schema = def.inputs["mode"];
    assert.equal(schemaFieldKind(schema), "select");
    assert.deepEqual(schemaChoices(schema), ["fast", "thorough", "balanced"]);
  });
});

describe("defineWorkflow normalizedName", () => {
  test("compile sets normalizedName from name", () => {
    const def = defineWorkflow("Deep Research Codebase")
      .run(async () => ({}))
      .compile();

    assert.equal(def.normalizedName, "deep-research-codebase");
    assert.equal(def.name, "Deep Research Codebase");
  });

  test("normalizedName used as registry key", () => {
    const def = defineWorkflow("My Workflow")
      .run(async () => ({}))
      .compile();

    assert.equal(def.normalizedName, "my-workflow");
  });
});

describe("WorkflowDefinition deep freeze", () => {
  test("inputs map is frozen", () => {
    const def = defineWorkflow("freeze-inputs")
      .input("x", Type.Optional(Type.String()))
      .run(async () => ({}))
      .compile();

    assert.equal(Object.isFrozen(def.inputs), true);

    assert.throws(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.inputs["y"] = Type.String();
    });
  });

  test("top-level definition is frozen", () => {
    const def = defineWorkflow("freeze-top")
      .run(async () => ({}))
      .compile();

    assert.equal(Object.isFrozen(def), true);
  });
});
