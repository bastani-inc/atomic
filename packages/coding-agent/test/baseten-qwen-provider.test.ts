import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@bastani/pi-ai";
import { getSupportedThinkingLevels } from "@bastani/pi-ai/compat";
import { getBuiltinModels } from "@bastani/pi-ai/providers/all";
import { afterEach, describe, test, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { _getRequiredRequestAuth } from "../src/core/agent-session-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defaultModelPerProvider } from "../src/core/model-resolver-defaults.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.ts";
import { getBuiltinApiKeyLoginOptions } from "../src/modes/interactive/interactive-auth-routing.ts";

type ProviderCase = {
	provider: "baseten" | "qwen-token-plan-individual";
	envVar: "BASETEN_API_KEY" | "QWEN_TOKEN_PLAN_API_KEY";
	defaultModel: string;
	modelIds: readonly string[];
	thinkingLevels: readonly string[];
};

const PROVIDERS: readonly ProviderCase[] = [
	{
		provider: "baseten",
		envVar: "BASETEN_API_KEY",
		defaultModel: "zai-org/GLM-5.3",
		modelIds: [
			"deepseek-ai/DeepSeek-V4-Flash-0731",
			"deepseek-ai/DeepSeek-V4-Pro-0813",
			"deepseek-ai/DeepSeek-V4.1-Flash",
			"deepseek-ai/DeepSeek-V4.1-Flash-1017",
			"deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast",
			"deepseek-ai/DeepSeek-V4.1-Flash-Fast",
			"moonshotai/Kimi-K3",
			"moonshotai/Kimi-K3.1-Pro",
			"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
			"openai/gpt-oss-120b",
			"zai-org/GLM-5.2",
			"zai-org/GLM-5.2-Fast",
			"zai-org/GLM-5.3",
			"zai-org/GLM-5.3-Fast",
			"zai-org/GLM-5.3-Flash",
		],
		thinkingLevels: ["low", "high", "max"],
	},
	{
		provider: "qwen-token-plan-individual",
		envVar: "QWEN_TOKEN_PLAN_API_KEY",
		defaultModel: "qwen3.8-max",
		modelIds: [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"deepseek-v4.1-flash",
			"deepseek-v4.1-flash-1017",
			"glm-5.2",
			"glm-5.3",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
		],
		thinkingLevels: ["low", "medium", "xhigh"],
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

			const runtimeIds = models.map((candidate) => candidate.id);
			const builtinIds = getBuiltinModels(provider.provider).map((candidate) => candidate.id);
			assert.deepEqual([...runtimeIds].sort(), [...builtinIds].sort());
			for (const pinnedId of provider.modelIds) {
				assert.ok(runtimeIds.includes(pinnedId), `${provider.provider} should include ${pinnedId}`);
			}
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

	test("names each Qwen Token Plan Individual region in the API-key login options", () => {
		const options = getBuiltinApiKeyLoginOptions((id) => BUILT_IN_PROVIDER_DISPLAY_NAMES[id] ?? id);
		const names = new Map(options.map((option) => [option.id, option.name]));

		assert.equal(names.get("qwen-token-plan"), "Qwen Token Plan (Team)");
		assert.equal(names.get("qwen-token-plan-cn"), "Qwen Token Plan (Team, China)");
		assert.equal(names.get("qwen-token-plan-individual"), "Qwen Token Plan (Individual)");
		assert.equal(names.get("qwen-token-plan-individual-cn"), "Qwen Token Plan (Individual, China)");
	});

	test("lists per-plan Qwen Token Plan key variables in CLI help (#11773)", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = log.mock.calls.flat().join("\n");
			assert.equal(help.includes("QWEN_TOKEN_PLAN_TEAM_API_KEY"), true);
			assert.equal(help.includes("QWEN_TOKEN_PLAN_TEAM_CN_API_KEY"), true);
			assert.equal(help.includes("QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY"), true);
			assert.equal(help.includes("QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY"), true);
			assert.equal(help.includes("QWEN_TOKEN_PLAN_API_KEY "), false);
			assert.equal(help.includes("QWEN_TOKEN_PLAN_CN_API_KEY "), false);
		} finally {
			log.mockRestore();
		}
	});
});
