import assert from "node:assert/strict";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

test("workflow models action lists the host model registry catalog", async () => {
	const previousGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	try {
		const current = model("provider-a", "current");
		const alternate = model("provider-b", "alternate");
		const execute = makeExecuteWorkflowTool({} as ExtensionRuntime, () => undefined);
		const context = {
			model: current,
			modelRegistry: { getAvailable: () => [current, alternate] },
		} as unknown as PiExecuteContext;

		const result = await execute({ action: "models" }, context);

		assert.equal(result.action, "models");
		if (result.action !== "models") return;
		assert.deepEqual(
			result.models.map(({ fullId }) => fullId),
			["provider-a/current", "provider-b/alternate"],
		);
		assert.deepEqual(
			result.models.map(({ isCurrent }) => isCurrent),
			[true, false],
		);
	} finally {
		if (previousGuard === undefined) delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		else process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
	}
});

test("workflow stage model catalog includes alternatives beyond the current model", async () => {
	const current = model("provider-a", "current");
	const alternate = model("provider-b", "alternate");
	const catalog = workflowModelCatalogFromContext({
		model: current,
		modelRegistry: { getAvailable: () => [current, alternate] },
	});

	assert.ok(catalog);
	const available = await catalog.listModels();
	assert.deepEqual(
		available.map(({ fullId }) => fullId),
		["provider-a/current", "provider-b/alternate"],
	);
	assert.equal(catalog.currentModel, current);
});
