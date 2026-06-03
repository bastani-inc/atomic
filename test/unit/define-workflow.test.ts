import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
import {
  deriveInputField,
  schemaDescription,
  schemaFieldKind,
  schemaIsRequired,
} from "../../packages/workflows/src/shared/schema-introspection.js";

describe("defineWorkflow builder", () => {
  test("compiles a valid workflow definition", () => {
    const def = defineWorkflow("my-workflow")
      .description("test workflow")
      .input("prompt", Type.String({ description: "task" }))
      .output("result", Type.String())
      .run(async (ctx) => {
        const prompt: string = ctx.inputs.prompt;
        const result = await ctx.stage("step1").prompt(prompt);
        return { result };
      })
      .compile();

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
    defineWorkflow("strict-output-contract")
      .output("summary", Type.String())
      // @ts-expect-error run outputs must be declared on the runtime source surface.
      .run(() => ({ summary: "ok", extra: "not declared" }))
      .compile();
  });

  test("rejects outputs when no output contract is declared", () => {
    defineWorkflow("strict-no-output-contract")
      // @ts-expect-error workflows with no .output(...) declarations must return no outputs.
      .run(() => ({ summary: "not declared" }))
      .compile();
  });

  test("compile throws if .run() not called", () => {
    assert.throws(() =>
      (defineWorkflow("broken") as unknown as ReturnType<typeof defineWorkflow> & { compile(): unknown }).compile(), { message: /\.run\(fn\) must be called before \.compile\(\)/ });
  });

  test("defineWorkflow throws on empty name", () => {
    assert.throws(() => defineWorkflow(""), { message: /name must be a non-empty string/ });
  });

  test("definition is frozen", () => {
    const def = defineWorkflow("frozen-test")
      .run(async () => ({}))
      .compile();

    assert.throws(() => {
      // @ts-expect-error intentionally mutating frozen object
      def.name = "mutated";
    });
  });

  test("multiple inputs accumulate with inferred serializable input types", () => {
    const def = defineWorkflow("multi-input")
      .input("a", Type.Optional(Type.String()))
      .input("b", Type.Number({ default: 4 }))
      .output("a", Type.String())
      .output("b", Type.Number())
      .run(async (ctx) => {
        const a: string | undefined = ctx.inputs.a;
        const b: number = ctx.inputs.b;
        return { a: a ?? "", b };
      })
      .compile();

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
    const def = defineWorkflow("worktree-inputs")
      .input("git_worktree_dir", Type.String({ default: "" }))
      .input("base_branch", Type.String({ default: "main" }))
      .worktreeFromInputs({ gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" })
      .run(async () => ({}))
      .compile();

    assert.deepEqual(def.inputBindings?.worktree, {
      gitWorktreeDir: "git_worktree_dir",
      baseBranch: "base_branch",
    });
  });

  test("input() records immutable workflow input metadata", () => {
    const def = defineWorkflow("child")
      .input("topic", Type.String({ description: "Topic" }))
      .run(async () => ({}))
      .compile();

    assert.equal(Object.isFrozen(def.inputs), true);
    assert.deepEqual(deriveInputField("topic", def.inputs["topic"]), {
      name: "topic",
      type: "text",
      required: true,
      description: "Topic",
    });
  });

  test("output() records immutable workflow output metadata", () => {
    const def = defineWorkflow("child")
      .output("summary", Type.String({ description: "Summary" }))
      .run(async () => ({ summary: "ok" }))
      .compile();

    const summarySchema = def.outputs!["summary"];
    assert.equal(schemaFieldKind(summarySchema), "text");
    assert.equal(schemaIsRequired(summarySchema), true);
    assert.equal(schemaDescription(summarySchema), "Summary");
    assert.equal(Object.isFrozen(def.outputs), true);
  });
});
