import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveCandidateModel } from "../../subagents/src/shared/model-resolution.js";
import { buildRuntimeAdapters } from "../../workflows/src/extension/wiring.js";
import type { StageSessionCreateResult } from "../../workflows/src/runs/foreground/stage-runner.js";
import { AuthStorage, ReadOnlyAuthStorage, readStoredCredential } from "../src/core/auth-storage.js";
import { normalizeAzureSettings } from "../src/core/azure-provider-compat.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resolveCliModel } from "../src/core/model-resolver-cli.js";
import { findInitialModel, resolveRestoredModelReference } from "../src/core/model-resolver-initial.js";
import { resolveModelScopeFromModels } from "../src/core/model-resolver-scope.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const legacy = "azure-openai-responses";

test("Azure settings normalization preserves invalid shapes for settings validation", () => {
	for (const invalid of [null, false, 7, "not-an-array", {}, [7], [null]]) {
		const settings = {
			defaultProvider: legacy,
			routerModel: typeof invalid === "string" ? 7 : invalid,
			enabledModels: invalid,
			fallbackModels: invalid,
			modelRouting: { allowedProviders: invalid, excludedProviders: invalid },
		};
		assert.deepEqual(normalizeAzureSettings(settings as never), { ...settings, defaultProvider: "azure" });
	}
});

test("saving legacy Azure credentials publishes canonical auth and available models immediately", async () => {
	for (const refreshCatalog of [false, true]) {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		await runtime.saveCredential(legacy, { type: "api_key", key: "saved-key" }, { refreshCatalog });
		assert.deepEqual(await runtime.listCredentials(), [{ providerId: "azure", type: "api_key" }]);
		for (const provider of [legacy, "azure"]) {
			assert.equal(runtime.hasConfiguredAuth(provider), true);
			assert.equal(runtime.getStoredCredentialType(provider), "api_key");
			assert.equal(runtime.getCredentialSnapshot(provider)?.type, "api_key");
			assert.deepEqual(runtime.getProviderAuthStatus(provider), { configured: true, source: "stored" });
			assert.equal((await runtime.getAuth(provider))?.auth.apiKey, "saved-key");
			assert.equal(
				await resolveRestoredModelReference(provider, "gpt-5.4", runtime),
				runtime.getModel("azure", "gpt-5.4"),
			);
		}
		assert.ok(runtime.getAvailableSnapshot().some((model) => model.provider === "azure"));
		assert.ok(runtime.getAvailableSnapshot().every((model) => model.provider !== legacy));
	}
});

test("legacy Azure login publishes auth and logout clears the canonical snapshot", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.login(legacy, "api_key", {
		signal: new AbortController().signal,
		prompt: async () => "login-key",
		notify: () => {},
	});
	for (const provider of [legacy, "azure"]) {
		assert.equal(runtime.hasConfiguredAuth(provider), true);
		assert.equal(runtime.getStoredCredentialType(provider), "api_key");
		assert.equal((await runtime.getAuth(provider))?.auth.apiKey, "login-key");
	}
	assert.ok(runtime.getAvailableSnapshot().some((model) => model.provider === "azure"));
	await runtime.logout(legacy);
	for (const provider of [legacy, "azure"]) {
		assert.equal(runtime.hasConfiguredAuth(provider), false);
		assert.equal(runtime.getStoredCredentialType(provider), undefined);
		assert.equal(await runtime.getAuth(provider), undefined);
	}
	assert.deepEqual(await runtime.listCredentials(), []);
	assert.ok(runtime.getAvailableSnapshot().every((model) => model.provider !== "azure"));
});

test("legacy Azure runtime keys configure canonical models and can clear canonical overrides", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const setter of [legacy, "azure"]) {
		await runtime.setRuntimeApiKey(setter, "runtime-key", {});
		for (const provider of [legacy, "azure"]) {
			assert.equal(runtime.hasConfiguredAuth(provider), true);
			assert.deepEqual(runtime.getProviderAuthStatus(provider), { configured: true, source: "runtime" });
			assert.equal((await runtime.getAuth(provider))?.auth.apiKey, "runtime-key");
		}
		assert.ok(runtime.getAvailableSnapshot().some((model) => model.provider === "azure"));
		assert.deepEqual(await runtime.listCredentials(), [{ providerId: "azure", type: "api_key" }]);
		await runtime.removeRuntimeApiKey(legacy);
		for (const provider of [legacy, "azure"]) {
			assert.equal(runtime.hasConfiguredAuth(provider), false);
			assert.equal(await runtime.getAuth(provider), undefined);
		}
		assert.deepEqual(await runtime.listCredentials(), []);
		assert.ok(runtime.getAvailableSnapshot().every((model) => model.provider !== "azure"));
	}
});

