import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type AgentSession, setRegisteredThemes, stopThemeWatcher } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.bindCurrentSessionExtensions = async function(this: InteractiveModeBase): Promise<void> {
    const uiContext = this.createExtensionUIContext();
    await this.session.bindExtensions({
      uiContext,
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => this.session.agent.waitForIdle(),
        newSession: async (options) => {
          if (this.loadingAnimation) {
            this.loadingAnimation.stop();
            this.loadingAnimation = undefined;
          }
          this.statusContainer.clear();
          try {
            const result = await this.runtimeHost.newSession(options);
            if (!result.cancelled) {
              this.renderCurrentSessionState();
              this.ui.requestRender();
            }
            return result;
          } catch (error: unknown) {
            return this.handleFatalRuntimeError(
              "Failed to create session",
              error,
            );
          }
        },
        fork: async (entryId, options) => {
          try {
            const result = await this.runtimeHost.fork(entryId, options);
            if (!result.cancelled) {
              this.renderCurrentSessionState();
              this.editor.setText(result.selectedText ?? "");
              this.showStatus("Forked to new session");
            }
            return { cancelled: result.cancelled };
          } catch (error: unknown) {
            return this.handleFatalRuntimeError(
              "Failed to fork session",
              error,
            );
          }
        },
        navigateTree: async (targetId, options) => {
          const result = await this.session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          if (result.cancelled) {
            return { cancelled: true };
          }

          this.chatContainer.clear();
          this.renderInitialMessages();
          if (result.editorText && !this.editor.getText().trim()) {
            this.editor.setText(result.editorText);
          }
          this.showStatus("Navigated to selected point");
          void this.flushCompactionQueue({ willRetry: false });
          return { cancelled: false };
        },
        switchSession: async (sessionPath, options) => {
          return this.handleResumeSession(sessionPath, options);
        },
        reload: async () => {
          await this.handleReloadCommand();
        },
      },
      shutdownHandler: () => {
        this.shutdownRequested = true;
        if (!this.session.isStreaming) {
          void this.shutdown();
        }
      },
      onError: (error) => {
        this.showExtensionError(error.extensionPath, error.error, error.stack);
      },
    });

    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    this.setupAutocompleteProvider();

    const extensionRunner = this.session.extensionRunner;
    this.setupExtensionShortcuts(extensionRunner);
    if (!this.deferredStartupPending) {
      this.showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true });
      this.showStartupNoticesIfNeeded();
    }
  };

InteractiveModeBase.prototype.applyRuntimeSettings = function(this: InteractiveModeBase): void {
    this.footer.setSession(this.session);
    this.usageMeter.setSession(this.session);
    this.usageMeter.setAutoCompactEnabled(this.session.autoCompactionEnabled);
    this.footerDataProvider.setCwd(this.sessionManager.getCwd());
    this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
    this.outputPad = this.settingsManager.getOutputPad();
    this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
    this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
    const editorPaddingX = this.settingsManager.getEditorPaddingX();
    const autocompleteMaxVisible =
      this.settingsManager.getAutocompleteMaxVisible();
    this.defaultEditor.setPaddingX(editorPaddingX);
    this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
    if (this.editor !== this.defaultEditor) {
      this.editor.setPaddingX?.(editorPaddingX);
      this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
    }
  };

InteractiveModeBase.prototype.rebindCurrentSession = async function(this: InteractiveModeBase): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.applyRuntimeSettings();
    await this.bindCurrentSessionExtensions();
    this.subscribeToAgent();
    await this.updateAvailableProviderCount();
    this.updateEditorBorderColor();
    this.updateTerminalTitle();
  };

InteractiveModeBase.prototype.handleFatalRuntimeError = async function(this: InteractiveModeBase, prefix: string, error: unknown): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    this.showError(`${prefix}: ${message}`);
    stopThemeWatcher();
    this.stop();
    process.exit(1);
  };

InteractiveModeBase.prototype.renderCurrentSessionState = function(this: InteractiveModeBase): void {
    this.chatContainer.clear();
    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = undefined;
    this.streamingMessage = undefined;
    this.pendingTools.clear();
    this.renderInitialMessages();
  };

InteractiveModeBase.prototype.getRegisteredToolDefinition = function(this: InteractiveModeBase, toolName: string): ReturnType<AgentSession["getToolDefinition"]> {
    return this.session.getToolDefinition(toolName);
  };
