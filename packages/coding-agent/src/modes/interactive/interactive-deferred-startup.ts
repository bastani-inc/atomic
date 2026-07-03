import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { recordTimeSinceReset, resolveSavedModelReference, setRegisteredThemes, Text, theme } from "./interactive-mode-deps.ts";

/**
 * Finishes a startup where extension loading was deferred so the TUI could
 * paint immediately. Loads extension code via session.reload(), then applies
 * the same post-load UI wiring as /reload and discloses loaded resources.
 */
InteractiveModeBase.prototype.completeDeferredStartup = async function(this: InteractiveModeBase): Promise<void> {
    const loadingIndicator = new Text(theme.fg("dim", "Loading extensions, skills, prompts, themes..."), 1, 0);
    this.chatContainer.addChild(loadingIndicator);
    this.ui.requestRender();

    try {
      await this.session.reload({ reason: "startup" });
    } catch (error) {
      this.chatContainer.removeChild(loadingIndicator);
      this.deferredStartupPending = false;
      this.showError(
        `Extension loading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.chatContainer.removeChild(loadingIndicator);
    this.deferredStartupPending = false;
    recordTimeSinceReset("deferred-extension-load");

    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    await this.themeController.applyFromSettings();
    this.setupAutocompleteProvider();
    this.setupExtensionShortcuts(this.session.extensionRunner);
    await this.retryDeferredModelRestore();
    this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    this.showStartupNoticesIfNeeded();

    const modelsJsonError = this.session.modelRegistry.getError();
    if (modelsJsonError) {
      this.showError(`models.json error: ${modelsJsonError}`);
    }
    void this.updateAvailableProviderCount().catch(() => {});
    this.updateEditorBorderColor();
    this.ui.requestRender();
  };

/**
 * A session model saved with an extension-registered provider cannot resolve
 * until extensions load; retry the restore now and only surface the fallback
 * warning if it still fails.
 */
InteractiveModeBase.prototype.retryDeferredModelRestore = async function(this: InteractiveModeBase): Promise<void> {
    const fallbackMessage = this.options.modelFallbackMessage;
    if (!fallbackMessage) {
      return;
    }
    const savedModel = this.sessionManager.buildSessionContext().model;
    if (savedModel) {
      const restoredModel = await resolveSavedModelReference(
        savedModel.provider,
        savedModel.modelId,
        this.session.modelRegistry,
      );
      if (restoredModel && this.session.modelRegistry.hasConfiguredAuth(restoredModel)) {
        await this.session.setModel(restoredModel);
        return;
      }
    }
    this.showWarning(fallbackMessage);
  };