test("legacy Azure external auth updates clear canonical snapshots and retain authoritative status", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.saveCredential("azure", { type: "api_key", key: "saved-key" }, { refreshCatalog: false });
	runtime.applyExternalProviderAuthStatus(legacy, { configured: false });
	for (const provider of [legacy, "azure"]) {
		assert.equal(runtime.hasConfiguredAuth(provider), false);
		assert.equal(runtime.getStoredCredentialType(provider), undefined);
		assert.deepEqual(runtime.getProviderAuthStatus(provider), { configured: false });
	}
	assert.ok(runtime.getAvailableSnapshot().every((model) => model.provider !== "azure"));
	runtime.applyExternalProviderAuthStatus(legacy, {
		configured: true,
		source: "environment",
		label: "Azure environment",
	});
	for (const provider of [legacy, "azure"]) {
		assert.equal(runtime.hasConfiguredAuth(provider), true);
		assert.deepEqual(runtime.getProviderAuthStatus(provider), {
			configured: true,
			source: "environment",
			label: "Azure environment",
		});
	}
});

test("legacy Azure thinking setters publish canonical entries readable through both spellings", () => {
	const settings = SettingsManager.inMemory();
	settings.setModelThinkingLevel(legacy, "gpt-5.4", "high");
	for (const provider of [legacy, "azure"]) assert.equal(settings.getModelThinkingLevel(provider, "gpt-5.4"), "high");
	assert.deepEqual(settings.getAllModelThinkingLevels(), { "azure/gpt-5.4": "high" });
});

test("legacy Azure thinking removals clear entries normalized while loading settings", () => {
	for (const storedProvider of [legacy, "azure"]) {
		const settings = SettingsManager.inMemory({ modelThinkingLevels: { [`${storedProvider}/gpt-5.4`]: "high" } });
		assert.deepEqual(settings.getAllModelThinkingLevels(), { "azure/gpt-5.4": "high" });
		settings.removeModelThinkingLevel(legacy, "gpt-5.4");
		for (const provider of [legacy, "azure"])
			assert.equal(settings.getModelThinkingLevel(provider, "gpt-5.4"), undefined);
		assert.deepEqual(settings.getAllModelThinkingLevels(), {});
	}
});

test("legacy Azure references resolve canonically for CLI, restored sessions and extension registries", async () => {
	const credentials = AuthStorage.inMemory({ [legacy]: { type: "api_key", key: "legacy-key" } });
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	const model = runtime.getModel(legacy, "gpt-5.4");
	assert.equal(model?.provider, "azure");
	assert.equal(runtime.getProvider(legacy)?.id, "azure");
	assert.equal(runtime.hasConfiguredAuth(legacy), true);
	assert.equal(runtime.getCredentialSnapshot(legacy)?.type, "api_key");
	assert.equal((await runtime.getAuth(legacy))?.auth.apiKey, "legacy-key");
	assert.equal(new ModelRegistry(runtime).find(legacy, "gpt-5.4"), model);
	assert.equal(await resolveRestoredModelReference(legacy, "gpt-5.4", runtime), model);
	const candidate = resolveCandidateModel(`${legacy}/gpt-5.4:high`, new ModelRegistry(runtime));
	assert.equal(candidate?.model, model);
	assert.equal(candidate?.thinkingLevel, "high");
	for (const cli of [
		{ cliProvider: legacy, cliModel: "gpt-5.4" },
		{ cliModel: `${legacy}/gpt-5.4:high` },
		{ cliProvider: legacy, cliModel: `${legacy}/gpt-5.4` },
	]) {
		const result = resolveCliModel({ ...cli, modelRuntime: runtime });
		assert.equal(result.error, undefined);
		assert.equal(result.model, model);
	}
	const scope = resolveModelScopeFromModels([`${legacy}/gpt-5.4:low`, `${legacy}/gpt-5.*`], runtime.getModels());
	assert.equal(scope.diagnostics.length, 0);
	assert.equal(scope.scopedModels[0]?.model, model);
	assert.equal(scope.scopedModels[0]?.thinkingLevel, "low");
	const initial = await findInitialModel({
		defaultProvider: legacy,
		defaultModelId: "gpt-5.4",
		modelThinkingLevels: { [`${legacy}/gpt-5.4`]: "high" },
		isContinuing: false,
		scopedModels: [],
		modelRuntime: runtime,
	});
	assert.equal(initial.model, model);
	assert.equal(initial.thinkingLevel, "high");
	const scopedInitial = await findInitialModel({
		scopedModels: [{ model: model!, thinkingLevel: undefined }],
		modelThinkingLevels: { [`${legacy}/gpt-5.4`]: "high" },
		isContinuing: false,
		modelRuntime: runtime,
	});
	assert.equal(scopedInitial.thinkingLevel, "high");
});

