import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { modelsAreEqual } from "@earendil-works/pi-ai/compat";
import {
  type Container,
  findInitialModel,
  formatNoModelsAvailableMessage,
  recordTimeSinceReset,
  resolveModelScopeWithDiagnostics,
  resolveRestoredModelReference,
  setRegisteredThemes,
} from "./interactive-mode-deps.ts";

export interface DeferredStartupMode {
    deferredStartupPending: boolean;
    deferredStartupPromise: Promise<void> | undefined;
    completeDeferredStartup(): Promise<void>;
  }

export async function ensureDeferredStartupComplete(mode: DeferredStartupMode): Promise<void> {
    if (!mode.deferredStartupPending && !mode.deferredStartupPromise) return;
    const startupPromise = mode.deferredStartupPromise ?? Promise.resolve().then(() => mode.completeDeferredStartup());
    mode.deferredStartupPromise = startupPromise;
    try {
      await startupPromise;
    } catch {
      mode.deferredStartupPending = false;
    } finally {
      if (mode.deferredStartupPromise === startupPromise && !mode.deferredStartupPending) {
        mode.deferredStartupPromise = undefined;
      }
    }
  }

InteractiveModeBase.prototype.ensureDeferredStartupComplete = async function(this: InteractiveModeBase): Promise<void> {
    await ensureDeferredStartupComplete(this);
  };

/**
 * Finishes a startup where extension loading was deferred so the TUI could
 * paint immediately. Loads extension code via session.reload(), then applies
 * the same post-load UI wiring as /reload and discloses loaded resources.
 */
InteractiveModeBase.prototype.completeDeferredStartup = async function(this: InteractiveModeBase): Promise<void> {
    try {
      await this.bindCurrentSessionExtensions();
      await this.session.reload({ reason: "startup" });

      this.stopWorkingLoader();
      this.deferredStartupPending = false;
      recordTimeSinceReset("deferred-extension-load");

      setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
      await this.themeController.applyFromSettings();
      this.setupAutocompleteProvider();
      this.setupExtensionShortcuts(this.session.extensionRunner);
      await applyDeferredModelScope(this);
      await this.retryDeferredModelRestore(this.startupNoticesContainer);
      if (this.deferLoadedResourcesDisclosureUntilAgentEnd) {
        this.pendingLoadedResourcesDisclosure = true;
      } else {
        this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true, targetContainer: this.startupNoticesContainer });
        // Keep the subscription warning after the RESOURCES disclosure.
        void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
        this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
      }
      const modelsJsonError = this.session.modelRegistry.getError();
      if (modelsJsonError) {
        this.showError(`models.json error: ${modelsJsonError}`);
      }
      void this.updateAvailableProviderCount().catch(() => {});
      this.updateEditorBorderColor();
      this.ui.requestRender();
    } catch (error) {
      this.stopWorkingLoader();
      this.deferredStartupPending = false;
      this.showError(
        `Extension loading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // The RESOURCES disclosure will not render; surface the held warning.
      void this.maybeWarnAboutAnthropicSubscriptionAuth(undefined, this.startupNoticesContainer);
    }
  };

export async function applyDeferredModelScope(mode: InteractiveModeBase): Promise<void> {
    const patterns = mode.options.deferredModelScopePatterns;
    if (!patterns || patterns.length === 0) {
      return;
    }

    const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, mode.session.modelRegistry);
    for (const diagnostic of diagnostics) {
      mode.showWarning(diagnostic.message);
    }
    mode.session.setScopedModels(scopedModels);

    if (mode.sessionManager.buildSessionContext().messages.length > 0 || scopedModels.length === 0) {
      return;
    }

    const currentModel = mode.session.model;
    if (currentModel && scopedModels.some((scoped) => modelsAreEqual(scoped.model, currentModel))) {
      return;
    }

    const savedProvider = mode.settingsManager.getDefaultProvider();
    const savedModelId = mode.settingsManager.getDefaultModel();
    const savedModel = savedProvider && savedModelId ? mode.session.modelRegistry.find(savedProvider, savedModelId) : undefined;
    const preferred = savedModel ? scopedModels.find((scoped) => modelsAreEqual(scoped.model, savedModel)) : undefined;
    const nextScopedModel = preferred ?? scopedModels[0];
    if (mode.session.modelRegistry.hasConfiguredAuth(nextScopedModel.model)) {
      await mode.session.setModel(nextScopedModel.model);
      if (nextScopedModel.thinkingLevel && !mode.options.deferredModelScopePreserveThinking) {
        mode.session.setThinkingLevel(nextScopedModel.thinkingLevel);
      }
    }
  }

/**
 * Session-restored models and complete settings defaults may depend on an
 * extension provider. Re-evaluate them after deferred registration finishes,
 * then surface only the final warning state.
 */
InteractiveModeBase.prototype.retryDeferredModelRestore = async function(this: InteractiveModeBase, targetContainer?: Container): Promise<void> {
    const preliminaryFallbackMessage = this.options.modelFallbackMessage;
    if (!preliminaryFallbackMessage) return;

    const savedModel = this.sessionManager.buildSessionContext().model;
    if (!savedModel && this.session.model && this.session.modelRegistry.hasConfiguredAuth(this.session.model)) {
      return;
    }
    if (savedModel) {
      const restoredModel = await resolveRestoredModelReference(
        savedModel.provider,
        savedModel.modelId,
        this.session.modelRegistry,
      );
      if (restoredModel && this.session.modelRegistry.hasConfiguredAuth(restoredModel)) {
        await this.session.setModel(restoredModel);
        return;
      }
      this.showWarning(preliminaryFallbackMessage, targetContainer);
      return;
    }

    const defaultProvider = this.settingsManager.getDefaultProvider();
    const defaultModelId = this.settingsManager.getDefaultModel();
    if (defaultProvider && defaultModelId) {
      const result = await findInitialModel({
        scopedModels: [],
        isContinuing: false,
        defaultProvider,
        defaultModelId,
        defaultThinkingLevel: this.settingsManager.getDefaultThinkingLevel(),
        modelRegistry: this.session.modelRegistry,
      });
      if (result.model) {
        await this.session.setModel(result.model);
        this.session.setThinkingLevel(result.thinkingLevel);
        return;
      }
      this.showWarning(result.fallbackMessage ?? formatNoModelsAvailableMessage(), targetContainer);
      return;
    }

    this.showWarning(preliminaryFallbackMessage, targetContainer);
  };
