import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { RADIUS_MCP_URL } from "../src/core/radius.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import { createLoginMenuSelector } from "../src/modes/interactive/components/radius-login-selector.ts";
import {
	InteractiveModeBase as Base,
	type InteractiveModeBase,
} from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-auth-login.ts";
import "../src/modes/interactive/interactive-auth-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const radiusOAuth: AuthSelectorProvider = { id: "radius", name: "Radius", authType: "oauth", subscription: false };

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(300).map((line) => stripAnsi(line).trim());
}

describe("top-level /login menu", () => {
	function menu(authStatus: { configured: boolean; source?: string } = { configured: false }) {
		const created: Array<{ component: ExtensionSelectorComponent; dispose?: () => void }> = [];
		const harness = {
			ui: { requestRender: vi.fn() },
			session: {
				modelRuntime: {
					getProviderAuthStatus: () => authStatus,
					getStoredCredentialType: () => "oauth" as const,
				},
			},
			getLoginProviderOptions: () => [radiusOAuth],
			showSelector: (
				create: (done: () => void) => { component: ExtensionSelectorComponent; dispose?: () => void },
			) => {
				created.push(create(() => {}));
			},
			startProviderLogin: vi.fn(),
			showLoginProviderSelector: vi.fn(),
			showLoginAuthTypeSelector: Base.prototype.showLoginAuthTypeSelector,
		};
		return { harness, created };
	}

	it("offers Sign in with Radius as the last option with its configuration status", () => {
		const { harness, created } = menu({ configured: true, source: "stored" });

		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase);

		const rendered = lines(created[0]!.component);
		expect(rendered).toContain("→ Use a subscription");
		expect(rendered).toContain("Use an API key");
		expect(rendered).toContain("Sign in with Radius ✓ account configured");
		expect(rendered.indexOf("Use an API key")).toBeLessThan(
			rendered.indexOf("Sign in with Radius ✓ account configured"),
		);
	});

	it("starts the Radius sign-in and reopens the menu when the sign-in is cancelled", () => {
		const { harness, created } = menu();
		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase);

		created[0]!.component.handleInput(DOWN);
		created[0]!.component.handleInput(DOWN);
		created[0]!.component.handleInput(ENTER);

		expect(harness.startProviderLogin).toHaveBeenCalledTimes(1);
		const [option, onBack] = harness.startProviderLogin.mock.calls[0] as [AuthSelectorProvider, () => void];
		expect(option).toBe(radiusOAuth);
		onBack();
		expect(created).toHaveLength(2);
		expect(lines(created[1]!.component)).toContain("Sign in with Radius • not configured");
	});

	it("keeps the plain menu for a provider that has no Radius option", () => {
		const { harness, created } = menu();
		harness.getLoginProviderOptions = () => [];

		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase);

		expect(lines(created[0]!.component).some((line) => line.includes("Radius"))).toBe(false);
	});

	it("does not offer Radius while choosing a method for one provider and labels an account sign-in as an account", () => {
		const { harness, created } = menu();
		const options: AuthSelectorProvider[] = [radiusOAuth, { ...radiusOAuth, authType: "api_key" }];

		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase, options);

		const rendered = lines(created[0]!.component);
		expect(rendered).toContain("→ Use an account");
		expect(rendered).toContain("Use an API key");
		expect(rendered.some((line) => line.includes("Sign in with Radius"))).toBe(false);
	});

	it("returns to the method choice when a login started from it is cancelled", () => {
		const { harness, created } = menu();
		const options: AuthSelectorProvider[] = [radiusOAuth, { ...radiusOAuth, authType: "api_key" }];
		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase, options);

		created[0]!.component.handleInput(ENTER);

		const [, onBack] = harness.startProviderLogin.mock.calls[0] as [AuthSelectorProvider, () => void];
		onBack();
		expect(created).toHaveLength(2);
	});
});

describe("Radius login menu selector", () => {
	const label = "Sign in with Radius • not configured";
	const radiusOption = { label, text: "Sign in with Radius" };
	const options = ["Use a subscription", "Use an API key", label];

	function build(tui: TUI = { requestRender: vi.fn() } as unknown as TUI) {
		return createLoginMenuSelector(tui, "Select authentication method:", options, radiusOption, vi.fn(), vi.fn());
	}

	function base() {
		return new ExtensionSelectorComponent("Select authentication method:", options, vi.fn(), vi.fn());
	}

	it("renders like the plain selector until the Radius option is selected", () => {
		const selector = build();
		const plain = base();
		try {
			expect(selector.render(100)).toEqual(plain.render(100));
		} finally {
			selector.dispose();
		}
	});

	it("colors the selected Radius option without changing its text", () => {
		const selector = build();
		const plain = base();
		try {
			for (const component of [selector, plain]) {
				component.handleInput(DOWN);
				component.handleInput(DOWN);
			}
			const animated = selector.render(100);
			const unanimated = plain.render(100);
			expect(animated).not.toEqual(unanimated);
			expect(animated.map(stripAnsi)).toEqual(unanimated.map(stripAnsi));
		} finally {
			selector.dispose();
		}
	});

	it("requests renders while the Radius option is selected and stops after dispose", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const selector = build({ requestRender } as unknown as TUI);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.render(100);

		vi.advanceTimersByTime(200);
		expect(requestRender).toHaveBeenCalled();

		selector.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(200);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not animate while another option is selected", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const selector = build({ requestRender } as unknown as TUI);
		selector.render(100);

		vi.advanceTimersByTime(200);

		expect(requestRender).not.toHaveBeenCalled();
		selector.dispose();
	});
});

