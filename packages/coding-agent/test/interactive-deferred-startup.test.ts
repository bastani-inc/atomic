import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { findInitialModel, resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.js";
import { createAgentSession, createUnstartedAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { recordStartupThinkingLevel, savedConversationThinkingLevel } from "../src/core/startup-thinking-level.js";
import { resolveDeferredStartupModel } from "../src/main-deferred-startup.js";
import { buildSessionOptions, unresolvedFallbackModelDiagnostics } from "../src/main-session-options.js";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { installDeprecationWarningSink } from "../src/modes/interactive/interactive-startup.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { clearDeprecationWarningsForTests } from "../src/utils/deprecation.js";
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
		getToolStatusAsync: () => ({ missing: [] }),
		...mode.session,
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
			refreshProjectTrustWarning() {},
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
			options: { deferredModelScopePatterns: ["claude-*:high"], deferredStartupThinkingLevel: "low" },
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
		expect(setThinkingLevel.mock.calls).toEqual([["low"]]);
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
				setThinkingLevel: vi.fn(),
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
			setThinkingLevel: async () => {},
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
			const deferredFallbackModelCheck = vi.fn(() =>
				unresolvedFallbackModelDiagnostics(parsed, settingsManager, modelRuntime, session.model?.provider),
			);
			const mode = {
				options: {
					deferredModelScopePatterns: selection === "scope" ? ["extension-provider/shared-model"] : undefined,
					modelFallbackMessage: selection === "restore" ? "Could not restore saved model" : undefined,
					deferredFallbackModelCheck,
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
			assert.equal(deferredFallbackModelCheck.mock.calls.length, 1);
			assert.deepEqual(showError.mock.calls, [["Extension loading failed: model selection failed"]]);
			assert.deepEqual(
				showWarning.mock.calls.map(([message]) => message.match(/entry "([^"]+)"/)?.[1]),
				["ghost/no-model"],
			);
		});
	}

	for (const failureStep of ["bind", "completeStartup", "reload"] as const) {
		it(`still reports invalid fallback entries once when deferred ${failureStep} fails (#5247)`, async () => {
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			registerExtensionModel(registry, "initial-provider", "primary-model");
			const modelRuntime = getModelRuntime(registry);
			const settingsManager = SettingsManager.inMemory({
				fallbackModels: ["initial-provider/primary-model", "ghost/no-model"],
			});
			const parsed = parseArgs([]);
			const showWarning = vi.fn();
			const showError = vi.fn();
			const session = {
				model: registry.find("initial-provider", "primary-model"),
				modelRuntime,
				settingsManager,
				reload:
					failureStep === "reload"
						? vi.fn(async () => {
								throw new Error("reload failed");
							})
						: vi.fn(async () => {}),
			};
			const deferredFallbackModelCheck = vi.fn(() =>
				unresolvedFallbackModelDiagnostics(parsed, settingsManager, modelRuntime, session.model?.provider),
			);
			const mode = {
				options: { deferredFallbackModelCheck },
				bindCurrentSessionExtensions:
					failureStep === "bind"
						? async () => {
								throw new Error("bind failed");
							}
						: async () => {},
				runtimeHost:
					failureStep === "completeStartup"
						? {
								completeStartup: async () => {
									throw new Error("completeStartup failed");
								},
								services: { diagnostics: [] },
							}
						: undefined,
				session,
				sessionManager: { buildSessionContext: () => ({ messages: [] }) },
				settingsManager,
				showWarning,
				showError,
			};

			await completeDeferredStartup(mode);

			assert.equal(deferredFallbackModelCheck.mock.calls.length, 1);
			assert.deepEqual(showError.mock.calls, [[`Extension loading failed: ${failureStep} failed`]]);
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
						getToolStatusAsync: () => ({ missing: [] }),
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

describe("deprecation warnings during deferred startup", () => {
	it("keeps a removed-setting warning raised while startup trust is accepted through the chat rebuild", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-deferred-deprecation-"));
		const restore: (() => void)[] = [];
		try {
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(join(cwd, ".atomic"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(cwd, ".atomic", "settings.json"),
				JSON.stringify({ modelRouting: { excludedProviders: ["x"] } }),
			);
			const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
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
					services: { diagnostics: [] },
					// Accepting startup trust loads the project's settings, whose migration warns about the removed key.
					completeStartup: async () => {
						settings.setProjectTrusted(true);
						return true;
					},
					session: {
						reload: async () => {},
						startPendingRecovery: async () => ({ replayed: 0, dropped: 0, completions: 0, notices: [] }),
						getToolStatusAsync: () => ({ missing: [] }),
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
				options: {},
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
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			restore.push(() => warn.mockRestore());
			restore.push(installDeprecationWarningSink(mode));

			await InteractiveMode.prototype.completeDeferredStartup.call(mode);

			const rendered = stripTerminalSequences(mode.chatContainer.render(200).join("\n"));
			assert.equal(rendered.match(/"modelRouting"/g)?.length ?? 0, 1, rendered);
			assert.equal(warn.mock.calls.length, 0, "nothing is written over the terminal");
		} finally {
			for (const undo of restore.reverse()) undo();
			clearDeprecationWarningsForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("retryDeferredModelRestore", () => {
	it("suppresses stale no-model fallback warnings when deferred model scope selected a ready model", async () => {
		const mode = {
			options: { modelFallbackMessage: "No models available" },
			sessionManager: { buildSessionContext: () => ({ messages: [], model: undefined }) },
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
			sessionManager: { buildSessionContext: () => ({ messages: [], model: undefined }) },
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
			sessionManager: { buildSessionContext: () => ({ messages: [], model: undefined }) },
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
			sessionManager: { buildSessionContext: () => ({ messages: [], model: undefined }) },
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
			sessionManager: { buildSessionContext: () => ({ messages: [], model: undefined }) },
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
			settingsManager: SettingsManager.inMemory(),
			sessionManager: {
				buildSessionContext: () => ({
					messages: [],
					model: { provider: exactModel.provider, modelId: exactModel.id },
				}),
			},
			session: {
				model: sameProviderTemplate,
				modelRuntime: {
					getModel: vi.fn(() => exactModel),
					getAvailableSnapshot: vi.fn(() => []),
					hasConfiguredAuth: vi.fn(() => false),
				},
				setModel,
			},
			showWarning,
		};

		await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);

		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning.mock.calls[0]?.[0]).toContain("No models available");
	});

	it("retries the configured default or keeps an already-selected model when a message-less session's saved model is gone (#5247)", async () => {
		const credentials = AuthStorage.inMemory({
			"github-copilot": { type: "api_key", key: "test-key" },
		});
		const registry = await createInMemoryModelRegistry(credentials);
		registerExtensionModel(registry, "deferred-extension", "deferred-model");
		const modelRuntime = getModelRuntime(registry);
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "deferred-extension",
			defaultModel: "deferred-model",
			defaultThinkingLevel: "high",
		});
		const expectedDefault = registry.find("deferred-extension", "deferred-model");
		assert.ok(expectedDefault);

		const setModelPending = vi.fn();
		const setThinkingPending = vi.fn();
		const warnPending = vi.fn();
		await InteractiveMode.prototype.retryDeferredModelRestore.call({
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: {
				buildSessionContext: () => ({
					messages: [],
					model: { provider: "gone-provider", modelId: "old-model" },
				}),
			},
			session: {
				model: { ...claudeModel, provider: "unknown", id: "unknown", api: "unknown" },
				modelRuntime,
				setModel: setModelPending,
				setThinkingLevel: setThinkingPending,
			},
			showWarning: warnPending,
		} as never);
		expect(setModelPending).toHaveBeenCalledWith(expectedDefault);
		expect(setThinkingPending).toHaveBeenCalledWith("high");
		expect(warnPending).not.toHaveBeenCalled();

		const setModelReady = vi.fn();
		const warnReady = vi.fn();
		await InteractiveMode.prototype.retryDeferredModelRestore.call({
			options: { modelFallbackMessage: genericUnsupportedWarning },
			settingsManager,
			sessionManager: {
				buildSessionContext: () => ({
					messages: [],
					model: { provider: "gone-provider", modelId: "old-model" },
				}),
			},
			session: {
				model: expectedDefault,
				modelRuntime,
				setModel: setModelReady,
				setThinkingLevel: vi.fn(),
			},
			showWarning: warnReady,
		} as never);
		expect(setModelReady).not.toHaveBeenCalled();
		expect(warnReady).not.toHaveBeenCalled();

		for (const savedProvider of ["gone-provider", "github-copilot"]) {
			const setModelRetried = vi.fn();
			const warnRetried = vi.fn();
			await InteractiveMode.prototype.retryDeferredModelRestore.call({
				options: { modelFallbackMessage: genericUnsupportedWarning },
				settingsManager,
				sessionManager: {
					buildSessionContext: () => ({
						messages: [],
						model: { provider: savedProvider, modelId: "uncached-copilot-fast" },
					}),
				},
				session: {
					model: { ...claudeModel, provider: "unknown", id: "unknown", api: "unknown" },
					modelRuntime,
					setModel: setModelRetried,
					setThinkingLevel: vi.fn(),
				},
				showWarning: warnRetried,
			} as never);
			expect(setModelRetried).toHaveBeenCalledWith(expectedDefault);
			expect(warnRetried).not.toHaveBeenCalled();
		}
	});

	for (const configuredDefault of [true, false]) {
		for (const alreadySelected of [true, false]) {
			it(`replaces a continued session's stale warning with its final model, default=${configuredDefault}, selected=${alreadySelected} (#5247)`, async () => {
				const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
				registerExtensionModel(registry, "deferred-extension", "deferred-model");
				const modelRuntime = getModelRuntime(registry);
				const expectedModel = registry.find("deferred-extension", "deferred-model");
				assert.ok(expectedModel);
				const settingsManager = SettingsManager.inMemory({
					...(configuredDefault
						? { defaultProvider: expectedModel.provider, defaultModel: expectedModel.id }
						: {}),
					defaultThinkingLevel: "high",
				});
				const setModel = vi.fn();
				const setThinkingLevel = vi.fn();
				const showWarning = vi.fn();
				await InteractiveMode.prototype.retryDeferredModelRestore.call({
					options: { modelFallbackMessage: genericUnsupportedWarning, deferredStartupThinkingLevel: "low" },
					settingsManager,
					sessionManager: {
						buildSessionContext: () => ({
							messages: [{ role: "user", content: "hello", timestamp: 1 }],
							model: { provider: "gone-provider", modelId: "old-model" },
							thinkingLevel: "low",
						}),
					},
					session: {
						model: alreadySelected ? expectedModel : undefined,
						modelRuntime,
						setModel,
						setThinkingLevel,
					},
					showWarning,
				} as never);
				expect(showWarning.mock.calls).toEqual([
					["Could not restore model gone-provider/old-model. Using deferred-extension/deferred-model", undefined],
				]);
				expect(setModel).toHaveBeenCalledTimes(alreadySelected ? 0 : 1);
				if (!alreadySelected) {
					expect(setModel).toHaveBeenCalledWith(expectedModel);
					expect(setThinkingLevel).toHaveBeenCalledWith("low");
				}
			});
		}
	}

	it("keeps the uncached saved Copilot warning for a continued conversation (#5247)", async () => {
		const registry = await createInMemoryModelRegistry(
			AuthStorage.inMemory({
				"github-copilot": { type: "api_key", key: "test-key" },
			}),
		);
		registerExtensionModel(registry, "deferred-extension", "deferred-model");
		const setModel = vi.fn();
		const showWarning = vi.fn();
		await InteractiveMode.prototype.retryDeferredModelRestore.call({
			options: { modelFallbackMessage: "Could not restore uncached Copilot model" },
			sessionManager: {
				buildSessionContext: () => ({
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
					model: { provider: "github-copilot", modelId: "uncached-copilot-fast" },
				}),
			},
			session: { modelRuntime: getModelRuntime(registry), setModel },
			showWarning,
		} as never);
		expect(setModel).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Could not restore uncached Copilot model", undefined);
	});

	for (const continued of [false, true]) {
		for (const configuredDefault of [false, true]) {
			it(`uses startup thinking settings after deferred selection, continued=${continued}, default=${configuredDefault} (#5247)`, async () => {
				const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
				registerExtensionModel(registry, "deferred-extension", "deferred-model");
				const settingsManager = SettingsManager.inMemory({
					...(configuredDefault ? { defaultProvider: "deferred-extension", defaultModel: "deferred-model" } : {}),
					defaultThinkingLevel: "high",
				});
				settingsManager.setModelThinkingLevel("deferred-extension", "deferred-model", "low");
				const setModel = vi.fn();
				const setThinkingLevel = vi.fn();
				const showWarning = vi.fn();
				await InteractiveMode.prototype.retryDeferredModelRestore.call({
					options: { modelFallbackMessage: "No models available" },
					settingsManager,
					sessionManager: {
						buildSessionContext: () => ({
							messages: continued ? [{ role: "user", content: "hello", timestamp: 1 }] : [],
							thinkingLevel: "off",
						}),
					},
					session: { modelRuntime: getModelRuntime(registry), setModel, setThinkingLevel },
					showWarning,
				} as never);
				expect(setModel).toHaveBeenCalledWith(registry.find("deferred-extension", "deferred-model"));
				expect(setThinkingLevel).toHaveBeenCalledWith(continued ? "high" : "low");
				expect(showWarning).not.toHaveBeenCalled();
			});
		}
	}
});

describe("deferred startup thinking level (#5247)", () => {
	const noBuiltins = { subagents: false, mcp: false, "web-access": false, intercom: false };
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-deferred-thinking-"));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	interface StartupCase {
		settings?: Parameters<typeof SettingsManager.inMemory>[0];
		openaiKey?: boolean;
		savedModel?: { provider: string; modelId: string };
		savedThinkingLevel?: ThinkingLevel;
		continued?: boolean;
		args?: string[];
	}

	function registerExtensionProvider(registry: ModelRegistry): void {
		registry.registerProvider("ext-provider", {
			baseUrl: "https://extension.test/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: ["ext-primary", "ext-other"].map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			})),
		});
	}

	async function startupInputs(startup: StartupCase, extensionRegistered: boolean) {
		const registry = await createInMemoryModelRegistry(
			AuthStorage.inMemory(startup.openaiKey ? { openai: { type: "api_key", key: "test-key" } } : {}),
		);
		if (extensionRegistered) registerExtensionProvider(registry);
		const modelRuntime = getModelRuntime(registry);
		const settingsManager = SettingsManager.inMemory(startup.settings ?? {});
		const sessionManager = SessionManager.inMemory(root);
		if (startup.savedModel)
			await sessionManager.appendModelChange(startup.savedModel.provider, startup.savedModel.modelId);
		if (startup.savedThinkingLevel) await sessionManager.appendThinkingLevelChange(startup.savedThinkingLevel);
		if (startup.continued) {
			await sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "continue" }],
				timestamp: 1,
			});
		}
		const parsed = parseArgs(startup.args ?? []);
		const { scopedModels } = parsed.models
			? await resolveModelScopeWithDiagnostics(parsed.models, modelRuntime)
			: { scopedModels: [] };
		const { options } = buildSessionOptions(
			parsed,
			scopedModels,
			Boolean(startup.continued),
			modelRuntime,
			settingsManager,
		);
		const sessionOptions = {
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			settingsManager,
			sessionManager,
			builtins: noBuiltins,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			scopedModels: options.scopedModels,
		};
		return { registry, parsed, sessionManager, settingsManager, sessionOptions };
	}

	async function eagerStartup(startup: StartupCase) {
		const { sessionOptions } = await startupInputs(startup, true);
		const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);
		try {
			return {
				model: `${session.model?.provider}/${session.model?.id}`,
				thinkingLevel: session.thinkingLevel,
				recordedThinkingLevel: sessionOptions.sessionManager.buildSessionContext().thinkingLevel,
				warnings: modelFallbackMessage ? [modelFallbackMessage] : [],
			};
		} finally {
			await session.dispose();
		}
	}

	async function deferredStartup(startup: StartupCase, path: "extension-load" | "trust") {
		const { registry, parsed, sessionManager, settingsManager, sessionOptions } = await startupInputs(startup, false);
		const savedThinkingLevel = savedConversationThinkingLevel(sessionManager, sessionManager.buildSessionContext());
		const { session, modelFallbackMessage } = await createUnstartedAgentSession(
			sessionOptions,
			path === "extension-load",
		);
		try {
			registerExtensionProvider(registry);
			const showWarning = vi.fn();
			const mode = {
				options: {
					modelFallbackMessage,
					deferredStartupThinkingLevel: parsed.thinking ?? savedThinkingLevel,
					deferredSavedThinkingLevel: savedThinkingLevel,
					deferredModelScopePatterns: path === "extension-load" ? parsed.models : undefined,
				},
				session,
				sessionManager,
				settingsManager,
				showWarning,
			};
			if (path === "trust") {
				const eager = await eagerStartup(startup);
				const [provider, modelId] = eager.model.split("/");
				const finalModel = registry.find(provider ?? "", modelId ?? "");
				assert.ok(finalModel);
				session.agent.state.model = finalModel;
				await sessionManager.appendModelChange(finalModel.provider, finalModel.id);
				await session.setThinkingLevel(eager.thinkingLevel);
				await recordStartupThinkingLevel(sessionManager, savedThinkingLevel, session.thinkingLevel);
			} else {
				await applyDeferredModelScope(mode as never);
			}
			await InteractiveMode.prototype.retryDeferredModelRestore.call(mode as never);
			return {
				model: `${session.model?.provider}/${session.model?.id}`,
				thinkingLevel: session.thinkingLevel,
				recordedThinkingLevel: sessionManager.buildSessionContext().thinkingLevel,
				warnings: showWarning.mock.calls.map(([message]) => message),
			};
		} finally {
			await session.dispose();
		}
	}

	it("gives a continued conversation without a saved level the default level when an extension default replaces its model", async () => {
		const startup: StartupCase = {
			settings: { defaultProvider: "ext-provider", defaultModel: "ext-primary" },
			savedModel: { provider: "gone-provider", modelId: "old-model" },
			continued: true,
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "extension-load");

		assert.deepEqual(eager, {
			model: "ext-provider/ext-primary",
			thinkingLevel: "medium",
			recordedThinkingLevel: "medium",
			warnings: ["Could not restore model gone-provider/old-model. Using ext-provider/ext-primary"],
		});
		assert.deepEqual(deferred, eager);
	});

	it("keeps a continued conversation's saved level when its extension model is restored", async () => {
		const startup: StartupCase = {
			settings: { defaultThinkingLevel: "low" },
			savedModel: { provider: "ext-provider", modelId: "ext-primary" },
			savedThinkingLevel: "high",
			continued: true,
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "extension-load");

		assert.deepEqual(eager, {
			model: "ext-provider/ext-primary",
			thinkingLevel: "high",
			recordedThinkingLevel: "high",
			warnings: [],
		});
		assert.deepEqual(deferred, eager);
	});

	it("keeps the default level when the restored extension model replaces a non-reasoning default", async () => {
		const startup: StartupCase = {
			settings: { defaultProvider: "openai", defaultModel: "gpt-4.1", defaultThinkingLevel: "high" },
			openaiKey: true,
			savedModel: { provider: "ext-provider", modelId: "ext-primary" },
			continued: true,
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "extension-load");

		assert.deepEqual(eager, {
			model: "ext-provider/ext-primary",
			thinkingLevel: "high",
			recordedThinkingLevel: "high",
			warnings: [],
		});
		assert.deepEqual(deferred, eager);
	});

	it("keeps a continued conversation's saved level on record when --thinking overrides it for a restored extension model", async () => {
		const startup: StartupCase = {
			savedModel: { provider: "ext-provider", modelId: "ext-primary" },
			savedThinkingLevel: "low",
			continued: true,
			args: ["--thinking", "high"],
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "extension-load");

		assert.deepEqual(eager, {
			model: "ext-provider/ext-primary",
			thinkingLevel: "high",
			recordedThinkingLevel: "low",
			warnings: [],
		});
		assert.deepEqual(deferred, eager);
	});

	it("keeps the conversation's level after trust completion when the final model has a per-model level", async () => {
		const startup: StartupCase = {
			settings: {
				defaultProvider: "ext-provider",
				defaultModel: "ext-primary",
				modelThinkingLevels: { "ext-provider/ext-primary": "low" },
			},
			savedModel: { provider: "gone-provider", modelId: "old-model" },
			savedThinkingLevel: "high",
			continued: true,
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "trust");

		assert.equal(eager.model, "ext-provider/ext-primary");
		assert.equal(eager.thinkingLevel, "high");
		assert.equal(eager.recordedThinkingLevel, "high");
		assert.deepEqual(deferred, { ...eager, warnings: [] });
	});

	for (const path of ["extension-load", "trust"] as const) {
		it(`applies --thinking to a model selected after deferred registration, ${path} path`, async () => {
			const startup: StartupCase = {
				settings: { defaultProvider: "ext-provider", defaultModel: "ext-primary" },
				args: ["--thinking", "high"],
			};
			const eager = await eagerStartup(startup);
			const deferred = await deferredStartup(startup, path);

			assert.deepEqual(eager, {
				model: "ext-provider/ext-primary",
				thinkingLevel: "high",
				recordedThinkingLevel: "high",
				warnings: [],
			});
			assert.deepEqual(deferred, eager);
		});

		it(`applies a deferred --models thinking suffix over a per-model level, ${path} path`, async () => {
			const startup: StartupCase = {
				settings: { modelThinkingLevels: { "ext-provider/ext-primary": "low" } },
				args: ["--models", "ext-provider/ext-primary:high"],
			};
			const eager = await eagerStartup(startup);
			const deferred = await deferredStartup(startup, path);

			assert.deepEqual(eager, {
				model: "ext-provider/ext-primary",
				thinkingLevel: "high",
				recordedThinkingLevel: "high",
				warnings: [],
			});
			assert.deepEqual(deferred, eager);
		});
	}

	for (const scope of [
		{
			settings: { defaultProvider: "ext-provider", defaultModel: "ext-primary" },
			models: "openai/gpt-5.3-codex:high,ext-provider/ext-primary:low",
		},
		{ settings: {}, models: "ext-provider/ext-primary:low,openai/gpt-5.3-codex:high" },
	]) {
		it(`selects eager startup's extension model when deferred --models ${scope.models} first resolved a built-in model`, async () => {
			const startup: StartupCase = { settings: scope.settings, openaiKey: true, args: ["--models", scope.models] };
			const eager = await eagerStartup(startup);
			const deferred = await deferredStartup(startup, "extension-load");

			assert.deepEqual(eager, {
				model: "ext-provider/ext-primary",
				thinkingLevel: "low",
				recordedThinkingLevel: "low",
				warnings: [],
			});
			assert.deepEqual(deferred, eager);
		});
	}

	it("ignores the thinking entry of a session without messages", async () => {
		const sessionManager = SessionManager.inMemory(root);
		await sessionManager.appendThinkingLevelChange("low");
		assert.equal(savedConversationThinkingLevel(sessionManager, sessionManager.buildSessionContext()), undefined);

		const startup: StartupCase = {
			settings: { defaultProvider: "ext-provider", defaultModel: "ext-primary" },
			savedThinkingLevel: "low",
		};
		const eager = await eagerStartup(startup);
		const deferred = await deferredStartup(startup, "extension-load");

		assert.deepEqual(eager, {
			model: "ext-provider/ext-primary",
			thinkingLevel: "medium",
			recordedThinkingLevel: "medium",
			warnings: [],
		});
		assert.deepEqual(deferred, eager);
	});
});
