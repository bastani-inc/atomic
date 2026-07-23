import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type KeyId, type Component, type LoaderIndicatorOptions, type ExtensionContext, type ExtensionRunner, type ExtensionWidgetOptions, Container, matchesKey, Text, TUI, AssistantMessageComponent, keyText, Theme, theme } from "./interactive-mode-deps.ts";
import { mountIdleStatus } from "./components/idle-status.ts";
import { AtomicWorkingLoader } from "./components/atomic-working-status.ts";

InteractiveModeBase.prototype.setupExtensionShortcuts = function(this: InteractiveModeBase, extensionRunner: ExtensionRunner): void {
    const shortcuts = extensionRunner.getShortcuts(
      this.keybindings.getEffectiveConfig(),
    );
    if (shortcuts.size === 0) return;

    // Create a context for shortcut handlers
    const createContext = (): ExtensionContext => ({
      ui: this.createExtensionUIContext(),
      mode: "tui",
      hasUI: true,
      cwd: this.sessionManager.getCwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.session.modelRegistry,
      model: this.session.model,
      isIdle: () => !this.session.isStreaming,
      isProjectTrusted: () => this.session.settingsManager.isProjectTrusted(),
      signal: this.session.agent.signal,
      abort: () => this.session.abort(),
      hasPendingMessages: () => this.session.pendingMessageCount > 0,
      shutdown: () => {
        this.shutdownRequested = true;
      },
      getContextUsage: () => this.session.getContextUsage(),
      compact: (options) => {
        void (async () => {
          try {
            const result = await this.session.compact();
            options?.onComplete?.(result);
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error(String(error));
            options?.onError?.(err);
          }
        })();
      },
      getSystemPrompt: () => this.session.systemPrompt,
    });

    // Set up the extension shortcut handler on the default editor
    this.defaultEditor.onExtensionShortcut = (data: string) => {
      for (const [shortcutStr, shortcut] of shortcuts) {
        // Cast to KeyId - extension shortcuts use the same format
        if (matchesKey(data, shortcutStr as KeyId)) {
          // Run handler async, don't block input
          Promise.resolve(shortcut.handler(createContext())).catch((err) => {
            this.showError(
              `Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          return true;
        }
      }
      return false;
    };
  };

InteractiveModeBase.prototype.setExtensionStatus = function(this: InteractiveModeBase, key: string, text: string | undefined): void {
    this.footerDataProvider.setExtensionStatus(key, text);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.getWorkingLoaderMessage = function(this: InteractiveModeBase): string {
    return this.workingMessage ?? this.defaultWorkingMessage;
  };

InteractiveModeBase.prototype.createWorkingLoader = function(this: InteractiveModeBase): AtomicWorkingLoader {
	return new AtomicWorkingLoader(
		this.ui,
		undefined,
		(text) => theme.fg("muted", text),
		this.getWorkingLoaderMessage(),
		this.workingIndicatorOptions,
	);
};

InteractiveModeBase.prototype.stopWorkingLoader = function(this: InteractiveModeBase): void {
    const hadLoader = this.loadingAnimation !== undefined;
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = undefined;
    }
    this.statusContainer.clear();
    if (hadLoader) mountIdleStatus(this.statusContainer, this.settingsManager.getClearOnShrink());
  };

InteractiveModeBase.prototype.showWorkingLoaderNow = function(this: InteractiveModeBase): void {
    // Mount the working spinner immediately, regardless of streaming state, so
    // there is no visible gap between submitting a prompt and the agent turn
    // actually starting. Prompt preflight (extension input hooks, template/skill
    // expansion, auth and compaction checks, deferred startup) runs before the
    // agent emits `agent_start`, which is otherwise the only place the loader is
    // created. Respect `workingVisible` so extensions can still suppress it.
    if (!this.workingVisible || this.loadingAnimation) {
      this.ui.requestRender();
      return;
    }
    this.statusContainer.clear();
    this.loadingAnimation = this.createWorkingLoader();
    this.statusContainer.addChild(this.loadingAnimation);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setWorkingVisible = function(this: InteractiveModeBase, visible: boolean): void {
    this.workingVisible = visible;
    if (!visible) {
      this.stopWorkingLoader();
      this.ui.requestRender();
      return;
    }
    if (this.session.isStreaming && !this.loadingAnimation) {
      this.statusContainer.clear();
      this.loadingAnimation = this.createWorkingLoader();
      this.statusContainer.addChild(this.loadingAnimation);
    }
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setWorkingIndicator = function(this: InteractiveModeBase, options?: LoaderIndicatorOptions): void {
    this.workingIndicatorOptions = options;
    this.loadingAnimation?.setIndicator(options);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setHiddenThinkingLabel = function(this: InteractiveModeBase, label?: string): void {
    this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
    for (const child of this.chatContainer.children) {
      if (child instanceof AssistantMessageComponent) {
        child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
      }
    }
    if (this.streamingComponent) {
      this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
    }
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setExtensionWidget = function(this: InteractiveModeBase, key: string, content:
      | string[]
      | ((tui: TUI, thm: Theme) => Component & { dispose?(): void })
      | undefined, options?: ExtensionWidgetOptions): void {
    const placement = options?.placement ?? "aboveEditor";
    const removeExisting = (
      map: Map<string, Component & { dispose?(): void }>,
    ) => {
      const existing = map.get(key);
      if (existing?.dispose) existing.dispose();
      map.delete(key);
    };

    removeExisting(this.extensionWidgetsAbove);
    removeExisting(this.extensionWidgetsBelow);

    if (content === undefined) {
      this.renderWidgets();
      return;
    }

    let component: Component & { dispose?(): void };

    if (Array.isArray(content)) {
      // Wrap string array in a Container with Text components
      const container = new Container();
      for (const line of content.slice(0, InteractiveModeBase.MAX_WIDGET_LINES)) {
        container.addChild(new Text(line, 1, 0));
      }
      if (content.length > InteractiveModeBase.MAX_WIDGET_LINES) {
        container.addChild(
          new Text(theme.fg("muted", "... (widget truncated)"), 1, 0),
        );
      }
      component = container;
    } else {
      // Factory function - create component
      component = content(this.ui, theme);
    }

    const targetMap =
      placement === "belowEditor"
        ? this.extensionWidgetsBelow
        : this.extensionWidgetsAbove;
    targetMap.set(key, component);
    this.renderWidgets();
  };

InteractiveModeBase.prototype.clearExtensionWidgets = function(this: InteractiveModeBase): void {
    for (const widget of this.extensionWidgetsAbove.values()) {
      widget.dispose?.();
    }
    for (const widget of this.extensionWidgetsBelow.values()) {
      widget.dispose?.();
    }
    this.extensionWidgetsAbove.clear();
    this.extensionWidgetsBelow.clear();
    this.renderWidgets();
  };

InteractiveModeBase.prototype.resetExtensionUI = function(this: InteractiveModeBase): void {
    if (this.extensionSelector) {
      this.hideExtensionSelector();
    }
    if (this.extensionInput) {
      this.hideExtensionInput();
    }
    if (this.extensionEditor) {
      this.hideExtensionEditor();
    }
    this.ui.hideOverlay();
    this.clearExtensionTerminalInputListeners();
    this.setExtensionFooter(undefined);
    this.setExtensionHeader(undefined);
    this.clearExtensionWidgets();
    this.footerDataProvider.clearExtensionStatuses();
    this.footer.invalidate();
    this.autocompleteProviderWrappers = [];
    this.setCustomEditorComponent(undefined);
    this.setupAutocompleteProvider();
    this.defaultEditor.onExtensionShortcut = this.interactiveEngineShortcutHandler;
    this.updateTerminalTitle();
    this.workingMessage = undefined;
    this.workingVisible = true;
    this.setWorkingIndicator();
    if (this.loadingAnimation) {
      this.loadingAnimation.setMessage(
        `${this.defaultWorkingMessage} (${keyText("app.interrupt")} Interrupt)`,
      );
    }
    this.setHiddenThinkingLabel();
  };
