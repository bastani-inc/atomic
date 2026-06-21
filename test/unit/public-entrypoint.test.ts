import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as workflows from "../../packages/workflows/src/index.js";
import { Type } from "typebox";
import {
  GraphFrontierTracker,
  createRegistry,
  workflow,
  normalizeWorkflowName,
  resolveInputs,
  workflowNamesEqual,
} from "../../packages/workflows/src/index.js";

describe("public entrypoint", () => {
  test("exports removed runWorkflow as a throwing migration stub", () => {
    assert.equal("runWorkflow" in workflows, true);
    assert.throws(
      () => (workflows.runWorkflow as () => never)(),
      /@bastani\/workflows no longer exports runWorkflow; author workflows with workflow\(\{\.\.\.\}\)/,
    );
    assert.equal("WorkflowOptions" in workflows, false);
    assert.equal("WorkflowRunOptions" in workflows, false);
  });

  test("supports authoring and registry lookup through exported APIs", async () => {
    const def = workflow({
      name: "Example Task",
      description: "Exercises the package entrypoint",
      inputs: {
        prompt: Type.String(),
      },
      outputs: {
        echoed: Type.String(),
      },
      run: async (ctx) => ({ echoed: ctx.inputs.prompt }),
    });

    const registry = createRegistry().register(def);

    assert.equal(normalizeWorkflowName(" Example_Task! "), "example-task");
    assert.equal(workflowNamesEqual("Example Task", "example_task"), true);
    assert.equal(registry.has("example task"), true);
    assert.equal(registry.get("example-task"), def);
    assert.deepEqual(await def.run({ inputs: { prompt: "hello" } } as Parameters<typeof def.run>[0]), { echoed: "hello" });
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
