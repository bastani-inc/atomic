import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("projects provider-owned auth options without provider-specific filtering", () => {
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(
						this: object,
						authType?: "oauth" | "api_key",
					): Array<{ id: string; name: string; authType: string; method?: { name: string; login?: unknown } }>;
				};
			}
		).prototype.getLoginProviderOptions;
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				auth: {
					oauth: { name: "Anthropic (Claude Pro/Max)", login: async () => ({}) },
					apiKey: { name: "Anthropic API key", login: async () => ({}) },
				},
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				auth: { apiKey: { name: "Google Cloud credentials" } },
			},
		];
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => providers,
					getOAuthProviderMetadata: () => [{ id: "anthropic", name: "Anthropic" }],
					getProviderAuthStatus: () => ({ configured: false }),
					isUsingOAuth: () => false,
				},
			},
		};

		const apiKeyOptions = getLoginProviderOptions.call(fakeThis, "api_key");
		expect(apiKeyOptions).toMatchObject([
			{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			{ id: "google-vertex", name: "Google Vertex AI", authType: "api_key" },
		]);
		expect(getLoginProviderOptions.call(fakeThis, "oauth")).toMatchObject([
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
		]);
	});

	it("offers a stored API key for logout even when the provider advertises OAuth only", () => {
		const getLogoutProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLogoutProviderOptions(this: object): Array<{ id: string; name: string; authType: string }>;
				};
			}
		).prototype.getLogoutProviderOptions;
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => [{ id: "oauth-only", name: "OAuth Only", auth: { oauth: {} } }],
					getOAuthProviderMetadata: () => [{ id: "oauth-only", name: "OAuth Only" }],
					getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
					getStoredCredentialType: () => "api_key",
					isUsingOAuth: () => false,
				},
			},
		};

		expect(getLogoutProviderOptions.call(fakeThis)).toEqual([
			{ id: "oauth-only", name: "OAuth Only", authType: "api_key" },
		]);
	});

	it("labels an engine-published provider by its stored API-key credential", () => {
		const getLogoutProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLogoutProviderOptions(this: object): Array<{ id: string; name: string; authType: string }>;
				};
			}
		).prototype.getLogoutProviderOptions;
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => [],
					getOAuthProviderMetadata: () => [{ id: "engine-oauth", name: "Engine OAuth" }],
					getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
					getStoredCredentialType: () => "api_key",
					isUsingOAuth: () => false,
				},
			},
		};

		expect(getLogoutProviderOptions.call(fakeThis)).toEqual([
			{ id: "engine-oauth", name: "Engine OAuth", authType: "api_key" },
		]);
	});

	it("renders an option without compiled auth status as unconfigured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "google", name: "Google", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("unconfigured");
		expect(output).not.toContain("✓ configured");
	});

	it("shows stored OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime({ getStoredCredentialType: () => "oauth" }),
			[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "stored", label: "OAuth" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("subscription configured");
		expect(output).not.toContain("API key configured");
	});

	it("shows a stored API key distinctly in the subscription selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime({ getStoredCredentialType: () => "api_key" }),
			[{ id: "anthropic", name: "Anthropic", authType: "oauth" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "stored", label: "API key" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("API key configured");
		expect(output).not.toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "environment", label: "OPENAI_API_KEY" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "local-proxy", name: "local-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_key" }),
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "op-proxy", name: "op-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_command" }),
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ command in models.json");
	});
});
