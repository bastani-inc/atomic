import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AuthStatus } from "../src/core/provider-composer.js";
import {
	type AuthSelectorProvider,
	OAuthSelectorComponent,
} from "../src/modes/interactive/components/oauth-selector.js";
import "../src/modes/interactive/interactive-auth-routing.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { fakeModelRuntime } from "./model-runtime-test-utils.js";

let previousKeys: ReturnType<typeof getKeybindings>;

beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(previousKeys);
});

const PROVIDERS: AuthSelectorProvider[] = [
	{ id: "openrouter", name: "OpenRouter", authType: "oauth", subscription: false },
	{ id: "openrouter", name: "OpenRouter", authType: "api_key", subscription: false },
	{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
	{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
	{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth", subscription: true },
	{ id: "github-copilot", name: "GitHub Copilot", authType: "api_key", subscription: true },
	{ id: "kimi-coding", name: "Kimi For Coding", authType: "oauth", subscription: true },
	{ id: "kimi-coding", name: "Kimi For Coding", authType: "api_key", subscription: true },
	{ id: "together", name: "Together", authType: "api_key" },
	{ id: "morph", name: "Morph", authType: "api_key" },
	{ id: "local-proxy", name: "Local Proxy", authType: "api_key" },
	{ id: "cmd-proxy", name: "Cmd Proxy", authType: "api_key" },
	{ id: "rt-provider", name: "RT Provider", authType: "api_key" },
];

function statusFor(providerId: string): AuthStatus {
	switch (providerId) {
		case "anthropic":
			return { configured: true, source: "stored", label: "OAuth" };
		case "morph":
			return { configured: true, source: "environment", label: "GEMINI_PROXY_KEY" };
		case "local-proxy":
			return { configured: true, source: "models_json_key" };
		case "cmd-proxy":
			return { configured: true, source: "models_json_command" };
		case "rt-provider":
			return { configured: true, source: "runtime" };
		case "openrouter":
			return { configured: true, source: "fallback" };
		default:
			return { configured: false };
	}
}

function runtimeForStatuses() {
	return fakeModelRuntime({
		getProviderAuthStatus: statusFor,
		getStoredCredentialType: (id) => (id === "anthropic" ? "oauth" : "api_key"),
	});
}

function chooseWithQuery(
	mode: "login" | "logout",
	query: string,
	viaInitialInput = false,
): { chosen: string[]; screen: string } {
	const chosen: string[] = [];
	const selector = new OAuthSelectorComponent(
		mode,
		runtimeForStatuses(),
		PROVIDERS,
		(id, authType) => chosen.push(`${id}:${authType}`),
		() => chosen.push("cancel"),
		statusFor,
		viaInitialInput ? query : "",
	);
	if (!viaInitialInput) {
		for (const ch of query) selector.handleInput(ch);
	}
	const screen = stripAnsi(selector.render(120).join("\n"));
	selector.handleInput("\r");
	selector.dispose();
	return { chosen, screen };
}

describe("OAuthSelectorComponent search scope (#5237)", () => {
	test("ignores rendered status tags, sign-in method suffixes, and partner markers in login and logout search (#5237)", () => {
		for (const mode of ["login", "logout"] as const) {
			for (const query of [
				"not configured",
				"configured",
				"subscription",
				"account",
				"env:",
				"GEMINI_PROXY_KEY",
				"models.json",
				"command",
				"runtime",
				"cohere",
				"oauth",
				"api_key",
				"API key",
				"✦",
				"✓",
			]) {
				const typed = chooseWithQuery(mode, query, false);
				assert.deepEqual(typed.chosen, [], `${mode} typed query ${JSON.stringify(query)} should not pick a row`);
				assert.match(typed.screen, /No matches for /);

				const initial = chooseWithQuery(mode, query, true);
				assert.deepEqual(
					initial.chosen,
					[],
					`${mode} initial query ${JSON.stringify(query)} should not pick a row`,
				);
			}
		}
	});

	test("matches provider display name and id only, and keeps subscription rows first on exact provider queries (#5237)", async () => {
		for (const [query, expected] of [
			["For Coding", "kimi-coding:oauth"],
			["Kimi For Coding", "kimi-coding:oauth"],
			["kimi-coding", "kimi-coding:oauth"],
			["GitHub Copilot", "github-copilot:oauth"],
			["github-copilot", "github-copilot:oauth"],
			["OpenRouter", "openrouter:oauth"],
			["openrouter", "openrouter:oauth"],
			["RT Provider", "rt-provider:api_key"],
		] as const) {
			assert.deepEqual(chooseWithQuery("login", query, false).chosen, [expected], `login typed ${query}`);
			assert.deepEqual(chooseWithQuery("logout", query, true).chosen, [expected], `logout initial ${query}`);
		}

		const withNamedAuthWords: AuthSelectorProvider[] = [
			...PROVIDERS,
			{ id: "openai-api", name: "OpenAI (API key)", authType: "api_key" },
			{ id: "legacy_api_key_proxy", name: "Legacy Gateway", authType: "oauth" },
			{ id: "oauth-gateway", name: "OAuth Gateway", authType: "api_key" },
		];
		for (const [query, expected] of [
			["oauth", ["oauth-gateway:api_key"]],
			["api_key", ["legacy_api_key_proxy:oauth"]],
			["API key", ["openai-api:api_key"]],
		] as const) {
			const chosen: string[] = [];
			const selector = new OAuthSelectorComponent(
				"login",
				runtimeForStatuses(),
				withNamedAuthWords,
				(id, authType) => chosen.push(`${id}:${authType}`),
				() => chosen.push("cancel"),
				statusFor,
				query,
			);
			const rendered = stripAnsi(selector.render(120).join("\n"));
			assert.doesNotMatch(rendered, /Anthropic/);
			assert.doesNotMatch(rendered, /Together/);
			selector.handleInput("\r");
			selector.dispose();
			assert.deepEqual(chosen, expected, `provider name/id match for ${query}`);
		}

		for (const [query, expected] of [
			["github-copilot", ["github-copilot:oauth"]],
			["kimi-coding", ["kimi-coding:oauth"]],
			["For Coding", ["kimi-coding:oauth"]],
			["oauth", []],
			["api_key", []],
			["API key", []],
			["cohere", []],
			["not configured", []],
		] as const) {
			const started: string[] = [];
			let activeSelector: OAuthSelectorComponent | undefined;
			const loginHost = {
				session: {
					modelRuntime: runtimeForStatuses(),
				},
				ui: { requestRender: () => {} },
				getLoginProviderOptions: () => PROVIDERS,
				showStatus: () => {},
				showLoginAuthTypeSelector: () => {},
				startProviderLogin: async (provider: AuthSelectorProvider) => {
					started.push(`${provider.id}:${provider.authType}`);
				},
				showSelector: (factory: (done: () => void) => { component: OAuthSelectorComponent }) => {
					activeSelector = factory(() => {}).component;
				},
			};
			InteractiveModeBase.prototype.showLoginProviderSelector.call(loginHost as unknown as InteractiveModeBase);
			assert.ok(activeSelector);
			for (const ch of query) activeSelector.handleInput(ch);
			activeSelector.handleInput("\r");
			await Promise.resolve();
			activeSelector.dispose();
			assert.deepEqual(started, expected, `/login routing for ${query}`);
		}
	});

	test("adds sign-in method suffixes only when a provider has distinct auth types (#5237)", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[
				{ id: "dual", name: "Dual Provider", authType: "oauth", subscription: true },
				{ id: "dual", name: "Dual Provider", authType: "api_key", subscription: true },
				{ id: "single", name: "Single Provider", authType: "api_key" },
				{ id: "dup", name: "Duplicate Key Provider", authType: "api_key" },
				{ id: "dup", name: "Duplicate Key Provider", authType: "api_key" },
			],
			() => {},
			() => {},
		);
		const lines = selector.render(120).map(stripAnsi);
		selector.dispose();
		assert.ok(lines.some((line) => line.includes("Dual Provider · subscription")));
		assert.ok(lines.some((line) => line.includes("Dual Provider · API key")));
		assert.ok(lines.some((line) => line.includes("Single Provider") && !line.includes("Single Provider ·")));
		assert.equal(
			lines.filter((line) => line.includes("Duplicate Key Provider") && !line.includes("Duplicate Key Provider ·"))
				.length,
			2,
		);
	});
});
