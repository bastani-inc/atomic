import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { openRouterGlow, radiusShimmer } from "../src/modes/interactive/components/provider-brand.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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
				auth: { apiKey: { name: "Google Cloud credentials", login: async () => ({}) } },
			},
			{
				id: "ambient-only",
				name: "Ambient Only",
				auth: { apiKey: { name: "Ambient credentials" } },
			},
		];
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => providers,
					getApiKeyLoginProviderMetadata: () =>
						ModelRuntime.prototype.getApiKeyLoginProviderMetadata.call({
							getProviders: () => providers,
						} as unknown as ModelRuntime),
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
					getApiKeyLoginProviderMetadata: () => [],
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
					getApiKeyLoginProviderMetadata: () => [],
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

	it("renders an option without compiled auth status as not configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "google", name: "Google", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("not configured");
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

	it("labels an OAuth sign-in without a subscription as an account", () => {
		const providers = [
			{ id: "corp-sso", name: "Corporate SSO", authType: "oauth" as const, subscription: false },
			{ id: "corp-sso", name: "Corporate SSO", authType: "api_key" as const, subscription: false },
		];
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime({ getStoredCredentialType: () => "oauth" }),
			providers,
			() => {},
			() => {},
			() => ({ configured: true, source: "stored", label: "OAuth" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Corporate SSO · account");
		expect(output).toContain("✓ account configured");
		expect(output).not.toContain("subscription");
	});

	it("labels a subscription-backed sign-in as a subscription", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime({ getStoredCredentialType: () => "oauth" }),
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
				{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
			],
			() => {},
			() => {},
			() => ({ configured: true, source: "stored", label: "OAuth" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Anthropic · subscription");
		expect(output).toContain("✓ subscription configured");
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
		expect(output).not.toContain("not configured");
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
	it("lists preferred partners first, then the rest alphabetically", () => {
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(
						this: object,
						authType?: "oauth" | "api_key",
					): Array<{ id: string; authType: string }>;
				};
			}
		).prototype.getLoginProviderOptions;
		const fakeThis = {
			session: {
				modelRuntime: {
					getOAuthProviderMetadata: () => [
						{ id: "openrouter", name: "OpenRouter", isSubscription: false },
						{ id: "radius", name: "Radius", isSubscription: false },
						{ id: "anthropic", name: "Anthropic", isSubscription: true },
					],
					getApiKeyLoginProviderMetadata: () => [
						{ id: "zai", name: "Z.AI" },
						{ id: "openrouter", name: "OpenRouter" },
						{ id: "google", name: "Google" },
					],
				},
			},
		};

		expect(getLoginProviderOptions.call(fakeThis).map(({ id, authType }) => `${id}:${authType}`)).toEqual([
			"radius:oauth",
			"openrouter:oauth",
			"openrouter:api_key",
			"anthropic:oauth",
			"google:api_key",
			"zai:api_key",
		]);
		expect(getLoginProviderOptions.call(fakeThis, "oauth").map(({ id }) => id)).toEqual([
			"radius",
			"openrouter",
			"anthropic",
		]);
		expect(getLoginProviderOptions.call(fakeThis, "api_key").map(({ id }) => id)).toEqual([
			"openrouter",
			"google",
			"zai",
		]);
	});

	it("lists preferred partners first in the logout selector", () => {
		const getLogoutProviderOptions = (
			InteractiveMode as unknown as {
				prototype: { getLogoutProviderOptions(this: object): Array<{ id: string }> };
			}
		).prototype.getLogoutProviderOptions;
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => [
						{ id: "zai", name: "Z.AI" },
						{ id: "openrouter", name: "OpenRouter" },
						{ id: "anthropic", name: "Anthropic" },
						{ id: "radius", name: "Radius" },
					],
					getApiKeyLoginProviderMetadata: () => [],
					getOAuthProviderMetadata: () => [],
					getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
					getStoredCredentialType: () => "api_key",
				},
			},
		};

		expect(getLogoutProviderOptions.call(fakeThis).map(({ id }) => id)).toEqual([
			"radius",
			"openrouter",
			"anthropic",
			"zai",
		]);
	});

	it("shows the brand style of a preferred partner only on its selected row", () => {
		const tui = { requestRender: () => {} } as unknown as TUI;
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[
				{ id: "radius", name: "Radius", authType: "oauth" },
				{ id: "openrouter", name: "OpenRouter", authType: "api_key" },
			],
			() => {},
			() => {},
			undefined,
			"",
			tui,
		);
		try {
			const output = selector.render(120).join("\n");
			expect(output).not.toContain(theme.fg("accent", "Radius"));
			expect(output).toContain(theme.fg("text", "OpenRouter"));
			expect(stripAnsi(output)).toContain("→ Radius");

			selector.handleInput("\x1b[B");
			const moved = selector.render(120).join("\n");
			expect(moved).toContain(theme.fg("text", "Radius"));
			expect(moved).not.toContain(theme.fg("accent", "OpenRouter"));
			expect(stripAnsi(moved)).toContain("→ OpenRouter");
		} finally {
			selector.dispose();
		}
	});

	it("brands only the provider name of a selected partner with several sign-in methods", () => {
		const tui = { requestRender: () => {} } as unknown as TUI;
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[
				{ id: "openrouter", name: "OpenRouter", authType: "oauth", subscription: false },
				{ id: "openrouter", name: "OpenRouter", authType: "api_key" },
			],
			() => {},
			() => {},
			undefined,
			"",
			tui,
		);
		try {
			const lines = selector.render(120).map(stripAnsi);
			expect(lines.some((line) => line.includes("→ OpenRouter ✦ · account"))).toBe(true);
			expect(lines.some((line) => line.includes("  OpenRouter ✦ · API key"))).toBe(true);
		} finally {
			selector.dispose();
		}
	});

	it("re-renders the animated row on every frame and stops after dispose", () => {
		let frames = 0;
		const tui = {
			requestRender: () => {
				frames++;
			},
		} as unknown as TUI;
		vi.useFakeTimers();
		try {
			const selector = new OAuthSelectorComponent(
				"login",
				fakeModelRuntime(),
				[
					{ id: "radius", name: "Radius", authType: "oauth" },
					{ id: "anthropic", name: "Anthropic", authType: "api_key" },
				],
				() => {},
				() => {},
				undefined,
				"",
				tui,
			);
			vi.advanceTimersByTime(150);
			expect(frames).toBe(3);

			selector.handleInput("\x1b[B");
			vi.advanceTimersByTime(150);
			expect(frames).toBe(3);

			selector.handleInput("\x1b[A");
			vi.advanceTimersByTime(100);
			expect(frames).toBe(5);

			selector.dispose();
			vi.advanceTimersByTime(500);
			expect(frames).toBe(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the accent style without a TUI to animate in", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "openrouter", name: "OpenRouter", authType: "api_key" }],
			() => {},
			() => {},
		);

		expect(selector.render(120).join("\n")).toContain(theme.fg("accent", "OpenRouter"));
	});

	it("marks preferred partners with a star", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[
				{ id: "radius", name: "Radius", authType: "oauth", subscription: false },
				{ id: "openrouter", name: "OpenRouter", authType: "api_key" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("→ Radius ✦ • not configured");
		expect(output).toContain("  OpenRouter ✦ • not configured");
		expect(output).toContain("  Anthropic • not configured");
	});

	it("rebuilds the list on render only while a branded row is selected", () => {
		const tui = { requestRender: () => {} } as unknown as TUI;
		const providers = [
			{ id: "radius", name: "Radius", authType: "oauth" as const },
			{ id: "anthropic", name: "Anthropic", authType: "api_key" as const },
		];
		const countRebuilds = (selector: OAuthSelectorComponent, renders: number): number => {
			const updateList = vi.spyOn(selector as unknown as { updateList(): void }, "updateList");
			updateList.mockClear();
			for (let render = 0; render < renders; render++) selector.render(120);
			return updateList.mock.calls.length;
		};
		const animated = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			providers,
			() => {},
			() => {},
			undefined,
			"",
			tui,
		);
		const withoutTui = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			providers,
			() => {},
			() => {},
		);
		try {
			expect(countRebuilds(animated, 3)).toBe(3);
			expect(countRebuilds(withoutTui, 3)).toBe(0);

			animated.handleInput("\x1b[B");
			expect(countRebuilds(animated, 3)).toBe(0);
		} finally {
			animated.dispose();
		}
	});

	it("can be disposed without a TUI and more than once", () => {
		const withoutTui = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "radius", name: "Radius", authType: "oauth" }],
			() => {},
			() => {},
		);
		const withTui = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[{ id: "radius", name: "Radius", authType: "oauth" }],
			() => {},
			() => {},
			undefined,
			"",
			{ requestRender: () => {} } as unknown as TUI,
		);

		expect(() => withoutTui.dispose()).not.toThrow();
		expect(() => {
			withTui.dispose();
			withTui.dispose();
		}).not.toThrow();
	});

	it("styles the selected brand row by the time since the selector was created", () => {
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("dark");
		const now = vi.spyOn(performance, "now");
		try {
			now.mockReturnValue(10_000);
			const selector = new OAuthSelectorComponent(
				"login",
				fakeModelRuntime(),
				[{ id: "radius", name: "Radius", authType: "oauth" }],
				() => {},
				() => {},
				undefined,
				"",
				{ requestRender: () => {} } as unknown as TUI,
			);
			try {
				now.mockReturnValue(10_500);
				expect(selector.render(120).join("\n")).toContain(radiusShimmer("Radius", 500));
				now.mockReturnValue(11_300);
				expect(selector.render(120).join("\n")).toContain(radiusShimmer("Radius", 1_300));
			} finally {
				selector.dispose();
			}
		} finally {
			now.mockRestore();
			vi.unstubAllEnvs();
			initTheme("dark");
		}
	});

	it("keeps the styling of the provider name, star and sign-in method apart", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			fakeModelRuntime(),
			[
				{ id: "openrouter", name: "OpenRouter", authType: "oauth", subscription: false },
				{ id: "openrouter", name: "OpenRouter", authType: "api_key" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			],
			() => {},
			() => {},
		);
		const notConfigured = theme.fg("muted", " • not configured");

		const output = selector.render(120).join("\n");

		expect(output).toContain(
			theme.fg("accent", "OpenRouter") + theme.fg("muted", " ✦") + theme.fg("accent", " · account") + notConfigured,
		);
		expect(output).toContain(
			theme.fg("text", "OpenRouter") + theme.fg("muted", " ✦") + theme.fg("text", " · API key") + notConfigured,
		);
		expect(output).toContain(theme.fg("text", "Anthropic") + notConfigured);
	});

	describe("OpenRouter glow", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			initTheme("dark");
		});

		function glowColor(themeName: string, elapsedMs: number): number[] {
			vi.stubEnv("COLORTERM", "truecolor");
			initTheme(themeName);
			const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(openRouterGlow("OpenRouter", elapsedMs));
			if (!match) throw new Error("expected a truecolor foreground");
			return match.slice(1).map(Number);
		}

		it("is lime on dark themes and violet on light themes", () => {
			const [darkRed, darkGreen, darkBlue] = glowColor("dark", 0);
			expect(darkGreen).toBeGreaterThan(200);
			expect(darkGreen).toBeGreaterThan(darkRed);
			expect(darkBlue).toBeLessThan(120);

			const [lightRed, lightGreen, lightBlue] = glowColor("light", 0);
			expect(lightBlue).toBeGreaterThan(200);
			expect(lightRed).toBeLessThan(120);
			expect(lightGreen).toBeLessThan(80);
		});

		it("breathes toward a brighter color and back over its period", () => {
			const [, baseGreen, baseBlue] = glowColor("dark", 0);
			const [, peakGreen, peakBlue] = glowColor("dark", 1200);
			const [, backGreen, backBlue] = glowColor("dark", 2400);
			expect(peakBlue).toBeGreaterThan(baseBlue + 50);
			expect(peakGreen).toBeGreaterThanOrEqual(baseGreen);
			expect(backGreen).toBe(baseGreen);
			expect(backBlue).toBe(baseBlue);
		});

		it("closes the foreground color after the text", () => {
			expect(openRouterGlow("OpenRouter", 0).endsWith("OpenRouter\x1b[39m")).toBe(true);
		});
	});
});
describe("provider selectors opened by the interactive mode", () => {
	type SelectorFactory = (done: () => void) => { component: unknown; focus: unknown; dispose?: () => void };
	type SelectorHost = {
		ui: { requestRender: () => void };
		session: { modelRuntime: ReturnType<typeof fakeModelRuntime> };
		getLoginProviderOptions: () => Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
		getLogoutProviderOptions: () => Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
		showStatus: () => void;
		showSelector: (create: SelectorFactory) => void;
	};
	const prototype = (
		InteractiveMode as unknown as {
			prototype: {
				showLoginProviderSelector(this: object, authType?: "oauth" | "api_key"): void;
				showOAuthSelector(this: object, mode: "login" | "logout"): Promise<void>;
			};
		}
	).prototype;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createHost(requestRender: () => void, created: Array<ReturnType<SelectorFactory>>): SelectorHost {
		const options = [{ id: "radius", name: "Radius", authType: "oauth" as const }];
		return {
			ui: { requestRender },
			session: { modelRuntime: fakeModelRuntime() },
			getLoginProviderOptions: () => options,
			getLogoutProviderOptions: () => options,
			showStatus: () => {},
			showSelector: (create) => {
				created.push(create(() => {}));
			},
		};
	}

	it("animates the login selector's partner row and stops when the selector is disposed", () => {
		const requestRender = vi.fn();
		const created: Array<ReturnType<SelectorFactory>> = [];

		prototype.showLoginProviderSelector.call(createHost(requestRender, created), "oauth");

		expect(created).toHaveLength(1);
		vi.advanceTimersByTime(100);
		expect(requestRender).toHaveBeenCalledTimes(2);

		created[0]?.dispose?.();
		vi.advanceTimersByTime(500);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("animates the logout selector's partner row and stops when the selector is disposed", async () => {
		const requestRender = vi.fn();
		const created: Array<ReturnType<SelectorFactory>> = [];

		await prototype.showOAuthSelector.call(createHost(requestRender, created), "logout");

		expect(created).toHaveLength(1);
		vi.advanceTimersByTime(100);
		expect(requestRender).toHaveBeenCalledTimes(2);

		created[0]?.dispose?.();
		vi.advanceTimersByTime(500);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
