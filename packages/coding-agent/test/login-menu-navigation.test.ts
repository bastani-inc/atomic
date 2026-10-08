import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import "../src/modes/interactive/interactive-auth-login.ts";
import "../src/modes/interactive/interactive-auth-routing.ts";
import {
	InteractiveModeBase as Base,
	type InteractiveModeBase,
} from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

const accountLogin: AuthSelectorProvider = {
	id: "corp-sso",
	name: "Corporate SSO",
	authType: "oauth",
	subscription: false,
};
const subscriptionLogin: AuthSelectorProvider = {
	id: "claude",
	name: "Claude",
	authType: "oauth",
	subscription: true,
};

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(300).map((line) => stripAnsi(line).trim());
}

function menu() {
	const created: ExtensionSelectorComponent[] = [];
	const harness = {
		ui: { requestRender: vi.fn() },
		showSelector: (create: (done: () => void) => { component: ExtensionSelectorComponent }) => {
			created.push(create(() => {}).component);
		},
		startProviderLogin: vi.fn(),
		showLoginProviderSelector: vi.fn(),
		showLoginAuthTypeSelector: Base.prototype.showLoginAuthTypeSelector,
	};
	return { harness, created };
}

describe("login method menu", () => {
	it("labels an OAuth sign-in without a subscription as an account", () => {
		const { harness, created } = menu();
		const options: AuthSelectorProvider[] = [accountLogin, { ...accountLogin, authType: "api_key" }];

		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase, options);

		const rendered = lines(created[0]!);
		expect(rendered).toContain("→ Use an account");
		expect(rendered).toContain("Use an API key");
		expect(rendered).not.toContain("→ Use a subscription");
	});

	it("keeps the subscription label for a subscription-backed provider", () => {
		const { harness, created } = menu();
		const options: AuthSelectorProvider[] = [subscriptionLogin, { ...subscriptionLogin, authType: "api_key" }];

		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase, options);

		expect(lines(created[0]!)).toContain("→ Use a subscription");
	});

	it("returns to the method choice when a login started from it is cancelled", () => {
		const { harness, created } = menu();
		const options: AuthSelectorProvider[] = [accountLogin, { ...accountLogin, authType: "api_key" }];
		Base.prototype.showLoginAuthTypeSelector.call(harness as unknown as InteractiveModeBase, options);

		created[0]!.handleInput(ENTER);

		expect(harness.startProviderLogin).toHaveBeenCalledTimes(1);
		const [option, onBack] = harness.startProviderLogin.mock.calls[0] as [AuthSelectorProvider, () => void];
		expect(option).toBe(options[0]);
		onBack();
		expect(created).toHaveLength(2);
		expect(lines(created[1]!)).toContain("→ Use an account");
	});
});

describe("cancelled sign-in", () => {
	function loginHarness(loginError: Error) {
		return {
			programStatus: { setBlocked: vi.fn() },
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

		await Base.prototype.showLoginDialog.call(
			harness as unknown as InteractiveModeBase,
			"corp-sso",
			"Corporate SSO",
			onBack,
		);

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

		await Base.prototype.showLoginDialog.call(
			harness as unknown as InteractiveModeBase,
			"corp-sso",
			"Corporate SSO",
			onBack,
		);

		expect(onBack).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Failed to login to Corporate SSO: denied by provider");
	});
});

describe("empty login provider picker", () => {
	it("reports that no account providers are available for OAuth", () => {
		const harness = { getLoginProviderOptions: () => [], showStatus: vi.fn() };

		Base.prototype.showLoginProviderSelector.call(harness as unknown as InteractiveModeBase, "oauth");

		expect(harness.showStatus).toHaveBeenCalledWith("No account providers available.");
	});
});
