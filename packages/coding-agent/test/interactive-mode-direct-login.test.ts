import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type DirectLoginContext = {
	getLoginProviderOptions: () => { id: string; name: string; authType: "oauth" | "api_key" }[];
	showLoginDialog: (providerId: string, providerName: string) => Promise<void>;
	showApiKeyLoginDialog: (providerId: string, providerName: string) => Promise<void>;
	showBedrockSetupDialog: (providerId: string, providerName: string) => void;
	showOAuthSelector: (mode: "login" | "logout") => void;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	loginProviderByIdOrName(this: DirectLoginContext, query: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode direct /login provider dispatch", () => {
	it("resolves an OAuth provider by id without opening the selector", async () => {
		const context: DirectLoginContext = {
			getLoginProviderOptions: () => [{ id: "cursor", name: "Cursor", authType: "oauth" }],
			showLoginDialog: vi.fn(async () => {}),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			showBedrockSetupDialog: vi.fn(),
			showOAuthSelector: vi.fn(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.loginProviderByIdOrName.call(context, "cursor");

		expect(context.showLoginDialog).toHaveBeenCalledWith("cursor", "Cursor");
		expect(context.showOAuthSelector).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("resolves a provider by display name case-insensitively", async () => {
		const context: DirectLoginContext = {
			getLoginProviderOptions: () => [{ id: "cursor", name: "Cursor", authType: "oauth" }],
			showLoginDialog: vi.fn(async () => {}),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			showBedrockSetupDialog: vi.fn(),
			showOAuthSelector: vi.fn(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.loginProviderByIdOrName.call(context, "cUrSoR");

		expect(context.showLoginDialog).toHaveBeenCalledWith("cursor", "Cursor");
	});

	it("shows an actionable error when no provider matches", async () => {
		const context: DirectLoginContext = {
			getLoginProviderOptions: () => [{ id: "anthropic", name: "Anthropic", authType: "oauth" }],
			showLoginDialog: vi.fn(async () => {}),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			showBedrockSetupDialog: vi.fn(),
			showOAuthSelector: vi.fn(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.loginProviderByIdOrName.call(context, "cursor");

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining('No login provider found matching "cursor"'));
		expect(context.showLoginDialog).not.toHaveBeenCalled();
	});
});
