import { type Api, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { collectOAuthProviderMetadata } from "../src/core/oauth-provider-metadata.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import "../src/modes/interactive/interactive-auth-login.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

// Driving the real LoginDialogComponent through onAuth opens the platform browser.
// On Windows that spawns a detached `rundll32 url.dll,FileProtocolHandler`, which
// inherits this process's stdout/stderr write handles; on a runner with no browser
// it never exits, the suite's pipes never reach EOF, and the CI step hangs until the
// job budget expires. Mock the launcher, as pi's login-dialog suites do.
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

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
		const login = vi.fn(async () => {
			throw saveError;
		});
		const harness = {
			session: { model: undefined, modelRuntime: { login } },
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

		expect(login).toHaveBeenCalledWith(
			"example",
			"api_key",
			expect.objectContaining({
				prompt: expect.any(Function),
				notify: expect.any(Function),
			}),
		);
		expect(completeProviderAuthentication).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Failed to save API key for Example Provider: auth.json is read-only");
		expect(harness.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
	});
});

describe("interactive OAuth cancellation", () => {
	it("restores the editor silently for a native AbortError", async () => {
		const showError = vi.fn();
		const completeProviderAuthentication = vi.fn();
		const editor = {};
		const harness = {
			session: { model: undefined },
			runtimeHost: {
				loginOAuthProvider: async () => {
					throw new DOMException("The operation was aborted.", "AbortError");
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError,
			completeProviderAuthentication,
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "kimi-coding", "Kimi For Coding");

		expect(showError).not.toHaveBeenCalled();
		expect(completeProviderAuthentication).not.toHaveBeenCalled();
		expect(harness.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
	});

	it("does not refresh a second time after an isolated engine login returns a refreshed catalog", async () => {
		const completeProviderAuthentication = vi.fn(async () => {});
		const editor = {};
		const harness = {
			session: { model: undefined },
			runtimeHost: { loginOAuthProvider: async () => ({ modelsRefreshed: true }) },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError: vi.fn(),
			completeProviderAuthentication,
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "corp-oauth", "Corp OAuth");

		expect(completeProviderAuthentication).toHaveBeenCalledWith("corp-oauth", "Corp OAuth", "oauth", undefined, {
			modelsRefreshed: true,
		});
	});

	it("honors transported callback metadata and resolves manual redirect input", async () => {
		const showManualInput = vi
			.spyOn(LoginDialogComponent.prototype, "showManualInput")
			.mockResolvedValue("https://localhost/callback?code=manual");
		const completeProviderAuthentication = vi.fn(async () => {});
		const editor = {};
		const addedChildren: object[] = [];
		const loginOAuthProvider = vi.fn(
			async (
				_provider: string,
				callbacks: {
					onAuth(info: { url: string; instructions?: string }): void;
					onManualCodeInput?(): Promise<string>;
				},
			) => {
				callbacks.onAuth({ url: "https://corp.invalid/login" });
				expect(await callbacks.onManualCodeInput?.()).toBe("https://localhost/callback?code=manual");
				return { modelsRefreshed: true };
			},
		);
		const harness = {
			session: {
				model: undefined,
				modelRuntime: {
					getOAuthProviderMetadata: () => [
						{
							id: "corp-oauth",
							name: "Corp OAuth",
							loginLabel: "Sign in to Corp",
							usesCallbackServer: true,
						},
					],
				},
			},
			runtimeHost: { loginOAuthProvider },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: {
				clear: vi.fn(),
				addChild: vi.fn((child: object) => addedChildren.push(child)),
			},
			editor,
			showError: vi.fn(),
			completeProviderAuthentication,
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "corp-oauth", "Corp OAuth");

		expect(showManualInput).toHaveBeenCalledWith("Paste redirect URL below, or complete login in browser:");
		const dialog = addedChildren[0] as LoginDialogComponent;
		expect(dialog.render(100).join("\n")).toContain("Sign in to Corp");
		expect(completeProviderAuthentication).toHaveBeenCalledOnce();
		expect(vi.mocked(openBrowser)).toHaveBeenCalledWith("https://corp.invalid/login");
	}, 1_000);

	it("offers the paste input for a real OpenRouter login, so a headless host has a way through", async () => {
		// pi 0.83.0 races OpenRouter's loopback callback against a `manual_code`
		// prompt (upstream 61da9e2). The host answers that prompt with a promise
		// only `showManualInput` resolves, so without OpenRouter's real metadata
		// declaring a callback server the prompt waits on an input that is never
		// shown and the login ends at the callback timeout.
		const showManualInput = vi
			.spyOn(LoginDialogComponent.prototype, "showManualInput")
			.mockResolvedValue("https://openrouter.ai/callback?code=pasted");
		const completeProviderAuthentication = vi.fn(async () => {});
		const loginOAuthProvider = vi.fn(
			async (
				_provider: string,
				callbacks: {
					onAuth(info: { url: string; instructions?: string }): void;
					onManualCodeInput?(): Promise<string>;
				},
			) => {
				callbacks.onAuth({ url: "https://openrouter.ai/auth" });
				expect(await callbacks.onManualCodeInput?.()).toBe("https://openrouter.ai/callback?code=pasted");
				return { modelsRefreshed: true };
			},
		);
		const harness = {
			session: {
				model: undefined,
				modelRuntime: {
					// The shipped metadata, not a hand-written stub: this asserts the
					// provider set the terminal actually reads.
					getOAuthProviderMetadata: () => collectOAuthProviderMetadata(builtinProviders(), new Map()),
				},
			},
			runtimeHost: { loginOAuthProvider },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			showError: vi.fn(),
			completeProviderAuthentication,
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "openrouter", "OpenRouter");

		expect(showManualInput).toHaveBeenCalledWith("Paste redirect URL below, or complete login in browser:");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(completeProviderAuthentication).toHaveBeenCalledOnce();
	}, 1_000);

	it("keeps a post-login refresh AbortError visible", async () => {
		const refreshFailure = new DOMException("catalog refresh aborted", "AbortError");
		const showError = vi.fn();
		const editor = {};
		const harness = {
			session: { model: undefined },
			runtimeHost: { loginOAuthProvider: async () => ({ modelsRefreshed: false }) },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError,
			completeProviderAuthentication: async () => {
				throw refreshFailure;
			},
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "corp-oauth", "Corp OAuth");

		expect(showError).toHaveBeenCalledWith("Failed to login to Corp OAuth: catalog refresh aborted");
	});

	it("keeps genuine provider denial visible", async () => {
		const showError = vi.fn();
		const editor = {};
		const harness = {
			session: { model: undefined },
			runtimeHost: {
				loginOAuthProvider: async () => {
					throw new Error("Kimi Code login was denied.");
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError,
			completeProviderAuthentication: vi.fn(),
			showOAuthLoginSelect: vi.fn(),
		};
		const showLoginDialog = InteractiveModeBase.prototype.showLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		await showLoginDialog.call(harness, "kimi-coding", "Kimi For Coding");

		expect(showError).toHaveBeenCalledWith("Failed to login to Kimi For Coding: Kimi Code login was denied.");
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
				session: { modelRuntime: { refresh, getAvailableSnapshot: getAvailable }, setModel },
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
			expect(refresh).toHaveBeenCalledWith();
			expect(setModel).toHaveBeenCalledWith(model);
			expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(getAvailable.mock.invocationCallOrder[0]!);
			expect(setModel.mock.invocationCallOrder[0]).toBeLessThan(
				updateAvailableProviderCount.mock.invocationCallOrder[0]!,
			);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(`Selected ${scenario.modelId}`));
		});
	}

	for (const outcome of [
		{
			label: "reports provider errors",
			result: { aborted: false, errors: new Map([["corp-oauth", new Error("catalog unavailable")]]) },
		},
		{ label: "aborts on timeout", result: { aborted: true, errors: new Map() } },
	]) {
		it(`completes login when the post-login model refresh ${outcome.label}`, async () => {
			const showStatus = vi.fn();
			const refresh = vi.fn(async () => outcome.result);
			const harness = {
				session: {
					modelRuntime: { refresh, getAvailableSnapshot: () => [] },
				},
				updateAvailableProviderCount: vi.fn(),
				setupAutocompleteProvider: vi.fn(),
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

			await complete.call(harness, "corp-oauth", "Corp OAuth", "oauth", undefined);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Logged in to Corp OAuth"));
		});
	}
});
