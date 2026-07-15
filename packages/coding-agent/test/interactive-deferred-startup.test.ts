import { describe, expect, it, vi } from "vitest";
import { applyDeferredModelScope, DeferredCursorModelScopeError, ensureDeferredStartupComplete } from "../src/modes/interactive/interactive-deferred-startup.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const claudeModel = {
	provider: "anthropic",
	id: "claude-sonnet-4",
	name: "Claude Sonnet 4",
};

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

	it("fails closed on an unavailable strict Cursor scope before installing a scope or fallback model", async () => {
		const defaultModel = { ...claudeModel, provider: "openai", id: "fallback-model" };
		const setScopedModels = vi.fn();
		const setModel = vi.fn();
		let deferredStartupFatalError: Error | undefined;
		const mode = {
			options: { deferredModelScopePatterns: ["cursor/missing-route"] },
			deferredStartupPending: true,
			deferredStartupPromise: undefined,
			deferredStartupFatalError,
			completeDeferredStartup: vi.fn(async () => {}),
			session: {
				discoverExtensionModels: vi.fn(async () => {}),
				modelRegistry: {
					getAvailable: vi.fn(async () => [defaultModel]),
					find: vi.fn(() => defaultModel),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels,
				setModel,
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			settingsManager: { getDefaultProvider: () => "openai", getDefaultModel: () => "fallback-model" },
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		mode.completeDeferredStartup.mockImplementation(async () => applyDeferredModelScope(mode as never));
		await expect(ensureDeferredStartupComplete(mode)).rejects.toBeInstanceOf(DeferredCursorModelScopeError);
		expect(mode.deferredStartupFatalError).toBeInstanceOf(DeferredCursorModelScopeError);
		await expect(ensureDeferredStartupComplete(mode)).rejects.toBe(mode.deferredStartupFatalError);

		expect(mode.session.discoverExtensionModels).toHaveBeenCalledOnce();
		expect(setScopedModels).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
	});

	it("installs and selects an exact Cursor scope after deferred discovery", async () => {
		const cursorModel = { ...claudeModel, provider: "cursor", id: "cursor-route:high" };
		const setScopedModels = vi.fn();
		const setModel = vi.fn();
		const mode = {
			options: { deferredModelScopePatterns: ["cursor/cursor-route:high"] },
			session: {
				discoverExtensionModels: vi.fn(async () => {}),
				modelRegistry: {
					getAvailable: vi.fn(async () => [cursorModel]),
					find: vi.fn(),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels,
				setModel,
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			settingsManager: { getDefaultProvider: vi.fn(), getDefaultModel: vi.fn() },
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		await applyDeferredModelScope(mode as never);

		expect(setScopedModels).toHaveBeenCalledWith([{ model: cursorModel, thinkingLevel: undefined }]);
		expect(setModel).toHaveBeenCalledWith(cursorModel);
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
