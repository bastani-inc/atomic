import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { _getRequiredRequestAuth } from "../src/core/agent-session-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defaultModelPerProvider } from "../src/core/model-resolver-defaults.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

type ProviderCase = {
	provider: string;
	envVar: "BASETEN_API_KEY" | "QWEN_TOKEN_PLAN_API_KEY";
	defaultModel: string;
	modelIds: readonly string[];
	thinkingLevels: readonly string[];
};

const PROVIDERS: readonly ProviderCase[] = [
	{
		provider: "baseten",
		envVar: "BASETEN_API_KEY",
		defaultModel: "zai-org/GLM-5.2",
		modelIds: [
			"deepseek-ai/DeepSeek-V4-Flash-0731",
			"deepseek-ai/DeepSeek-V4-Pro",
			"moonshotai/Kimi-K2.5",
			"moonshotai/Kimi-K2.6",
			"moonshotai/Kimi-K2.7-Code",
			"moonshotai/Kimi-K3",
			"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
			"nvidia/Nemotron-120B-A12B",
			"openai/gpt-oss-120b",
			"thinkingmachines/inkling",
			"thinkingmachines/inkling-small",
			"zai-org/GLM-4.7",
			"zai-org/GLM-5",
			"zai-org/GLM-5.1",
			"zai-org/GLM-5.2",
			"zai-org/GLM-5.2-Fast",
		],
		thinkingLevels: ["off", "high", "max"],
	},
	{
		provider: "qwen-token-plan-individual",
		envVar: "QWEN_TOKEN_PLAN_API_KEY",
		defaultModel: "qwen3.8-max",
		modelIds: [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
		],
		thinkingLevels: ["off", "low", "medium", "xhigh"],
	},
];

const previousEnvironment = new Map<string, string | undefined>();

function setProviderEnvironment(envVar: ProviderCase["envVar"], value: string | undefined): void {
	if (!previousEnvironment.has(envVar)) previousEnvironment.set(envVar, process.env[envVar]);
	if (value === undefined) delete process.env[envVar];
	else process.env[envVar] = value;
}

function restoreProviderEnvironment(): void {
	for (const [envVar, value] of previousEnvironment) {
		if (value === undefined) delete process.env[envVar];
		else process.env[envVar] = value;
	}
	previousEnvironment.clear();
}

afterEach(() => {
	restoreProviderEnvironment();
});

async function createRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

function getProviderModel(runtime: ModelRuntime, provider: ProviderCase): Model<Api> {
	const model = runtime.getModel(provider.provider, provider.defaultModel);
	if (!model) throw new Error(`Missing ${provider.provider}/${provider.defaultModel} from the builtin catalog`);
	return model;
}

describe("Baseten and Qwen Token Plan Individual providers", () => {
	test.each(PROVIDERS)(
		"authenticates $provider from its environment variable and exposes its catalog",
		async (provider) => {
			setProviderEnvironment(provider.envVar, `test-${provider.provider}-key`);
			const runtime = await createRuntime();
			const model = getProviderModel(runtime, provider);
			const models = runtime.getModels().filter((candidate) => candidate.provider === provider.provider);

			assert.deepEqual(
				models.map((candidate) => candidate.id),
				provider.modelIds,
			);
			assert.equal(defaultModelPerProvider[provider.provider], provider.defaultModel);
			assert.ok(models.some((candidate) => isDeepStrictEqual(candidate, model)));
			assert.deepEqual(getSupportedThinkingLevels(model), provider.thinkingLevels);
			assert.equal(
				runtime.getProvider(provider.provider)?.name,
				provider.provider === "baseten" ? "Baseten" : "Qwen Token Plan Individual",
			);
			assert.deepEqual(runtime.getProviderAuthStatus(provider.provider), {
				configured: true,
				source: "environment",
				label: provider.envVar,
			});
			assert.equal((await runtime.getAuth(model))?.auth.apiKey, `test-${provider.provider}-key`);
		},
	);

	test.each(PROVIDERS)("is unavailable without $envVar and resolves no auth for $provider", async (provider) => {
		setProviderEnvironment(provider.envVar, undefined);
		const runtime = await createRuntime();
		const model = getProviderModel(runtime, provider);

		assert.deepEqual(runtime.getProviderAuthStatus(provider.provider), { configured: false });
		assert.equal(
			runtime.getAvailableSnapshot().some((candidate) => candidate.provider === provider.provider),
			false,
		);
		assert.equal(await runtime.getAuth(model), undefined);
		const session = { _modelRuntime: runtime } as AgentSessionInternalSurface;
		await assert.rejects(
			_getRequiredRequestAuth.call(session, model),
			new RegExp(`No API key found for ${provider.provider}\\.`, "u"),
		);
	});

	test.each(PROVIDERS)(
		"reports a provider-scoped error for malformed stored credentials: $provider",
		async (provider) => {
			setProviderEnvironment(provider.envVar, undefined);
			const malformedCredential = { type: "api_key", key: { malformed: true } } as never;
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ [provider.provider]: malformedCredential }),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const model = getProviderModel(runtime, provider);

			await assert.rejects(runtime.getAuth(model), new RegExp(`for ${provider.provider}`, "u"));
		},
	);
});
