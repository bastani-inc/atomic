import assert from "node:assert/strict";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { findInitialModel } from "../src/core/model-resolver.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { resolveDeferredStartupModel } from "../src/main-deferred-startup.js";
import { buildSessionOptions, unresolvedFallbackModelDiagnostics } from "../src/main-session-options.js";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.js";

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

async function completeDeferredStartup(mode: { options: InteractiveMode["options"]; session: object }): Promise<void> {
	Object.assign(mode.session, {
		reload: async () => {},
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		getToolStatus: () => ({ missing: [] }),
	});
	const harness = Object.assign(
		{
			resourceDisclosureContainer: new Container(),
			startupNoticesContainer: new Container(),
			ui: { requestRender() {} },
			deferredStartupPending: true,
			bindCurrentSessionExtensions: async () => {},
			applyRuntimeSettings() {},
			rebuildChatFromMessages() {},
			stopWorkingLoader() {},
			themeController: { applyFromSettings: async () => {} },
			setupAutocompleteProvider() {},
			setupExtensionShortcuts() {},
			retryDeferredModelRestore: async () =>
				InteractiveMode.prototype.retryDeferredModelRestore.call(harness as never),
			showLoadedResources() {},
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			showStartupNoticesIfNeeded() {},
			reportModelCatalogWarning() {},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor() {},
			startSessionRecovery() {},
			showError(message: string) {
				assert.fail(message);
			},
		},
		mode,
	);
	await InteractiveMode.prototype.completeDeferredStartup.call(harness as never);
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

	it("checks fallbackModels entries only after deferred extension providers register (#5247)", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const modelRuntime = getModelRuntime(registry);
		const settingsManager = SettingsManager.inMemory({
			fallbackModels: ["extension-provider/extension-model", "nowhere/no-model"],
		});
		const parsed = parseArgs([]);

		const startup = buildSessionOptions(parsed, [], false, modelRuntime, settingsManager);
		assert.deepEqual(
			unresolvedFallbackModelDiagnostics(parsed, settingsManager, modelRuntime, undefined).map(
				(diagnostic) => diagnostic.message.match(/"([^"]+)"/)?.[1],
			),
			["extension-provider/extension-model", "nowhere/no-model"],
		);
		assert.deepEqual(startup.diagnostics, []);

		registerExtensionModel(registry, "extension-provider", "extension-model");
		const showWarning = vi.fn();
		const mode = {
			options: {
				deferredFallbackModelCheck: (session: {
					settingsManager: SettingsManager;
					modelRuntime: typeof modelRuntime;
				}) => unresolvedFallbackModelDiagnostics(parsed, session.settingsManager, session.modelRuntime, undefined),
			},
			session: { model: undefined, modelRuntime, settingsManager },
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			settingsManager,
			showWarning,
		};

		await completeDeferredStartup(mode);

		assert.deepEqual(showWarning.mock.calls, [
			[
				'fallbackModels setting entry "nowhere/no-model" does not match a model with configured credentials, so model fallback skips it. Use --list-models to see available models.',
			],
		]);
	});

	for (const selection of ["scope", "restore"] as const) {
		it(`checks bare fallback ids against the provider selected by deferred ${selection} (#5247)`, async () => {
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			registerExtensionModel(registry, "initial-provider", "primary-model");
			registerExtensionModel(registry, "other-provider", "shared-model");
			registerExtensionModel(registry, "extension-provider", "shared-model");
			const modelRuntime = getModelRuntime(registry);
			const settingsManager = SettingsManager.inMemory({ fallbackModels: ["shared-model"] });
			const parsed = parseArgs([]);
			const showWarning = vi.fn();
			const session = {
				model: registry.find("initial-provider", "primary-model"),
				modelRuntime,
				settingsManager,
				setScopedModels: vi.fn(),
				setModel: vi.fn(async (model: ReturnType<ModelRegistry["find"]>) => {
					session.model = model;
				}),
			};
			const mode = {
				options: {
					deferredModelScopePatterns: selection === "scope" ? ["extension-provider/shared-model"] : undefined,
					modelFallbackMessage: selection === "restore" ? "Could not restore saved model" : undefined,
					deferredFallbackModelCheck: (activeSession: Pick<typeof session, "model">) =>
						unresolvedFallbackModelDiagnostics(
							parsed,
							settingsManager,
							modelRuntime,
							activeSession.model?.provider,
						),
				},
				session,
				sessionManager: {
					buildSessionContext: () => ({
						messages: [],
						model:
							selection === "restore" ? { provider: "extension-provider", modelId: "shared-model" } : undefined,
					}),
				},
				settingsManager,
				showWarning,
			};

			await completeDeferredStartup(mode);

			assert.equal(session.model?.provider, "extension-provider");
			assert.deepEqual(showWarning.mock.calls, []);
		});
	}

	it("checks fallback entries after trust completion restores an empty session's saved Copilot model (#5247)", async () => {
		const credentials = AuthStorage.inMemory({
			"github-copilot": { type: "api_key", key: "test-key" },
			openai: { type: "api_key", key: "test-key" },
		});
		const registry = await createInMemoryModelRegistry(credentials);
		const modelRuntime = getModelRuntime(registry);
		const savedModel = registry.find("github-copilot", "gpt-5.3-codex");
		assert.ok(savedModel);
		const saved = { provider: savedModel.provider, modelId: savedModel.id };
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "github-copilot",
			defaultModel: "not-in-copilot-cache",
			fallbackModels: ["gpt-5.3-codex", "ghost/no-model"],
		});
		const parsed = parseArgs([]);
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			modelRuntime,
		});
		assert.equal(initial.model, undefined);
		assert.ok(initial.fallbackMessage);
		assert.equal(
			await resolveDeferredStartupModel({
				selected: undefined,
				isContinuing: false,
				savedModel: saved,
				settingsManager,
				modelRuntime,
			}),
			undefined,
		);
		const session = {
			model: { ...savedModel, provider: "unknown", id: "unknown", api: "unknown" },
			modelRuntime,
			settingsManager,
			setModel: async (model: typeof savedModel) => {
				session.model = model;
			},
		};
		const deferredFallbackModelCheck = vi.fn((activeSession: Pick<typeof session, "model">) =>
			unresolvedFallbackModelDiagnostics(parsed, settingsManager, modelRuntime, activeSession.model.provider),
		);
		assert.equal(deferredFallbackModelCheck(session).length, 2);
		deferredFallbackModelCheck.mockClear();
		const showWarning = vi.fn();
		const mode = {
			options: { modelFallbackMessage: initial.fallbackMessage, deferredFallbackModelCheck },
			runtimeHost: { completeStartup: async () => true, services: { diagnostics: [] } },
			session,
			sessionManager: { buildSessionContext: () => ({ messages: [], model: saved }) },
			settingsManager,
			showWarning,
		};

		await completeDeferredStartup(mode);

		assert.deepEqual(session.model, savedModel);
		assert.deepEqual(
			showWarning.mock.calls.map(([message]) => message.match(/entry "([^"]+)"/)?.[1]),
			["ghost/no-model"],
		);
		assert.equal(deferredFallbackModelCheck.mock.calls.length, 1);
	});

	for (const selection of ["scope", "restore"] as const) {
		it(`still reports invalid fallback entries when deferred model ${selection} fails (#5247)`, async () => {
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			registerExtensionModel(registry, "initial-provider", "primary-model");
			registerExtensionModel(registry, "extension-provider", "shared-model");
			const modelRuntime = getModelRuntime(registry);
			const settingsManager = SettingsManager.inMemory({
				fallbackModels: ["extension-provider/shared-model", "ghost/no-model"],
			});
			const parsed = parseArgs([]);
			const showWarning = vi.fn();
			const showError = vi.fn();
			const session = {
				model: registry.find("initial-provider", "primary-model"),
				modelRuntime,
				settingsManager,
				setScopedModels: vi.fn(),
				setModel: vi.fn(async () => {
					throw new Error("model selection failed");
				}),
			};
			const mode = {
				options: {
					deferredModelScopePatterns: selection === "scope" ? ["extension-provider/shared-model"] : undefined,
					modelFallbackMessage: selection === "restore" ? "Could not restore saved model" : undefined,
					deferredFallbackModelCheck: () =>
						unresolvedFallbackModelDiagnostics(parsed, settingsManager, modelRuntime, session.model?.provider),
				},
				session,
				sessionManager: {
					buildSessionContext: () => ({
						messages: [],
						model:
							selection === "restore" ? { provider: "extension-provider", modelId: "shared-model" } : undefined,
					}),
				},
				settingsManager,
				showWarning,
				showError,
			};

			await completeDeferredStartup(mode);

			assert.equal(session.setModel.mock.calls.length, 1);
			assert.equal(session.model?.provider, "initial-provider");
			assert.deepEqual(showError.mock.calls, [["Extension loading failed: model selection failed"]]);
			assert.deepEqual(
				showWarning.mock.calls.map(([message]) => message.match(/entry "([^"]+)"/)?.[1]),
				["ghost/no-model"],
			);
		});
	}

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
