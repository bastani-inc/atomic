import { describe, expect, it, vi } from "vitest";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.ts";
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
});
