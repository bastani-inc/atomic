import assert from "node:assert/strict";
import { test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";

const PROVIDER_ENVIRONMENT = {
	BASETEN_API_KEY: "workflow-baseten-test-key",
	QWEN_TOKEN_PLAN_API_KEY: "workflow-qwen-test-key",
} as const;

function restoreEnvironment(previous: Readonly<Record<keyof typeof PROVIDER_ENVIRONMENT, string | undefined>>): void {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("workflow models action reports Baseten and Qwen Individual thinking levels", async () => {
	const previous = Object.fromEntries(
		Object.keys(PROVIDER_ENVIRONMENT).map((name) => [name, process.env[name]]),
	) as Record<keyof typeof PROVIDER_ENVIRONMENT, string | undefined>;
	Object.assign(process.env, PROVIDER_ENVIRONMENT);

	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const current = runtime.getModel("baseten", "zai-org/GLM-5.2");
		assert.ok(current);
		const execute = makeExecuteWorkflowTool({} as ExtensionRuntime, () => undefined);
		const result = await execute({ action: "models" }, {
			model: current,
			modelRegistry: registry,
		} as PiExecuteContext);

		assert.equal(result.action, "models");
		if (result.action !== "models") return;
		const baseten = result.models.find((model) => model.fullId === "baseten/zai-org/GLM-5.2");
		const qwen = result.models.find((model) => model.fullId === "qwen-token-plan-individual/qwen3.8-max");
		assert.deepEqual(baseten?.availableThinkingLevels, ["off", "high", "max"]);
		assert.deepEqual(qwen?.availableThinkingLevels, ["off", "low", "medium", "xhigh"]);
		assert.equal(baseten?.isCurrent, true);
		assert.equal(qwen?.isCurrent, false);
	} finally {
		restoreEnvironment(previous);
	}
});
