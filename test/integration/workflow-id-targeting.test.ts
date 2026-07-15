import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";

const config: WorkflowRuntimeConfig = {
  maxDepth: 4,
  defaultConcurrency: 1,
  persistRuns: false,
  statusFile: false,
  resumeInFlight: "never",
};

beforeEach(() => store.clear());
afterEach(() => store.clear());

test("displayed Workflow run and stage ID prefixes are actionable through the public tool", async () => {
  const fixture = workflow({
    name: "actionable-id-proof",
    description: "Deterministic workflow identifier proof.",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      const stage = await ctx.task("deterministic-stage", { prompt: "return proof" });
      return { result: stage.text };
    },
  });
  const completed = await run(fixture, {}, {
    adapters: { prompt: { prompt: async () => "proof" } },
    config,
    store,
  });
  assert.equal(completed.status, "completed");
  const stageId = completed.stages[0]?.id;
  assert.ok(stageId);

  const runtime = createExtensionRuntime({ registry: createRegistry([]) });
  const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);
  const listed = await execute({ action: "status" }, {} as never);
  const rendered = renderResult(listed, { plain: true });
  const runMatch = rendered.match(new RegExp(`\\b(${completed.runId.slice(0, 6)})\\b`));
  assert.ok(runMatch, "status should render the actionable run ID prefix");
  const displayedRunId = runMatch[1]!;

  const status = await execute({ action: "status", runId: displayedRunId }, {} as never);
  assert.equal(status.action, "statusDetail");
  assert.equal(status.runId, completed.runId);

  const stages = await execute({
    action: "stages",
    runId: displayedRunId,
    statusFilter: "all",
  }, {} as never);
  assert.equal(stages.action, "stages");
  const renderedStages = renderResult(stages, { plain: true, width: 200 });
  const stageMatch = renderedStages.match(/deterministic-stage \(([^)]+)\)/);
  assert.ok(stageMatch, "stages should render the actionable stage ID prefix");
  const displayedStageId = stageMatch[1]!;
  assert.equal(displayedStageId, stageId.slice(0, 12));
  const stage = await execute({
    action: "stage",
    runId: displayedRunId,
    stageId: displayedStageId,
  }, {} as never);
  assert.equal(stage.action, "stage");
  assert.equal(stage.runId, completed.runId);
  assert.equal(stage.action === "stage" ? stage.stage?.id : undefined, stageId);
});
