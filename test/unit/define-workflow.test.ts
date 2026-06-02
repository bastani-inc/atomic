import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";

describe("defineWorkflow builder", () => {
  test("compiles a valid workflow definition", () => {
    const def = defineWorkflow("my-workflow")
      .description("test workflow")
      .input("prompt", { type: "text", required: true, description: "task" })
      .run(async (ctx) => {
        const prompt: string = ctx.inputs.prompt;
        const result = await ctx.stage("step1").prompt(prompt);
        return { result };
      })
      .compile();

    assert.equal(def.__piWorkflow, true);
    assert.equal(def.name, "my-workflow");
    assert.equal(def.description, "test workflow");
    assert.deepEqual(def.inputs["prompt"], { type: "text", required: true, description: "task" });
    assert.equal(typeof def.run, "function");
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
      .input("a", { type: "text" })
      .input("b", { type: "number", default: 4 })
      .run(async (ctx) => {
        const a: string | undefined = ctx.inputs.a;
        const b: number = ctx.inputs.b;
        return { a: a ?? "", b };
      })
      .compile();

    assert.deepEqual(Object.keys(def.inputs), ["a", "b"]);
    assert.deepEqual(def.inputs["b"], { type: "number", default: 4 });
  });

  test("worktreeFromInputs stores workflow input bindings", () => {
    const def = defineWorkflow("worktree-inputs")
      .input("git_worktree_dir", { type: "string", default: "" })
      .input("base_branch", { type: "string", default: "main" })
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
      .input("topic", { type: "text", required: true, description: "Topic" })
      .run(async () => ({}))
      .compile();

    assert.equal(Object.isFrozen(def.inputs), true);
    assert.equal(Object.isFrozen(def.inputs["topic"]), true);
  });

  test("output() records immutable workflow output metadata", () => {
    const def = defineWorkflow("child")
      .output("summary", { type: "text", required: true, description: "Summary" })
      .run(async () => ({ summary: "ok" }))
      .compile();

    assert.deepEqual(def.outputs?.["summary"], {
      type: "text",
      required: true,
      description: "Summary",
    });
    assert.equal(Object.isFrozen(def.outputs), true);
    assert.equal(Object.isFrozen(def.outputs?.["summary"]), true);
  });
});
