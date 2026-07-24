import { describe, expect, it, vi } from "vitest";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const claudeModel = {
	provider: "anthropic",
	id: "claude-sonnet-4",
	name: "Claude Sonnet 4",
};

const genericUnsupportedWarning =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";

function registerExtensionModel(registry: ModelRegistry, provider: string, modelId: string): void {
	registry.registerProvider(provider, {
		baseUrl: "https://extension.test/v1",
		apiKey: "test-key",
		api: "openai-completions",
		models: [{
			id: modelId,
			name: "Extension model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}

describe("applyDeferredModelScope", () => {
	it("resolves saved model scope after deferred extension loading and surfaces warnings then", async () => {
		const setScopedModels = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { deferredModelScopePatterns: ["claude-*", "extension-only-*"] },
			session: {
				modelRegistry: {
					getAvailable: vi.fn(async () => [claudeModel]),
					find: vi.fn(),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels,
			},
			sessionManager: { buildSessionContext: () => ({ messages: [{ role: "user", content: "hello" }] }) },
			settingsManager: { getDefaultProvider: vi.fn(), getDefaultModel: vi.fn() },
			showWarning,
		};

		await applyDeferredModelScope(mode as never);

		expect(setScopedModels).toHaveBeenCalledWith([{ model: claudeModel, thinkingLevel: undefined }]);
		expect(showWarning).toHaveBeenCalledWith('No models match pattern "extension-only-*"');
	});

	it("does not let deferred model-scope thinking suffixes override explicit CLI thinking", async () => {
		const setThinkingLevel = vi.fn();
		const mode = {
			options: { deferredModelScopePatterns: ["claude-*:high"], deferredModelScopePreserveThinking: true },
			session: {
				modelRegistry: {
					getAvailable: vi.fn(async () => [claudeModel]),
					find: vi.fn(),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels: vi.fn(),
				setModel: vi.fn(),
				setThinkingLevel,
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			settingsManager: { getDefaultProvider: vi.fn(), getDefaultModel: vi.fn() },
			showWarning: vi.fn(),
		};

		await applyDeferredModelScope(mode as never);

		expect(mode.session.setModel).toHaveBeenCalledWith(claudeModel);
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});
});

describe("retryDeferredModelRestore", () => {
	it("suppresses stale no-model fallback warnings when deferred model scope selected a ready model", async () => {
		const mode = {
			options: { modelFallbackMessage: "No models available" },
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: {
				model: claudeModel,
				modelRegistry: { hasConfiguredAuth: vi.fn(() => true) },
				setModel: vi.fn(),
			},
			showWarning: vi.fn(),
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(mode.session.modelRegistry.hasConfiguredAuth).toHaveBeenCalledWith(claudeModel);
		expect(mode.showWarning).not.toHaveBeenCalled();
	});

	it("selects an exact settings default registered during deferred extension loading", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registerExtensionModel(registry, "deferred-extension", "deferred-model");
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "deferred-extension",
			defaultModel: "deferred-model",
			defaultThinkingLevel: "high",
		});
		const setModel = vi.fn();
		const setThinkingLevel = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: { model: undefined, modelRegistry: registry, setModel, setThinkingLevel },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).toHaveBeenCalledWith(registry.find("deferred-extension", "deferred-model"));
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("uses normal fallback after a model-less extension provider registers", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("deferred-extension", {
			api: "openai-completions",
			streamSimple: () => {
				throw new Error("not called");
			},
		});
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "deferred-extension",
			defaultModel: "unknown-model",
		});
		const setModel = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: { model: undefined, modelRegistry: registry, setModel, setThinkingLevel: vi.fn() },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[0]?.provider).toBe("openai");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("publishes the final generic warning when the settings provider remains unsupported", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const registry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "absent-extension",
			defaultModel: "missing-model",
		});
		const setModel = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: { model: undefined, modelRegistry: registry, setModel, setThinkingLevel: vi.fn() },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(genericUnsupportedWarning, undefined);
	});

	it("uses ordinary no-model guidance for a supported provider when nothing is available", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("deferred-extension", {
			api: "openai-completions",
			streamSimple: () => {
				throw new Error("not called");
			},
		});
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "deferred-extension",
			defaultModel: "unknown-model",
		});
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: { model: undefined, modelRegistry: registry, setModel: vi.fn(), setThinkingLevel: vi.fn() },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(showWarning.mock.calls[0]?.[0]).toContain("No models available");
		expect(showWarning.mock.calls[0]?.[0]).not.toBe(genericUnsupportedWarning);
	});

	it("does not synthesize an exact unauthenticated saved model after deferred loading", async () => {
		const exactModel = { ...claudeModel, provider: "extension-provider", id: "saved-exact" };
		const sameProviderTemplate = {
			...claudeModel,
			provider: "extension-provider",
			id: "authenticated-template",
		};
		const setModel = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: "Could not restore saved model" },
			sessionManager: {
				buildSessionContext: () => ({
					model: { provider: exactModel.provider, modelId: exactModel.id },
				}),
			},
			session: {
				model: sameProviderTemplate,
				modelRegistry: {
					find: vi.fn(() => exactModel),
					getAvailable: vi.fn(async () => [sameProviderTemplate]),
					hasConfiguredAuth: vi.fn((model) => model !== exactModel),
				},
				setModel,
			},
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(mode.session.modelRegistry.getAvailable).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Could not restore saved model", undefined);
	});
});