test("mixed-case legacy Azure references resolve in CLI, scopes and saved settings without changing model IDs", async () => {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const model = runtime.getModel("azure", "gpt-5.4");
	assert.ok(model);
	for (const provider of ["AZURE-OPENAI-RESPONSES", "Azure-OpenAI-Responses"]) {
		for (const cli of [
			{ cliModel: `${provider}/gpt-5.4:high` },
			{ cliProvider: provider, cliModel: "gpt-5.4:high" },
		]) {
			const result = resolveCliModel({ ...cli, modelRuntime: runtime });
			assert.equal(result.error, undefined);
			assert.equal(result.model, model);
			assert.equal(result.thinkingLevel, "high");
		}
	}
	const scopedModel = { ...model, id: "MixedCaseDeployment" };
	for (const provider of ["AZURE-OPENAI-RESPONSES", "Azure-OpenAI-Responses"]) {
		for (const pattern of ["MixedCaseDeployment:low", "MixedCase*:low"]) {
			const scope = resolveModelScopeFromModels([`${provider}/${pattern}`], [scopedModel]);
			assert.deepEqual(scope.diagnostics, []);
			assert.deepEqual(scope.scopedModels, [{ model: scopedModel, thinkingLevel: "low" }]);
		}
	}
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-case-settings-"));
	try {
		const path = join(root, "settings.json");
		const content = JSON.stringify({
			defaultProvider: "AZURE-OPENAI-RESPONSES",
			enabledModels: ["Azure-OpenAI-Responses/MixedCase*"],
			routerModel: "AZURE-OPENAI-RESPONSES/MixedCaseDeployment",
			fallbackModels: ["Azure-OpenAI-Responses/MixedCaseDeployment:high"],
			modelThinkingLevels: {
				"AZURE-OPENAI-RESPONSES/MixedCaseDeployment": "low",
				"azure/MixedCaseDeployment": "high",
				"Azure-OpenAI-Responses/OtherDeployment": "medium",
			},
			modelRouting: {
				allowedProviders: ["AZURE-OPENAI-RESPONSES"],
				excludedProviders: ["Azure-OpenAI-Responses"],
			},
		});
		writeFileSync(path, content);
		const settings = SettingsManager.create(root, root);
		assert.equal(settings.getDefaultProvider(), "azure");
		assert.deepEqual(settings.getEnabledModels(), ["azure/MixedCase*"]);
		assert.equal(settings.getRouterModel(), "azure/MixedCaseDeployment");
		assert.deepEqual(settings.getFallbackModels(), ["azure/MixedCaseDeployment:high"]);
		assert.deepEqual(settings.getAllModelThinkingLevels(), {
			"azure/MixedCaseDeployment": "high",
			"azure/OtherDeployment": "medium",
		});
		assert.deepEqual(settings.getModelRouting(), { allowedProviders: ["azure"], excludedProviders: ["azure"] });
		assert.equal(readFileSync(path, "utf-8"), content);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("SDK settings and custom model config accept unmigrated Azure names without rewriting files", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-compat-"));
	try {
		const path = join(root, "models.json");
		const content = JSON.stringify({
			providers: {
				[legacy]: { apiKey: "sdk-key", baseUrl: "https://example.test", models: [{ id: "custom", api: legacy }] },
			},
		});
		writeFileSync(path, content);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: path,
			allowModelNetwork: false,
		});
		assert.equal(runtime.getModel(legacy, "custom")?.provider, "azure");
		assert.equal(runtime.getModel("azure", "custom")?.api, legacy);
		assert.equal(readFileSync(path, "utf-8"), content);
		const settings = SettingsManager.inMemory({
			defaultProvider: legacy,
			enabledModels: [`${legacy}/*`],
			modelThinkingLevels: { [`${legacy}/custom`]: "low", "azure/custom": "high" },
		});
		assert.equal(settings.getDefaultProvider(), "azure");
		assert.deepEqual(settings.getEnabledModels(), ["azure/*"]);
		assert.equal(settings.getModelThinkingLevel("azure", "custom"), "high");
		assert.equal(settings.getModelThinkingLevel(legacy, "custom"), "high");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("custom Azure deployments retain implicit Responses and explicit Chat Completions", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-implicit-api-"));
	try {
		for (const [provider, api] of [
			[legacy, undefined],
			["azure", undefined],
			[legacy, "openai-completions"],
			["azure", "openai-completions"],
		] as const) {
			const path = join(root, "models.json");
			writeFileSync(
				path,
				JSON.stringify({
					providers: {
						[provider]: {
							api,
							baseUrl: "https://azure.test",
							models: [{ id: "responses-deployment" }, { id: "chat-deployment", api: "openai-completions" }],
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: path,
				allowModelNetwork: false,
			});
			assert.equal(runtime.getModel(provider, "responses-deployment")?.api, api ?? legacy);
			assert.equal(runtime.getModel(provider, "chat-deployment")?.api, "openai-completions");
			assert.equal(runtime.getModel(provider, "deepseek-v4-pro")?.api, "openai-completions");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("layered credential lookups retain precedence and canonical collisions win", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-auth-"));
	try {
		const primary = join(root, "auth.json");
		const lower = join(root, "legacy-auth.json");
		writeFileSync(primary, JSON.stringify({ [legacy]: { type: "api_key", key: "primary" } }));
		writeFileSync(lower, JSON.stringify({ azure: { type: "api_key", key: "lower" } }));
		const readonly = new ReadOnlyAuthStorage([primary, lower]);
		assert.deepEqual(await readonly.read("azure"), { type: "api_key", key: "primary" });
		assert.deepEqual(readStoredCredential(legacy, [primary, lower]), { type: "api_key", key: "primary" });
		const mutable = AuthStorage.create([primary, lower]);
		assert.deepEqual(await mutable.read(legacy), { type: "api_key", key: "primary" });
		await mutable.modify(legacy, async (current) => {
			assert.deepEqual(current, { type: "api_key", key: "primary" });
			return { type: "api_key", key: "updated" };
		});
		assert.deepEqual(await mutable.read("azure"), { type: "api_key", key: "updated" });
		await mutable.delete(legacy);
		assert.equal(await AuthStorage.create([primary, lower]).read("azure"), undefined);
		const collision = AuthStorage.inMemory({
			[legacy]: { type: "api_key", key: "old" },
			azure: { type: "api_key", key: "canonical" },
		});
		assert.deepEqual(await collision.read(legacy), { type: "api_key", key: "canonical" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow stages accept legacy Azure model strings and saved session references", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-workflow-"));
	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ [legacy]: { type: "api_key", key: "test" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const adapters = buildRuntimeAdapters(
			{
				getChildSessionOptions: (options) => ({
					cwd: root,
					agentDir: root,
					modelRuntime: runtime,
					settingsManager: SettingsManager.inMemory(),
					builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
					tools: [],
					...options,
				}),
			},
			{ createAgentSession: async (options) => (await createAgentSession(options)) as StageSessionCreateResult },
		);
		const saved = SessionManager.inMemory(root);
		saved.appendModelChange(legacy, "gpt-5.4");
		saved.appendThinkingLevelChange("high");
		saved.appendMessage({ role: "user", content: "previous turn", timestamp: Date.now() });
		for (const options of [
			{ model: `${legacy}/gpt-5.4`, sessionManager: SessionManager.inMemory(root) },
			{ sessionManager: saved },
		]) {
			const result = await adapters.agentSession!.create({ ...options, fallbackModels: [] });
			const session = "session" in result ? result.session : result;
			try {
				assert.equal(session.model?.provider, "azure");
				assert.equal(session.model?.id, "gpt-5.4");
				if (options.sessionManager === saved) assert.equal(session.thinkingLevel, "high");
			} finally {
				await session.dispose();
			}
		}
		assert.equal(saved.getEntries().find((entry) => entry.type === "model_change")?.provider, legacy);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
