import { getModel, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import "../src/modes/interactive/interactive-auth-login.ts";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("interactive API-key login persistence failures", () => {
	it("surfaces the save error without reporting authentication success", async () => {
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("secret-key");
		const saveError = new Error("auth.json is read-only");
		const showError = vi.fn();
		const showStatus = vi.fn();
		const completeProviderAuthentication = vi.fn();
		const editor = {};
		const harness = {
			session: {
				model: undefined,
				modelRegistry: {
					authStorage: { set: vi.fn(() => { throw saveError; }) },
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError,
			showStatus,
			completeProviderAuthentication,
		};

		const showApiKeyLoginDialog = InteractiveModeBase.prototype.showApiKeyLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;
		await showApiKeyLoginDialog.call(harness, "example", "Example Provider");

		expect(harness.session.modelRegistry.authStorage.set).toHaveBeenCalledWith("example", {
			type: "api_key",
			key: "secret-key",
		});
		expect(completeProviderAuthentication).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(
			"Failed to save API key for Example Provider: auth.json is read-only",
		);
		expect(harness.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
	});
});

describe("post-login model refresh", () => {
	for (const scenario of [
		{ provider: "kimi-coding", name: "Kimi For Coding", authType: "api_key" as const, modelId: "kimi-for-coding" },
		{ provider: "anthropic", name: "Anthropic", authType: "oauth" as const, modelId: "claude-opus-4-8" },
	]) {
		it(`selects the ${scenario.provider} default immediately after ${scenario.authType} login`, async () => {
			const model = getModel(scenario.provider, scenario.modelId);
			expect(model).toBeDefined();
			const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
			const getAvailable = vi.fn(() => [model as Model<Api>]);
			const setModel = vi.fn(async () => {});
			const updateAvailableProviderCount = vi.fn(async () => {});
			const setupAutocompleteProvider = vi.fn();
			const showStatus = vi.fn();
			const harness = {
				session: { modelRegistry: { refresh, getAvailable }, setModel },
				updateAvailableProviderCount,
				setupAutocompleteProvider,
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				showStatus,
				showError: vi.fn(),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				checkDaxnutsEasterEgg: vi.fn(),
			};
			const complete = InteractiveModeBase.prototype.completeProviderAuthentication as (
				this: typeof harness,
				providerId: string,
				providerName: string,
				authType: "oauth" | "api_key",
				previousModel: Model<Api> | undefined,
			) => Promise<void>;

			const loggedOutModel = { provider: "unknown", id: "unknown", api: "unknown" } as Model<Api>;
			await complete.call(harness, scenario.provider, scenario.name, scenario.authType, loggedOutModel);

			expect(refresh).toHaveBeenCalledOnce();
			expect(setModel).toHaveBeenCalledWith(model);
			expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(getAvailable.mock.invocationCallOrder[0]!);
			expect(setModel.mock.invocationCallOrder[0]).toBeLessThan(updateAvailableProviderCount.mock.invocationCallOrder[0]!);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(`Selected ${scenario.modelId}`));
		});
	}
});
