import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Api, type Model, getAgentDir, findExactModelReferenceMatch, resolveModelScope, ContextWindowSelectorComponent, formatContextWindow, copilotApiBaseUrlFromToken, copilotCatalogCacheHost, copilotCatalogCachePath, fetchCopilotModelCatalog, readCopilotCatalogCache, setActiveCopilotModelCatalog, writeCopilotCatalogCache, ModelSelectorComponent, ScopedModelsSelectorComponent, UserMessageSelectorComponent } from "./interactive-mode-deps.ts";
import { ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, isAnthropicSubscriptionAuthKey } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.handleModelCommand = async function(this: InteractiveModeBase, searchTerm?: string): Promise<void> {
    if (!searchTerm) {
      this.showModelSelector();
      return;
    }

    const model = await this.findExactModelMatch(searchTerm);
    if (model) {
      try {
        await this.session.setModel(model);
        this.footer.invalidate();
        this.updateEditorBorderColor();
        this.showStatus(`Model: ${model.id}`);
        void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
        this.checkDaxnutsEasterEgg(model);
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    this.showModelSelector(searchTerm);
  };

InteractiveModeBase.prototype.findExactModelMatch = async function(this: InteractiveModeBase, searchTerm: string): Promise<Model<Api> | undefined> {
    const models = await this.getModelCandidates();
    return findExactModelReferenceMatch(searchTerm, models);
  };

InteractiveModeBase.prototype.getModelCandidates = async function(this: InteractiveModeBase): Promise<Model<Api>[]> {
    if (this.session.scopedModels.length > 0) {
      return this.session.scopedModels.map((scoped) => scoped.model);
    }

    await this.refreshCopilotModelCatalog();
    await this.session.modelRegistry.refresh();
    try {
      return await this.session.modelRegistry.getAvailable();
    } catch {
      return [];
    }
  };

InteractiveModeBase.prototype.refreshCopilotModelCatalog = async function(this: InteractiveModeBase): Promise<void> {
    if (this.copilotCatalogApplied) return;
    if (!this.copilotCatalogInFlight) {
      this.copilotCatalogInFlight = this.loadCopilotModelCatalog();
    }
    try {
      await this.copilotCatalogInFlight;
    } finally {
      this.copilotCatalogInFlight = undefined;
    }
  };

InteractiveModeBase.prototype.loadCopilotModelCatalog = async function(this: InteractiveModeBase): Promise<void> {
    const registry = this.session.modelRegistry;
    // Gate: do nothing unless the user has a Copilot token, including COPILOT_GITHUB_TOKEN env auth.
    try {
      const token = await registry.getApiKeyForProvider("github-copilot");
      if (!token) return;
      const baseUrl = copilotApiBaseUrlFromToken(token);
      const cachePath = copilotCatalogCachePath(getAgentDir());
      let catalog = readCopilotCatalogCache(cachePath, { host: copilotCatalogCacheHost(baseUrl) });
      if (!catalog) {
        catalog = await fetchCopilotModelCatalog({ token, baseUrl });
        writeCopilotCatalogCache(cachePath, baseUrl, catalog);
      }
      setActiveCopilotModelCatalog(catalog);
      await registry.refresh();
      this.session.refreshCurrentModelFromRegistry();
      this.copilotCatalogApplied = true;
    } catch {
      // Best-effort: leave the active catalog as-is on any failure (offline, auth, parse).
    }
  };

InteractiveModeBase.prototype.updateAvailableProviderCount = async function(this: InteractiveModeBase): Promise<void> {
    const models = await this.getModelCandidates();
    const uniqueProviders = new Set(models.map((m) => m.provider));
    this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
  };

InteractiveModeBase.prototype.maybeWarnAboutAnthropicSubscriptionAuth = async function(this: InteractiveModeBase, model: Model<Api> | undefined = this.session.model, targetContainer = this.chatContainer): Promise<void> {
    if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
      return;
    }
    if (this.anthropicSubscriptionWarningShown) {
      return;
    }
    if (!model || model.provider !== "anthropic") {
      return;
    }

    const storedCredential =
      this.session.modelRegistry.authStorage.get("anthropic");
    if (storedCredential?.type === "oauth") {
      this.anthropicSubscriptionWarningShown = true;
      this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, targetContainer);
      return;
    }

    try {
      const apiKey = await this.session.modelRegistry.getApiKeyForProvider(
        model.provider,
      );
      if (!isAnthropicSubscriptionAuthKey(apiKey)) {
        return;
      }
      this.anthropicSubscriptionWarningShown = true;
      this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, targetContainer);
    } catch {
      // Ignore auth lookup failures for warning-only checks.
    }
  };

