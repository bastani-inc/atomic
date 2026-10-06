import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

test("run() executes a ctx.task stage without RunOpts.adapters (#3472)", async () => {
	const cwd = makeTempDirectory("atomic-sdk-run-default-adapter-");
	const faux = registerFauxProvider();
	try {
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage("stage reply from the default adapter")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				cost: registered.cost,
			})),
		});
		let sessionFile: string | undefined = "unset";
		const def = workflow({
			name: "sdk-run-default-adapter",
			description: "One task stage with no caller-supplied adapters.",
			inputs: {},
			outputs: { reply: Type.String() },
			run: async (ctx) => {
				const result = await ctx.task("reply", {
					prompt: "say hello",
					model,
					modelRuntime,
					agentDir: join(cwd, "agent"),
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
					builtins: BUILTINS,
					tools: [],
				});
				sessionFile = result.sessionFile;
				return { reply: result.text };
			},
		});

		const result = await run(def, {}, { cwd, durability: { mode: "memory" } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { reply: "stage reply from the default adapter" });
		assert.equal(faux.state.callCount, 1);
		assert.equal(sessionFile, undefined, "the default stage session must not persist to disk");
	} finally {
		faux.unregister();
		removeTempDirectory(cwd);
	}
});
