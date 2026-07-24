import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthStatus } from "../../core/auth-storage.ts";
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
  const action = authType === "oauth"
    ? `Logged out of ${providerName}`
    : `Removed stored API key for ${providerName}`;
  return authStatus.source
    ? `${action}. Authentication remains active through ${authStatus.label ?? authStatus.source}.`
    : action;
}

export function getBuiltinApiKeyLoginOptions(
  getDisplayName: (providerId: string) => string,
): AuthSelectorProvider[] {
  return builtinProviders()
    .filter((provider) => provider.auth.apiKey !== undefined)
    .map((provider) => ({
      id: provider.id,
      name: getDisplayName(provider.id),
      authType: "api_key" as const,
    }));
}

InteractiveModeBase.prototype.getLoginProviderOptions = function(
  this: InteractiveModeBase,
  authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
  const authStorage = this.session.modelRegistry.authStorage;
  const oauthProviders = authStorage.getOAuthProviders();
  const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
    id: provider.id,
    name: this.session.modelRegistry.getProviderDisplayName(provider.id),
    authType: "oauth",
  }));

  const builtins = builtinProviders();
  const builtinIds = new Set(builtins.map((provider) => provider.id));
  options.push(...getBuiltinApiKeyLoginOptions(
    (providerId) => this.session.modelRegistry.getProviderDisplayName(providerId),
  ));
  const customApiKeyProviders = this.session.modelRegistry.getCustomApiKeyAuthProviders();
  const customApiKeyProviderIds = new Set(customApiKeyProviders.map((provider) => provider.id));
  options.push(...customApiKeyProviders.map((provider) => ({
    ...provider,
    authType: "api_key" as const,
  })));

  // Legacy extension/config providers do not expose pi-ai auth metadata. Keep
  // Atomic's existing API-key behavior for model-backed, non-OAuth providers.
  const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
  const modelProviderIds = new Set(
    this.session.modelRegistry.getAll().map((model) => model.provider),
  );
  for (const providerId of modelProviderIds) {
    if (builtinIds.has(providerId) || oauthProviderIds.has(providerId) || customApiKeyProviderIds.has(providerId)) continue;
    options.push({
      id: providerId,
      name: this.session.modelRegistry.getProviderDisplayName(providerId),
      authType: "api_key",
    });
  }

  const filtered = authType
    ? options.filter((option) => option.authType === authType)
    : options;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
};

InteractiveModeBase.prototype.getLogoutProviderOptions = function(
  this: InteractiveModeBase,
): AuthSelectorProvider[] {
  const authStorage = this.session.modelRegistry.authStorage;
  const supportedProviderIds = new Set(
    this.getLoginProviderOptions().map((provider) => provider.id),
  );
  const options: AuthSelectorProvider[] = [];
  for (const providerId of authStorage.list()) {
    if (!supportedProviderIds.has(providerId)) continue;
    const credential = authStorage.get(providerId);
    if (!credential) continue;
    options.push({
      id: providerId,
      name: this.session.modelRegistry.getProviderDisplayName(providerId),
      authType: credential.type,
    });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
};

InteractiveModeBase.prototype.startProviderLogin = async function(
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

InteractiveModeBase.prototype.handleLoginCommand = async function(
  this: InteractiveModeBase,
  providerRef?: string,
): Promise<void> {
  if (!providerRef?.trim()) {
    this.showLoginAuthTypeSelector();
    return;
  }
  const resolution = resolveLoginProviderReference(
    this.getLoginProviderOptions(),
    providerRef,
  );
  if (resolution.kind === "direct") {
    await this.startProviderLogin(resolution.option);
  } else if (resolution.kind === "choose_method") {
    this.showLoginAuthTypeSelector(resolution.options);
  } else {
    this.showLoginProviderSelector(undefined, resolution.initialSearch);
  }
};

InteractiveModeBase.prototype.showLoginAuthTypeSelector = function(
  this: InteractiveModeBase,
  providerOptions?: AuthSelectorProvider[],
): void {
  const subscriptionLabel = "Use a subscription";
  const apiKeyLabel = "Use an API key";
  const choices = providerOptions
    ? providerOptions.map((provider) =>
        provider.authType === "oauth" ? subscriptionLabel : apiKeyLabel
      )
    : [subscriptionLabel, apiKeyLabel];
  this.showSelector((done) => {
    const selector = new ExtensionSelectorComponent(
      "Select authentication method:",
      choices,
      (option) => {
        done();
        const authType = option === subscriptionLabel ? "oauth" : "api_key";
        const directOption = providerOptions?.find(
          (provider) => provider.authType === authType,
        );
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

InteractiveModeBase.prototype.showLoginProviderSelector = function(
  this: InteractiveModeBase,
  authType?: "oauth" | "api_key",
  initialSearchInput?: string,
): void {
  const providerOptions = this.getLoginProviderOptions(authType);
  if (providerOptions.length === 0) {
    const message = authType === "oauth"
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
      this.session.modelRegistry.authStorage,
      providerOptions,
      async (providerId, selectedAuthType) => {
        done();
        const providerOption = providerOptions.find(
          (provider) =>
            provider.id === providerId && provider.authType === selectedAuthType,
        );
        if (providerOption) await this.startProviderLogin(providerOption);
      },
      () => {
        done();
        if (authType) this.showLoginAuthTypeSelector();
        else this.ui.requestRender();
      },
      (providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
      initialSearchInput,
    );
    return { component: selector, focus: selector };
  });
};

InteractiveModeBase.prototype.showOAuthSelector = async function(
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
      this.session.modelRegistry.authStorage,
      providerOptions,
      async (providerId, selectedAuthType) => {
        done();
        const providerOption = providerOptions.find(
          (provider) =>
            provider.id === providerId && provider.authType === selectedAuthType,
        );
        if (!providerOption) return;
        try {
          const result = await this.runtimeHost.logoutProvider(providerOption.id);
          await this.updateAvailableProviderCount();
          this.setupAutocompleteProvider();
          this.showStatus(formatLogoutStatus(
            providerOption.name,
            providerOption.authType,
            result.authStatus,
          ));
        } catch (error: unknown) {
          this.showError(
            `Logout failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
