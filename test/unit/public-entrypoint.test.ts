import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as workflows from "../../packages/workflows/src/index.js";
import {
  GraphFrontierTracker,
  createRegistry,
  defineWorkflow,
  normalizeWorkflowName,
  resolveInputs,
  Type,
  workflowNamesEqual,
} from "../../packages/workflows/src/index.js";

describe("public entrypoint", () => {
  test("exports removed runWorkflow as a throwing migration stub", () => {
    assert.equal("runWorkflow" in workflows, true);
    assert.throws(
      () => (workflows.runWorkflow as () => never)(),
      /@bastani\/workflows no longer exports runWorkflow; author workflows with defineWorkflow\(\.\.\.\)\.compile\(\)/,
    );
    assert.equal("WorkflowOptions" in workflows, false);
    assert.equal("WorkflowRunOptions" in workflows, false);
  });

  test("supports authoring and registry lookup through exported APIs", async () => {
    const workflow = defineWorkflow("Example Task")
      .description("Exercises the package entrypoint")
      .input("prompt", Type.String())
      .output("echoed", Type.String())
      .run(async (ctx) => ({ echoed: ctx.inputs.prompt }))
      .compile();

    const registry = createRegistry().register(workflow as unknown as Parameters<ReturnType<typeof createRegistry>["register"]>[0]);

    assert.equal(normalizeWorkflowName(" Example_Task! "), "example-task");
    assert.equal(workflowNamesEqual("Example Task", "example_task"), true);
    assert.equal(registry.has("example task"), true);
    assert.equal(registry.get("example-task"), workflow);
    assert.deepEqual(await workflow.run({ inputs: { prompt: "hello" } } as Parameters<typeof workflow.run>[0]), { echoed: "hello" });
  });

  test("exposes runtime helpers with observable edge-case behavior", () => {
    assert.throws(
      () => resolveInputs({ prompt: Type.String() }, {}),
      { message: 'atomic-workflows: required input "prompt" not provided' },
    );

    const tracker = new GraphFrontierTracker();
    assert.deepEqual(tracker.onSpawn("stage-1", "first"), []);
    tracker.onSettle("stage-1");
    assert.deepEqual(tracker.onSpawn("stage-2", "second"), ["stage-1"]);
  });
});
