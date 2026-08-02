import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

const config: WorkflowRuntimeConfig = {
	maxDepth: 4,
	defaultConcurrency: 1,
	persistRuns: false,
	statusFile: false,
	resumeInFlight: "never",
};

beforeEach(() => store.clear());
afterEach(() => store.clear());

test("displayed Workflow run and stage IDs remain full while typed prefixes stay actionable through the public tool", async () => {
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
	const completed = await run(
		fixture,
		{},
		{
			adapters: { prompt: { prompt: async () => "proof" } },
			config,
			store,
		},
	);
	assert.equal(completed.status, "completed");
	const stageId = completed.stages[0]?.id;
	assert.ok(stageId);

	const runtime = createExtensionRuntime({ registry: createRegistry([]) });
	const execute = makeExecuteWorkflowTool(runtime, () => undefined);
	const listed = await execute({ action: "status" }, {} as never);
	const rendered = renderResult(listed, { plain: true });
	assert.ok(rendered.includes(completed.runId), `status should render the full run ID; output:\n${rendered}`);
	// The contract is a round trip: the id the UI prints is exactly the id the
	// tool accepts back. Nothing shorter is a valid target any more.
	const displayedRunId = completed.runId;

	const status = await execute({ action: "status", runId: displayedRunId }, {} as never);
	assert.equal(status.action, "statusDetail");
	assert.equal(status.runId, completed.runId);

	const truncatedRun = await execute({ action: "status", runId: completed.runId.slice(0, 6) }, {} as never);
	assert.equal(truncatedRun.action, "statusDetail");
	assert.ok(
		"error" in truncatedRun,
		"a truncated run id must fail rather than return run detail for the run it prefixes",
	);
	assert.match(
		"error" in truncatedRun ? truncatedRun.error : "",
		/must be a full 36-character UUID/,
		"a truncated run id must be rejected as malformed rather than resolved by prefix",
	);

	const stages = await execute(
		{
			action: "stages",
			runId: displayedRunId,
			statusFilter: "all",
		},
		{} as never,
	);
	assert.equal(stages.action, "stages");
	const renderedStages = renderResult(stages, { plain: true, width: 200 });
	const stageMatch = renderedStages.match(/deterministic-stage [(]([^)]+)[)]/);
	assert.ok(stageMatch, "stages should render the full stage ID");
	const displayedStageId = stageMatch[1]!;
	assert.equal(displayedStageId, stageId);
	const stage = await execute(
		{
			action: "stage",
			runId: displayedRunId,
			stageId: displayedStageId,
		},
		{} as never,
	);
	assert.equal(stage.action, "stage");
	assert.equal(stage.runId, completed.runId);
	assert.equal(stage.action === "stage" ? stage.stage?.id : undefined, stageId);

	const truncatedStage = await execute(
		{
			action: "stage",
			runId: displayedRunId,
			stageId: stageId.slice(0, 12),
		},
		{} as never,
	);
	assert.equal(truncatedStage.action, "stage");
	assert.equal(
		truncatedStage.action === "stage" ? truncatedStage.stage : undefined,
		undefined,
		"a truncated stage id must not resolve to the stage it prefixes",
	);
});