InteractiveModeBase.prototype.showModelSelector = function(this: InteractiveModeBase, initialSearchInput?: string): void {
    this.showSelector((done) => {
      const selector = new ModelSelectorComponent(
        this.ui,
        this.session.model,
        this.settingsManager,
        this.session.modelRegistry,
        this.session.scopedModels,
        async (model) => {
          try {
            await this.session.setModel(model);
            this.footer.invalidate();
            this.updateEditorBorderColor();
            done();
            void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
            this.checkDaxnutsEasterEgg(model);
            if (this.session.supportsContextWindowSelection()) {
              this.showContextWindowSelector(model);
            } else {
              this.showStatus(`Model: ${model.id}`);
            }
          } catch (error) {
            done();
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        initialSearchInput,
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showContextWindowSelector = function(this: InteractiveModeBase, model: Model<Api>): void {
    const availableContextWindows = this.session.getAvailableContextWindows();
    const currentContextWindow =
      this.session.model?.contextWindow ?? availableContextWindows[0] ?? 0;
    this.showSelector((done) => {
      const selector = new ContextWindowSelectorComponent(
        model.name ?? model.id,
        availableContextWindows,
        currentContextWindow,
        async (contextWindow) => {
          try {
            this.session.setContextWindow(contextWindow, {
              persistDefault: true,
            });
            this.footer.invalidate();
            this.usageMeter.invalidate();
            this.updateEditorBorderColor();
            done();
            this.showStatus(
              `Model: ${model.id} \u00b7 ${formatContextWindow(contextWindow)} context`,
            );
          } catch (error) {
            done();
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        () => {
          done();
          this.showStatus(`Model: ${model.id}`);
        },
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showModelsSelector = async function(this: InteractiveModeBase): Promise<void> {
    // Get all available models
    await this.session.modelRegistry.refresh();
    const allModels = this.session.modelRegistry.getAvailable();

    if (allModels.length === 0) {
      this.showStatus("No models available");
      return;
    }

    // Check if session has scoped models (from previous session-only changes or CLI --models)
    const sessionScopedModels = this.session.scopedModels;
    const hasSessionScope = sessionScopedModels.length > 0;

    // Build enabled model IDs from session state or settings
    let currentEnabledIds: string[] | null = null;

    if (hasSessionScope) {
      // Use current session's scoped models
      currentEnabledIds = sessionScopedModels.map(
        (scoped) => `${scoped.model.provider}/${scoped.model.id}`,
      );
    } else {
      // Fall back to settings
      const patterns = this.settingsManager.getEnabledModels();
      if (patterns !== undefined && patterns.length > 0) {
        const scopedModels = await resolveModelScope(
          patterns,
          this.session.modelRegistry,
        );
        currentEnabledIds = scopedModels.map(
          (scoped) => `${scoped.model.provider}/${scoped.model.id}`,
        );
      }
    }

    // Helper to update session's scoped models (session-only, no persist)
    const updateSessionModels = async (enabledIds: string[] | null) => {
      currentEnabledIds = enabledIds === null ? null : [...enabledIds];
      if (
        enabledIds &&
        enabledIds.length > 0 &&
        enabledIds.length < allModels.length
  ) {
        const newScopedModels = await resolveModelScope(
          enabledIds,
          this.session.modelRegistry,
        );
        this.session.setScopedModels(
          newScopedModels.map((sm) => ({
            model: sm.model,
            thinkingLevel: sm.thinkingLevel,
          })),
        );
      } else {
        // All enabled or none enabled = no filter
        this.session.setScopedModels([]);
      }
      await this.updateAvailableProviderCount();
      this.setupAutocompleteProvider();
      this.ui.requestRender();
    };

    this.showSelector((done) => {
      const selector = new ScopedModelsSelectorComponent(
        {
          allModels,
          enabledModelIds: currentEnabledIds,
        },
        {
          onChange: async (enabledIds) => {
            await updateSessionModels(enabledIds);
          },
          onPersist: (enabledIds) => {
            // Persist to settings
            const newPatterns =
              enabledIds === null || enabledIds.length === allModels.length
                ? undefined // All enabled = clear filter
                : enabledIds;
            this.settingsManager.setEnabledModels(
              newPatterns ? [...newPatterns] : undefined,
            );
            this.showStatus("Model selection saved to settings");
          },
          onCancel: () => {
            done();
            this.ui.requestRender();
          },
        },
      );
      return { component: selector, focus: selector };
    });
  };

InteractiveModeBase.prototype.showUserMessageSelector = async function(this: InteractiveModeBase): Promise<void> {
    await this.ensureDeferredStartupComplete();
    const userMessages = this.session.getUserMessagesForForking();

    if (userMessages.length === 0) {
      this.showStatus("No messages to fork from");
      return;
    }

    const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

    this.showSelector((done) => {
      let selectionHandled = false;
      const selector = new UserMessageSelectorComponent(
        userMessages.map((m) => ({ id: m.entryId, text: m.text })),
        async (entryId) => {
          if (selectionHandled) return;
          selectionHandled = true;
          done();
          try {
            await this.ensureDeferredStartupComplete();
            const result = await this.runtimeHost.fork(entryId);
            if (result.cancelled) {
              this.ui.requestRender();
              return;
            }

            this.renderCurrentSessionState();
            this.editor.setText(result.selectedText ?? "");
            this.showStatus("Forked to new session");
          } catch (error: unknown) {
            this.showError(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
        () => {
          if (selectionHandled) return;
          selectionHandled = true;
          done();
          this.ui.requestRender();
        },
        initialSelectedId,
      );
      return { component: selector, focus: selector.getMessageList() };
    });
  };
