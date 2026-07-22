import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Api, type Model, type OAuthProviderId, type OAuthSelectPrompt, path, getAuthPath, getDocsPath, defaultModelPerProvider, ExtensionSelectorComponent, LoginDialogComponent, theme } from "./interactive-mode-deps.ts";
import { hasDefaultModelProvider, isUnknownModel } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.completeProviderAuthentication = async function(this: InteractiveModeBase, providerId: string, providerName: string, authType: "oauth" | "api_key", previousModel: Model<Api> | undefined): Promise<void> {
    await this.session.modelRegistry.refresh();

    const actionLabel =
      authType === "oauth"
        ? `Logged in to ${providerName}`
        : `Saved API key for ${providerName}`;

    let selectedModel: Model<Api> | undefined;
    let selectionError: string | undefined;
    if (isUnknownModel(previousModel)) {
      const availableModels = this.session.modelRegistry.getAvailable();
      const providerModels = availableModels.filter(
        (model) => model.provider === providerId,
      );
      if (!hasDefaultModelProvider(providerId)) {
        selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
      } else if (providerModels.length === 0) {
        selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
      } else {
        const defaultModelId = defaultModelPerProvider[providerId];
        selectedModel = providerModels.find(
          (model) => model.id === defaultModelId,
        );
        if (!selectedModel) {
          selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
        } else {
          try {
            await this.session.setModel(selectedModel);
          } catch (error: unknown) {
            selectedModel = undefined;
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
          }
        }
      }
    }

    await this.updateAvailableProviderCount();
    this.setupAutocompleteProvider();
    this.footer.invalidate();
    this.updateEditorBorderColor();
    if (selectedModel) {
      this.showStatus(
        `${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`,
      );
      void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
      this.checkDaxnutsEasterEgg(selectedModel);
    } else {
      this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
      if (selectionError) {
        this.showError(selectionError);
      } else {
        void this.maybeWarnAboutAnthropicSubscriptionAuth();
      }
    }

  };

InteractiveModeBase.prototype.showBedrockSetupDialog = function(this: InteractiveModeBase, providerId: string, providerName: string): void {
    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    const dialog = new LoginDialogComponent(
      this.ui,
      providerId,
      () => restoreEditor(),
      providerName,
      "Amazon Bedrock setup",
    );
    dialog.showDetails([
      theme.fg(
        "text",
        "Amazon Bedrock uses AWS credentials instead of a single API key.",
      ),
      theme.fg(
        "text",
        "Configure an AWS profile, IAM keys, bearer token, or role-based credentials.",
      ),
      theme.fg("muted", "See:"),
      theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
    ]);

    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showApiKeyLoginDialog = async function(this: InteractiveModeBase, providerId: string, providerName: string): Promise<void> {
    const previousModel = this.session.model;

    const dialog = new LoginDialogComponent(
      this.ui,
      providerId,
      (_success, _message) => {
        // Completion handled below
      },
      providerName,
    );

    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();

    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    try {
      const customAuth = this.session.modelRegistry.getCustomApiKeyAuth(providerId);
      if (customAuth) {
        const credential = await customAuth.login({
          signal: dialog.signal,
          prompt: (prompt) => dialog.showPrompt(prompt.message, prompt.placeholder),
        });
        this.session.modelRegistry.authStorage.set(providerId, credential);
      } else {
        const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
        if (!apiKey) throw new Error("API key cannot be empty.");
        this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
      }

      restoreEditor();
      await this.completeProviderAuthentication(
        providerId,
        providerName,
        "api_key",
        previousModel,
      );
    } catch (error: unknown) {
      restoreEditor();
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg !== "Login cancelled") {
        this.showError(
          `Failed to save API key for ${providerName}: ${errorMsg}`,
        );
      }
    }
  };

InteractiveModeBase.prototype.showOAuthLoginSelect = function(this: InteractiveModeBase, dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
    return new Promise((resolve) => {
      const restoreDialog = () => {
        this.editorContainer.clear();
        this.editorContainer.addChild(dialog);
        this.ui.setFocus(dialog);
        this.ui.requestRender();
      };
      const labels = prompt.options.map((option) => option.label);
      const selector = new ExtensionSelectorComponent(
        prompt.message,
        labels,
        (optionLabel) => {
          restoreDialog();
          resolve(
            prompt.options.find((option) => option.label === optionLabel)?.id,
          );
        },
        () => {
          restoreDialog();
          resolve(undefined);
        },
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(selector);
      this.ui.setFocus(selector);
      this.ui.requestRender();
    });
  };

InteractiveModeBase.prototype.showLoginDialog = async function(this: InteractiveModeBase, providerId: string, providerName: string): Promise<void> {
    const providerInfo = this.session.modelRegistry.authStorage
      .getOAuthProviders()
      .find((provider) => provider.id === providerId);
    const previousModel = this.session.model;

    // Providers that use callback servers (can paste redirect URL)
    const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

    // Create login dialog component
    const dialog = new LoginDialogComponent(
      this.ui,
      providerId,
      (_success, _message) => {
        // Completion handled below
      },
      providerName,
    );

    // Show dialog in editor container
    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();

    // Promise for manual code input (racing with callback server)
    let manualCodeResolve: ((code: string) => void) | undefined;
    let manualCodeReject: ((err: Error) => void) | undefined;
    const manualCodePromise = new Promise<string>((resolve, reject) => {
      manualCodeResolve = resolve;
      manualCodeReject = reject;
    });

    // Restore editor helper
    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };

    try {
      await this.session.modelRegistry.authStorage.login(
        providerId as OAuthProviderId,
        {
          onAuth: (info: { url: string; instructions?: string }) => {
            dialog.showAuth(info.url, info.instructions, {
              showCancelHint: !usesCallbackServer,
            });

            if (usesCallbackServer) {
              // Show input for manual paste, racing with callback
              dialog
                .showManualInput(
                  "Paste redirect URL below, or complete login in browser:",
                )
                .then((value) => {
                  if (value && manualCodeResolve) {
                    manualCodeResolve(value);
                    manualCodeResolve = undefined;
                  }
                })
                .catch(() => {
                  if (manualCodeReject) {
                    manualCodeReject(new Error("Login cancelled"));
                    manualCodeReject = undefined;
                  }
                });
            }
            // For Anthropic: onPrompt is called immediately after
          },

          onDeviceCode: (info) => {
            dialog.showDeviceCode(info);
            dialog.showWaiting("Waiting for authentication...");
          },

          onPrompt: async (prompt: {
            message: string;
            placeholder?: string;
          }) => {
            return dialog.showPrompt(prompt.message, prompt.placeholder);
          },

          onProgress: (message: string) => {
            dialog.showProgress(message);
          },

          onInfo: (message, links) => {
            dialog.showInfo(message, links);
          },

          onSelect: (prompt: OAuthSelectPrompt) =>
            this.showOAuthLoginSelect(dialog, prompt),

          onManualCodeInput: () => manualCodePromise,

          onManualCodeCancel: () => {
            dialog.dismissPendingInput();
            manualCodeResolve?.("");
            manualCodeResolve = undefined;
            manualCodeReject = undefined;
          },

          signal: dialog.signal,
        },
      );

      // Success
      restoreEditor();
      await this.completeProviderAuthentication(
        providerId,
        providerName,
        "oauth",
        previousModel,
      );
    } catch (error: unknown) {
      restoreEditor();
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg !== "Login cancelled") {
        this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
      }
    }
  };
