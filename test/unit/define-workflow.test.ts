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

type ErrorConstructorWithPrepareStackTrace = typeof Error & {
  prepareStackTrace?: (error: Error, structuredStackTrace: readonly unknown[]) => string;
};

function withPreparedStack<T>(stack: string, fn: () => T): T {
  const errorConstructor = Error as ErrorConstructorWithPrepareStackTrace;
  const originalPrepareStackTrace = errorConstructor.prepareStackTrace;
  errorConstructor.prepareStackTrace = () => stack;
  try {
    return fn();
  } finally {
    errorConstructor.prepareStackTrace = originalPrepareStackTrace;
  }
}

function workflowFromStack(stack: string) {
  return withPreparedStack(stack, () => workflow({ description: "", outputs: {}, run: () => ({}) }));
}

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
        // @ts-expect-error ctx.inputs is closed over declared input schema keys.
        const _invalidInput = ctx.inputs.propmt;
        void _invalidInput;
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

  test("omitted inputs infer a closed empty input shape", () => {
    const def = workflow({
      name: "omitted-inputs",
      description: "",
      outputs: {},
      run: (ctx) => {
        // @ts-expect-error ctx.inputs is closed when inputs is omitted.
        const _extra: never = ctx.inputs.extra;
        void _extra;
        return {};
      },
    });

    assert.deepEqual(Object.keys(def.inputs), []);
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

  test("workflow validates spec field shapes at runtime", () => {
    assert.throws(
      () => workflow({ name: "bad-description", description: 42, outputs: {}, run: () => ({}) } as never),
      { message: /description must be a string/ },
    );

    for (const outputs of [undefined, null, [], "nope"] as readonly unknown[]) {
      assert.throws(
        () => workflow({ name: "bad-outputs", description: "", outputs, run: () => ({}) } as never),
        { message: /outputs must be a schema map/ },
      );
    }

    for (const inputs of [null, [], "nope"] as readonly unknown[]) {
      assert.throws(
        () => workflow({ name: "bad-inputs", description: "", inputs, outputs: {}, run: () => ({}) } as never),
        { message: /inputs must be a schema map/ },
      );
    }
  });

  test("infers omitted workflow names from caller filenames", () => {
    const def = workflow({ description: "", outputs: {}, run: () => ({}) });

    assert.equal(def.name, "define-workflow.test");
    assert.equal(def.normalizedName, "define-workflowtest");
  });

  test("infers omitted workflow names across installed and extension layouts", () => {
    const implementationFrames = [
      "/workspace/app/node_modules/@bastani/workflows/authoring/workflow.ts",
      "/Users/test/.atomic/agent/extensions/workflows/authoring/workflow.ts",
      "/Users/test/.pi/agent/extensions/workflows/authoring/workflow.ts",
      "/Users/test/.bun/install/global/node_modules/@bastani/atomic/dist/builtin/workflows/authoring/workflow.ts",
    ];

    for (const [index, implementationFrame] of implementationFrames.entries()) {
      const def = workflowFromStack(`Error\n    at workflow (${implementationFrame}:10:2)\n    at Object.<anonymous> (/tmp/custom-flow-${index}.ts:5:1)`);
      assert.equal(def.name, `custom-flow-${index}`);
    }
  });

  test("infers omitted workflow names from file URL and Windows stack paths", () => {
    const fileUrlDef = workflowFromStack("Error\n    at workflow (file:///tmp/project/node_modules/@bastani/workflows/authoring/workflow.ts:10:2)\n    at Object.<anonymous> (file:///tmp/project/file-url-flow.ts:5:1)");
    assert.equal(fileUrlDef.name, "file-url-flow");

    const windowsDef = workflowFromStack("Error\n    at workflow (C:\\Users\\test\\.pi\\agent\\extensions\\workflows\\authoring\\workflow.ts:10:2)\n    at Object.<anonymous> (C:\\Users\\test\\project\\windows-flow.ts:5:1)");
    assert.equal(windowsDef.name, "windows-flow");
  });

  test("workflow throws when omitted name cannot be inferred", () => {
    assert.throws(
      () => workflowFromStack("Error\n    at workflow (/tmp/app/node_modules/@bastani/workflows/authoring/workflow.ts:10:2)\n    at resolveWorkflowName (/tmp/app/node_modules/@bastani/workflows/authoring/workflow.ts:9:2)"),
      { message: /name must be provided when caller filename cannot be inferred/ },
    );
  });

  test("workflow throws on empty name", () => {
    assert.throws(
      () => workflow({ name: "", description: "", inputs: {}, outputs: {}, run: () => ({}) }),
      { message: /name must be a non-empty string/ },
    );
  });

  test("workflow throws when explicit name normalizes to empty", () => {
    assert.throws(
      () => workflow({ name: "!!!", description: "", inputs: {}, outputs: {}, run: () => ({}) }),
      { message: /normalized name must be a non-empty string/ },
    );
  });

  test("workflow throws when explicit punctuation name normalizes to empty", () => {
    assert.throws(
      () => workflow({ name: " - !!! - ", description: "", inputs: {}, outputs: {}, run: () => ({}) }),
      { message: /normalized name must be a non-empty string/ },
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
    const defaultedNumber = Type.Number({ default: 4 });
    const def = workflow({
      name: "multi-input",
      description: "",
      inputs: {
        a: Type.Optional(Type.String()),
        b: defaultedNumber,
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
    assert.equal(def.inputs["b"], defaultedNumber);
    assert.deepEqual(defaultedNumber, Type.Number({ default: 4 }));
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
    assert.equal(Object.isFrozen(def.inputBindings?.worktree), true);
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

    const summarySchema = def.outputs["summary"];
    assert.equal(schemaFieldKind(summarySchema), "text");
    assert.equal(schemaIsRequired(summarySchema), true);
    assert.equal(schemaDescription(summarySchema), "Summary");
    assert.equal(Object.isFrozen(def.outputs), true);
  });
});
