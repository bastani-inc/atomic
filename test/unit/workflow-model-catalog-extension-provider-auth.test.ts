import assert from "node:assert/strict";
import type { OAuthCredential } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";

const BUILTIN_KEY = "groq";
const EXTENSION_KEY = "corp-key";
const BUILTIN_OAUTH = "anthropic";
const EXTENSION_OAUTH = "corp-oauth";

afterEach(() => {
	vi.unstubAllEnvs();
});

function storedLogin(): OAuthCredential {
	return { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 60 * 60 * 1000 };
}

/** The providers whose models `workflow({ action: "models" })` lists in its configured-auth snapshot. */
async function catalogProviders(options: { apiKeyEnv: string; storedOAuth: boolean }): Promise<string[]> {
	vi.stubEnv("GROQ_API_KEY", options.apiKeyEnv);
	vi.stubEnv("CORP_KEY_API_KEY", options.apiKeyEnv);
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
	const credentials = AuthStorage.inMemory();
	if (options.storedOAuth) {
		for (const provider of [BUILTIN_OAUTH, EXTENSION_OAUTH])
			await credentials.modify(provider, async () => storedLogin());
	}
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	const template = runtime.getModels(BUILTIN_KEY)[0];
	assert.ok(template);
	runtime.registerProvider(EXTENSION_KEY, {
		baseUrl: "https://corp.example.test/v1",
		api: template.api,
		apiKey: "$CORP_KEY_API_KEY",
		models: [{ ...template, id: "corp-key-model", name: "Corp Key Model" }],
	});
	runtime.registerProvider(EXTENSION_OAUTH, {
		baseUrl: "https://corp.example.test/v1",
		api: template.api,
		oauth: {
			name: "Corp OAuth",
			login: async () => storedLogin(),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
		models: [{ ...template, id: "corp-oauth-model", name: "Corp OAuth Model" }],
	});
	await runtime.getAvailable();

	const execute = makeExecuteWorkflowTool({} as ExtensionRuntime, () => undefined);
	const result = await execute({ action: "models" }, {
		modelRegistry: new ModelRegistry(runtime),
	} as PiExecuteContext);
	assert.equal(result.action, "models");
	if (result.action !== "models") return [];
	const listed = new Set(result.models.map((model) => model.provider));
	return [BUILTIN_KEY, EXTENSION_KEY, BUILTIN_OAUTH, EXTENSION_OAUTH].filter((provider) => listed.has(provider));
}

test("workflow models lists extension providers by configured auth like built-in providers", async () => {
	assert.deepEqual(await catalogProviders({ apiKeyEnv: "fake-env-key", storedOAuth: false }), [
		BUILTIN_KEY,
		EXTENSION_KEY,
	]);
	assert.deepEqual(await catalogProviders({ apiKeyEnv: "", storedOAuth: true }), [BUILTIN_OAUTH, EXTENSION_OAUTH]);
});