describe("Radius sign-in prompt", () => {
	function selectHarness() {
		return {
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		};
	}

	const prompt = {
		type: "select" as const,
		message: "Choose a sign-in method",
		options: [
			{ id: "browser", label: "Browser" },
			{ id: "device", label: "Device code" },
		],
	};

	it("introduces Radius when its sign-in asks for a method", () => {
		const harness = selectHarness();
		void Base.prototype.showOAuthLoginSelect.call(
			harness as unknown as InteractiveModeBase,
			{} as never,
			prompt as never,
			"radius",
		);

		const selector = harness.editorContainer.addChild.mock.calls[0]![0] as ExtensionSelectorComponent;
		expect(lines(selector).join("\n")).toContain("Radius is a hosted model gateway built by Earendil Works.");
	});

	it("adds no introduction to another provider's method choice", () => {
		const harness = selectHarness();
		void Base.prototype.showOAuthLoginSelect.call(
			harness as unknown as InteractiveModeBase,
			{} as never,
			prompt as never,
			"anthropic",
		);

		const selector = harness.editorContainer.addChild.mock.calls[0]![0] as ExtensionSelectorComponent;
		expect(lines(selector).join("\n")).not.toContain("Radius");
	});
});

describe("Radius MCP server offer", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "atomic-radius-mcp-"));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function offer() {
		const created: ExtensionSelectorComponent[] = [];
		const harness = {
			ui: { requestRender: vi.fn() },
			sessionManager: { getCwd: () => agentDir },
			showSelector: (create: (done: () => void) => { component: ExtensionSelectorComponent }) => {
				created.push(create(() => {}).component);
			},
			showError: vi.fn(),
			handleReloadCommand: vi.fn(async () => {}),
		};
		Base.prototype.offerRadiusMcpServer.call(harness as unknown as InteractiveModeBase, "radius", "Radius");
		return { harness, created };
	}

	function writeConfig(config: unknown): string {
		const path = join(agentDir, "mcp.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2));
		return path;
	}

	function readConfig(): { mcpServers: Record<string, unknown> } {
		return JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
	}

	it("adds the Radius server to the global mcp.json and reloads after a yes", () => {
		const { harness, created } = offer();

		expect(lines(created[0]!)).toContain(`Configure Radius MCP in ${join(agentDir, "mcp.json")}?`);
		created[0]!.handleInput(ENTER);

		expect(readConfig()).toEqual({ mcpServers: { radius: { url: RADIUS_MCP_URL, auth: { provider: "radius" } } } });
		expect(harness.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	it("leaves mcp.json alone after a no", () => {
		const { harness, created } = offer();

		created[0]!.handleInput(DOWN);
		created[0]!.handleInput(ENTER);

		expect(() => readConfig()).toThrow();
		expect(harness.handleReloadCommand).not.toHaveBeenCalled();
	});

	it("asks nothing when a global server already uses the Radius login", () => {
		writeConfig({ mcpServers: { work: { url: `${RADIUS_MCP_URL}/`, auth: { provider: "radius" } } } });

		const { created } = offer();

		expect(created).toHaveLength(0);
	});

	it("switches an existing Radius server from MCP sign-in to the Radius login and keeps its other settings", () => {
		writeConfig({
			mcpServers: { work: { url: RADIUS_MCP_URL, oauth: { clientName: "Work" }, exposure: "direct" } },
		});

		const { created } = offer();
		created[0]!.handleInput(ENTER);

		expect(readConfig().mcpServers).toEqual({
			work: { url: RADIUS_MCP_URL, exposure: "direct", auth: { provider: "radius" } },
		});
	});

	it("picks another name when an unrelated server is already called radius", () => {
		writeConfig({ mcpServers: { radius: { command: "radius-local" } } });

		const { created } = offer();
		created[0]!.handleInput(ENTER);

		expect(readConfig().mcpServers).toEqual({
			radius: { command: "radius-local" },
			"radius-mcp": { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
		});
	});

	it("reports an mcp.json it cannot update instead of reloading", () => {
		writeConfig({ mcpServers: [] });

		const { harness, created } = offer();
		created[0]!.handleInput(ENTER);

		expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("Could not update"));
		expect(harness.handleReloadCommand).not.toHaveBeenCalled();
	});
});

describe("cancelled sign-in", () => {
	function loginHarness(loginError: Error) {
		return {
			session: { model: undefined },
			runtimeHost: {
				loginOAuthProvider: async () => {
					throw loginError;
				},
				loginApiKeyProvider: async () => {
					throw loginError;
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			showError: vi.fn(),
			completeProviderAuthentication: vi.fn(),
			showOAuthLoginSelect: vi.fn(),
		};
	}

	const cancelled = () => new DOMException("The operation was aborted.", "AbortError");

	it("goes back after an OAuth login is cancelled", async () => {
		const harness = loginHarness(cancelled());
		const onBack = vi.fn();

		await Base.prototype.showLoginDialog.call(harness as unknown as InteractiveModeBase, "radius", "Radius", onBack);

		expect(onBack).toHaveBeenCalledTimes(1);
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("goes back after an API-key login is cancelled", async () => {
		const harness = loginHarness(cancelled());
		const onBack = vi.fn();

		await Base.prototype.showApiKeyLoginDialog.call(
			harness as unknown as InteractiveModeBase,
			"openai",
			"OpenAI",
			onBack,
		);

		expect(onBack).toHaveBeenCalledTimes(1);
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("stays where it is and shows the error when a login fails", async () => {
		const harness = loginHarness(new Error("denied by provider"));
		const onBack = vi.fn();

		await Base.prototype.showLoginDialog.call(harness as unknown as InteractiveModeBase, "radius", "Radius", onBack);

		expect(onBack).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Failed to login to Radius: denied by provider");
	});
});
