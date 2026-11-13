import assert from "node:assert/strict";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

beforeAll(() => initTheme("dark"));

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
		models: [
			{
				id: modelId,
				name: "Extension model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}

describe("applyDeferredModelScope", () => {
	it("resolves saved model scope after deferred extension loading and surfaces warnings then", async () => {
		const setScopedModels = vi.fn();
		const showWarning = vi.fn();
		const mode = {
			options: { deferredModelScopePatterns: ["claude-*", "extension-only-*"] },
			session: {
				modelRuntime: {
					getAvailableSnapshot: vi.fn(() => [claudeModel]),
					getModel: vi.fn(),
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
				modelRuntime: {
					getAvailableSnapshot: vi.fn(() => [claudeModel]),
					getModel: vi.fn(),
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

	it("deduplicates repeated unmatched model-scope patterns (#4694)", async () => {
		const showWarning = vi.fn();
		const mode = {
			options: { deferredModelScopePatterns: ["missing-*", "missing-*"] },
			session: {
				modelRuntime: {
					getAvailableSnapshot: vi.fn(() => [claudeModel]),
					getModel: vi.fn(),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels: vi.fn(),
			},
			sessionManager: { buildSessionContext: () => ({ messages: [{ role: "user", content: "hello" }] }) },
			settingsManager: { getDefaultProvider: vi.fn(), getDefaultModel: vi.fn() },
			showWarning,
		};

		await applyDeferredModelScope(mode as never);

		assert.equal(showWarning.mock.calls.length, 1);
		assert.equal(showWarning.mock.calls[0]?.[0], 'No models match pattern "missing-*"');
	});

	it("surfaces deferred startup-trust model-scope diagnostics in chat once without dropping or duplicating (#4694)", async () => {
		for (const deferredModelScopePatterns of [undefined, ["github-copilot/missing-model"]] as const) {
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
			const services = {
				diagnostics: [] as Array<{ type: "warning" | "error" | "info"; message: string }>,
			};
			const reload = vi.fn(async () => {});
			Object.assign(mode, {
				chatContainer: new StartupChatContainer(),
				resourceDisclosureContainer: new Container(),
				startupNoticesContainer: new Container(),
				ui: { requestRender() {} },
				lastStatusSpacer: undefined,
				lastStatusText: undefined,
				promptTurnWorkingLoaderActive: false,
				deferredStartupPending: true,
				runtimeHost: {
					services,
					completeStartup: async () => {
						services.diagnostics = [
							{ type: "warning", message: 'No models match pattern "github-copilot/missing-model"' },
						];
						return true;
					},
					session: {
						reload,
						startPendingRecovery: async () => ({ replayed: 0, dropped: 0, completions: 0, notices: [] }),
						getToolStatus: () => ({ missing: [] }),
						resourceLoader: { getThemes: () => ({ themes: [] }) },
						extensionRunner: {},
						modelRuntime: {
							getAvailableSnapshot: () => [claudeModel],
							getError: () => undefined,
							getWarning: () => undefined,
						},
						setScopedModels: vi.fn(),
					},
				},
				options: {
					deferredModelScopePatterns: deferredModelScopePatterns ? [...deferredModelScopePatterns] : undefined,
				},
				bindCurrentSessionExtensions: async () => {},
				applyRuntimeSettings() {},
				rebuildChatFromMessages() {
					mode.chatContainer.clear();
					mode.attachStartupNoticesContainer();
				},
				stopWorkingLoader() {},
				themeController: { applyFromSettings: async () => {} },
				setupAutocompleteProvider() {},
				setupExtensionShortcuts() {},
				retryDeferredModelRestore: async () => {},
				showLoadedResources() {},
				maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
				showStartupNoticesIfNeeded() {},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor() {},
			});
			mode.attachStartupNoticesContainer();

			await InteractiveMode.prototype.completeDeferredStartup.call(mode);

			assert.equal(reload.mock.calls.length, 0);
			const rendered = stripTerminalSequences(mode.chatContainer.render(200).join("\n"));
			assert.equal(rendered.match(/No models match pattern "github-copilot\/missing-model"/g)?.length ?? 0, 1);
		}
	});
});

describe("retryDeferredModelRestore", () => {
	it("suppresses stale no-model fallback warnings when deferred model scope selected a ready model", async () => {
		const mode = {
			options: { modelFallbackMessage: "No models available" },
			sessionManager: { buildSessionContext: () => ({ model: undefined }) },
			session: {
				model: claudeModel,
				modelRuntime: { hasConfiguredAuth: vi.fn(() => true) },
				setModel: vi.fn(),
			},
			showWarning: vi.fn(),
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(mode.session.modelRuntime.hasConfiguredAuth).toHaveBeenCalledWith(claudeModel.provider);
		expect(mode.showWarning).not.toHaveBeenCalled();
	});

	it("selects an exact settings default registered during deferred extension loading", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
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
			session: { model: undefined, modelRuntime: getModelRuntime(registry), setModel, setThinkingLevel },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).toHaveBeenCalledWith(registry.find("deferred-extension", "deferred-model"));
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("uses normal fallback after a model-less extension provider registers", async () => {
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		const registry = await createInMemoryModelRegistry(authStorage);
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
			session: { model: undefined, modelRuntime: getModelRuntime(registry), setModel, setThinkingLevel: vi.fn() },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[0]?.provider).toBe("openai");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("publishes the final generic warning when the settings provider remains unsupported", async () => {
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		const registry = await createInMemoryModelRegistry(authStorage);
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
			session: { model: undefined, modelRuntime: getModelRuntime(registry), setModel, setThinkingLevel: vi.fn() },
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(genericUnsupportedWarning, undefined);
	});

	it("uses ordinary no-model guidance for a supported provider when nothing is available", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
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
			session: {
				model: undefined,
				modelRuntime: getModelRuntime(registry),
				setModel: vi.fn(),
				setThinkingLevel: vi.fn(),
			},
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
				modelRuntime: {
					getModel: vi.fn(() => exactModel),
					getAvailableSnapshot: vi.fn(() => [sameProviderTemplate]),
					hasConfiguredAuth: vi.fn(() => false),
				},
				setModel,
			},
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(mode.session.modelRuntime.getAvailableSnapshot).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Could not restore saved model", undefined);
	});
});
