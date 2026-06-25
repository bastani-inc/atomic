import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type AuthSelectorProvider, ExtensionSelectorComponent, OAuthSelectorComponent } from "./interactive-mode-deps.ts";
import { BEDROCK_PROVIDER_ID, isApiKeyLoginProvider } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.getLoginProviderOptions = function(this: InteractiveModeBase, authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
    const authStorage = this.session.modelRegistry.authStorage;
    const oauthProviders = authStorage.getOAuthProviders();
    const oauthProviderIds = new Set(
      oauthProviders.map((provider) => provider.id),
    );
    const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      authType: "oauth",
    }));

    const modelProviders = new Set(
      this.session.modelRegistry.getAll().map((model) => model.provider),
    );
    for (const providerId of modelProviders) {
      if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
        continue;
      }
      options.push({
        id: providerId,
        name: this.session.modelRegistry.getProviderDisplayName(providerId),
        authType: "api_key",
      });
    }

    const filteredOptions = authType
      ? options.filter((option) => option.authType === authType)
      : options;
    return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
  };

InteractiveModeBase.prototype.getLogoutProviderOptions = function(this: InteractiveModeBase): AuthSelectorProvider[] {
    const authStorage = this.session.modelRegistry.authStorage;
    const options: AuthSelectorProvider[] = [];

    for (const providerId of authStorage.list()) {
      const credential = authStorage.get(providerId);
      if (!credential) {
        continue;
      }
      options.push({
        id: providerId,
        name: this.session.modelRegistry.getProviderDisplayName(providerId),
        authType: credential.type,
      });
    }

    return options.sort((a, b) => a.name.localeCompare(b.name));
  };

InteractiveModeBase.prototype.showLoginAuthTypeSelector = function(this: InteractiveModeBase): void {
    const subscriptionLabel = "Use a subscription";
    const apiKeyLabel = "Use an API key";
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Select authentication method:",
        [subscriptionLabel, apiKeyLabel],
        (option) => {
          done();
          const authType = option === subscriptionLabel ? "oauth" : "api_key";
          this.showLoginProviderSelector(authType);
        },
        () => {
          done();
          this.ui.requestRender();
        },
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showLoginProviderSelector = function(this: InteractiveModeBase, authType: "oauth" | "api_key"): void {
    const providerOptions = this.getLoginProviderOptions(authType);
    if (providerOptions.length === 0) {
      this.showStatus(
        authType === "oauth"
          ? "No subscription providers available."
          : "No API key providers available.",
      );
      return;
    }

    this.showSelector((done) => {
      const selector = new OAuthSelectorComponent(
        "login",
        this.session.modelRegistry.authStorage,
        providerOptions,
        async (providerId: string) => {
          done();

          const providerOption = providerOptions.find(
            (provider) => provider.id === providerId,
          );
          if (!providerOption) {
            return;
          }

          if (providerOption.authType === "oauth") {
            await this.showLoginDialog(providerOption.id, providerOption.name);
          } else if (providerOption.id === BEDROCK_PROVIDER_ID) {
            this.showBedrockSetupDialog(providerOption.id, providerOption.name);
          } else {
            await this.showApiKeyLoginDialog(
              providerOption.id,
              providerOption.name,
            );
          }
        },
        () => {
          done();
          this.showLoginAuthTypeSelector();
        },
        (providerId) =>
          this.session.modelRegistry.getProviderAuthStatus(providerId),
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showOAuthSelector = async function(this: InteractiveModeBase, mode: "login" | "logout"): Promise<void> {
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
        async (providerId: string) => {
          done();

          const providerOption = providerOptions.find(
            (provider) => provider.id === providerId,
          );
          if (!providerOption) {
            return;
          }

          try {
            this.session.modelRegistry.authStorage.logout(providerOption.id);
            this.session.modelRegistry.refresh();
            await this.updateAvailableProviderCount();
            this.setupAutocompleteProvider();
            const message =
              providerOption.authType === "oauth"
                ? `Logged out of ${providerOption.name}`
                : `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
            this.showStatus(message);
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
