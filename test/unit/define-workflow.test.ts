import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type } from "typebox";
import {
  deriveInputField,
  schemaDescription,
  schemaFieldKind,
  schemaIsRequired,
} from "../../packages/workflows/src/shared/schema-introspection.js";

describe("workflow authoring door", () => {
  test("emits a valid workflow definition", () => {
    const def = workflow({
      name: "my-workflow",
      description: "test workflow",
      inputs: {
        prompt: Type.String({ description: "task" }),
      },
      outputs: {
        result: Type.String(),
      },
      run: async (ctx) => {
        const prompt: string = ctx.inputs.prompt;
        const result = await ctx.stage("step1").prompt(prompt);
        return { result };
      },
    });

    assert.equal(def.__piWorkflow, true);
    assert.equal(def.name, "my-workflow");
    assert.equal(def.description, "test workflow");
    assert.deepEqual(deriveInputField("prompt", def.inputs["prompt"]), {
      name: "prompt",
      type: "text",
      required: true,
      description: "task",
    });
    assert.equal(typeof def.run, "function");
  });

  test("rejects undeclared outputs after an output contract is declared", () => {
    workflow({
      name: "strict-output-contract",
      description: "",
      inputs: {},
      outputs: {
        summary: Type.String(),
      },
      // @ts-expect-error run must not return keys missing from outputs.
      run: () => ({ summary: "ok", extra: "not declared" }),
    });
  });

  test("rejects outputs when no output contract is declared", () => {
    workflow({
      name: "strict-no-output-contract",
      description: "",
      inputs: {},
      outputs: {},
      // @ts-expect-error run must not return keys when outputs is empty.
      run: () => ({ summary: "not declared" }),
    });
  });

  test("workflow throws if run is missing at runtime", () => {
    assert.throws(
      () => workflow({ name: "broken", description: "", inputs: {}, outputs: {} } as never),
      { message: /run must be a function/ },
    );
  });

  test("workflow throws on empty name", () => {
    assert.throws(
      () => workflow({ name: "", description: "", inputs: {}, outputs: {}, run: () => ({}) }),
      { message: /name must be a non-empty string/ },
    );
  });

  test("definition is frozen", () => {
    const def = workflow({
      name: "frozen-test",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });

    assert.throws(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.name = "mutated";
    });
  });

  test("multiple inputs accumulate with inferred serializable input types", () => {
    const def = workflow({
      name: "multi-input",
      description: "",
      inputs: {
        a: Type.Optional(Type.String()),
        b: Type.Number({ default: 4 }),
      },
      outputs: {
        a: Type.String(),
        b: Type.Number(),
      },
      run: async (ctx) => {
        const a: string | undefined = ctx.inputs.a;
        const b: number = ctx.inputs.b;
        return { a: a ?? "", b };
      },
    });

    assert.deepEqual(Object.keys(def.inputs), ["a", "b"]);
    // A defaulted input is a required KEY at the type level (always present
    // after defaults are applied) but the picker/validation descriptor reports
    // required:false because the caller need not supply it.
    assert.deepEqual(deriveInputField("b", def.inputs["b"]), {
      name: "b",
      type: "number",
      required: false,
      default: 4,
    });
  });

  test("worktreeFromInputs stores workflow input bindings", () => {
    const def = workflow({
      name: "worktree-inputs",
      description: "",
      inputs: {
        git_worktree_dir: Type.String({ default: "" }),
        base_branch: Type.String({ default: "main" }),
      },
      outputs: {},
      worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" },
      run: async () => ({}),
    });

    assert.deepEqual(def.inputBindings?.worktree, {
      gitWorktreeDir: "git_worktree_dir",
      baseBranch: "base_branch",
    });
  });

  test("input() records immutable workflow input metadata", () => {
    const def = workflow({
      name: "child",
      description: "",
      inputs: {
        topic: Type.String({ description: "Topic" }),
      },
      outputs: {},
      run: async () => ({}),
    });

    assert.equal(Object.isFrozen(def.inputs), true);
    assert.deepEqual(deriveInputField("topic", def.inputs["topic"]), {
      name: "topic",
      type: "text",
      required: true,
      description: "Topic",
    });
  });

  test("output() records immutable workflow output metadata", () => {
    const def = workflow({
      name: "child",
      description: "",
      inputs: {},
      outputs: {
        summary: Type.String({ description: "Summary" }),
      },
      run: async () => ({ summary: "ok" }),
    });

    const summarySchema = def.outputs!["summary"];
    assert.equal(schemaFieldKind(summarySchema), "text");
    assert.equal(schemaIsRequired(summarySchema), true);
    assert.equal(schemaDescription(summarySchema), "Summary");
    assert.equal(Object.isFrozen(def.outputs), true);
  });
});
