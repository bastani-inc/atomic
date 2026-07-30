import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthStatus } from "../../core/provider-composer.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type AuthSelectorProvider,
	ExtensionSelectorComponent,
	OAuthSelectorComponent,
} from "./interactive-mode-deps.ts";
import { BEDROCK_PROVIDER_ID } from "./interactive-mode-helpers.ts";
import { resolveLoginProviderReference } from "./login-provider-options.ts";

export function formatLogoutStatus(
	providerName: string,
	authType: "oauth" | "api_key",
	authStatus: AuthStatus,
): string {
	const action = authType === "oauth" ? `Logged out of ${providerName}` : `Removed stored API key for ${providerName}`;
	return authStatus.source
		? `${action}. Authentication remains active through ${authStatus.label ?? authStatus.source}.`
		: action;
}

export function getBuiltinApiKeyLoginOptions(getDisplayName: (providerId: string) => string): AuthSelectorProvider[] {
	return builtinProviders()
		.filter((provider) => provider.auth.apiKey !== undefined)
		.map((provider) => ({
			id: provider.id,
			name: getDisplayName(provider.id),
			authType: "api_key" as const,
		}));
}

InteractiveModeBase.prototype.getLoginProviderOptions = function (
	this: InteractiveModeBase,
	authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = this.session.modelRuntime
		.getOAuthProviderMetadata()
		.map((provider) => ({ id: provider.id, name: provider.name, authType: "oauth" as const }));
	for (const provider of this.session.modelRuntime.getProviders()) {
		if (provider.auth.apiKey)
			options.push({ id: provider.id, name: provider.name ?? provider.id, authType: "api_key" });
	}
	return (authType ? options.filter((option) => option.authType === authType) : options).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
};
InteractiveModeBase.prototype.getLogoutProviderOptions = function (this: InteractiveModeBase): AuthSelectorProvider[] {
	const runtime = this.session.modelRuntime;
	const providers = runtime.getProviders();
	const providerNames = new Map(providers.map((provider) => [provider.id, provider.name ?? provider.id]));
	for (const provider of runtime.getOAuthProviderMetadata()) providerNames.set(provider.id, provider.name);
	const options: AuthSelectorProvider[] = [];
	for (const [providerId, name] of providerNames) {
		if (runtime.getProviderAuthStatus(providerId).source !== "stored") continue;
		const authType = runtime.getStoredCredentialType(providerId);
		if (authType) options.push({ id: providerId, name, authType });
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
};

InteractiveModeBase.prototype.startProviderLogin = async function (
	this: InteractiveModeBase,
	providerOption: AuthSelectorProvider,
): Promise<void> {
	if (providerOption.authType === "oauth") {
		await this.showLoginDialog(providerOption.id, providerOption.name);
	} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
		this.showBedrockSetupDialog(providerOption.id, providerOption.name);
	} else {
		await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
	}
};

InteractiveModeBase.prototype.handleLoginCommand = async function (
	this: InteractiveModeBase,
	providerRef?: string,
): Promise<void> {
	if (!providerRef?.trim()) {
		this.showLoginAuthTypeSelector();
		return;
	}
	const resolution = resolveLoginProviderReference(this.getLoginProviderOptions(), providerRef);
	if (resolution.kind === "direct") {
		await this.startProviderLogin(resolution.option);
	} else if (resolution.kind === "choose_method") {
		this.showLoginAuthTypeSelector(resolution.options);
	} else {
		this.showLoginProviderSelector(undefined, resolution.initialSearch);
	}
};

InteractiveModeBase.prototype.showLoginAuthTypeSelector = function (
	this: InteractiveModeBase,
	providerOptions?: AuthSelectorProvider[],
): void {
	const subscriptionLabel = "Use a subscription";
	const apiKeyLabel = "Use an API key";
	const choices = providerOptions
		? providerOptions.map((provider) => (provider.authType === "oauth" ? subscriptionLabel : apiKeyLabel))
		: [subscriptionLabel, apiKeyLabel];
	this.showSelector((done) => {
		const selector = new ExtensionSelectorComponent(
			"Select authentication method:",
			choices,
			(option) => {
				done();
				const authType = option === subscriptionLabel ? "oauth" : "api_key";
				const directOption = providerOptions?.find((provider) => provider.authType === authType);
				if (directOption) void this.startProviderLogin(directOption);
				else this.showLoginProviderSelector(authType);
			},
			() => {
				done();
				this.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
};

InteractiveModeBase.prototype.showLoginProviderSelector = function (
	this: InteractiveModeBase,
	authType?: "oauth" | "api_key",
	initialSearchInput?: string,
): void {
	const providerOptions = this.getLoginProviderOptions(authType);
	if (providerOptions.length === 0) {
		const message =
			authType === "oauth"
				? "No subscription providers available."
				: authType === "api_key"
					? "No API key providers available."
					: "No login providers available.";
		this.showStatus(message);
		return;
	}

	this.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			"login",
			this.session.modelRuntime,
			providerOptions,
			async (providerId, selectedAuthType) => {
				done();
				const providerOption = providerOptions.find(
					(provider) => provider.id === providerId && provider.authType === selectedAuthType,
				);
				if (providerOption) await this.startProviderLogin(providerOption);
			},
			() => {
				done();
				if (authType) this.showLoginAuthTypeSelector();
				else this.ui.requestRender();
			},
			(providerId) => this.session.modelRuntime.getProviderAuthStatus(providerId),
			initialSearchInput,
		);
		return { component: selector, focus: selector };
	});
};

InteractiveModeBase.prototype.showOAuthSelector = async function (
	this: InteractiveModeBase,
	mode: "login" | "logout",
): Promise<void> {
	if (mode === "login") {
		this.showLoginAuthTypeSelector();
		return;
	}
	const providerOptions = this.getLogoutProviderOptions();
	if (providerOptions.length === 0) {
		this.showStatus(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		);
		return;
	}
	this.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			mode,
			this.session.modelRuntime,
			providerOptions,
			async (providerId, selectedAuthType) => {
				done();
				const providerOption = providerOptions.find(
					(provider) => provider.id === providerId && provider.authType === selectedAuthType,
				);
				if (!providerOption) return;
				try {
					const result = await this.runtimeHost.logoutProvider(providerOption.id);
					await this.updateAvailableProviderCount();
					this.setupAutocompleteProvider();
					this.showStatus(formatLogoutStatus(providerOption.name, providerOption.authType, result.authStatus));
				} catch (error: unknown) {
					this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			() => {
				done();
				this.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
};
