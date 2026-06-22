import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type ExtensionUIContext, type HostCustomUiState, type HostCustomUiStateListener, type ProjectTrustContext, getAvailableThemesWithPaths, getThemeByName, Theme, theme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.addExtensionTerminalInputListener = function(this: InteractiveModeBase, handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void {
    const unsubscribe = this.ui.addInputListener(handler);
    this.extensionTerminalInputUnsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
    };
  };

InteractiveModeBase.prototype.clearExtensionTerminalInputListeners = function(this: InteractiveModeBase): void {
    for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
      unsubscribe();
    }
    this.extensionTerminalInputUnsubscribers.clear();
  };

InteractiveModeBase.prototype.getHostCustomUiState = function(this: InteractiveModeBase): HostCustomUiState {
    const focusDeferred =
      this.blockingInlineCustomUiDepth > 0 && this.pendingInlineCustomUiFocus !== undefined;
    return {
      blockingInlineCustomUiDepth: this.blockingInlineCustomUiDepth,
      blockingInlineCustomUiActive: this.blockingInlineCustomUiDepth > 0,
      ...(focusDeferred ? { blockingInlineCustomUiFocusDeferred: true } : {}),
    };
  };

InteractiveModeBase.prototype.notifyHostCustomUiStateListeners = function(this: InteractiveModeBase): void {
    const state = this.getHostCustomUiState();
    for (const listener of this.hostCustomUiStateListeners) {
      try {
        listener(state);
      } catch {
        /* ignore observer errors */
      }
    }
  };

InteractiveModeBase.prototype.beginHostInlineCustomUi = function(this: InteractiveModeBase): () => void {
    let released = false;
    this.blockingInlineCustomUiDepth++;
    this.notifyHostCustomUiStateListeners();
    return () => {
      if (released) return;
      released = true;
      this.blockingInlineCustomUiDepth = Math.max(
        0,
        this.blockingInlineCustomUiDepth - 1,
      );
      this.notifyHostCustomUiStateListeners();
    };
  };

InteractiveModeBase.prototype.beginInlineCustomUiFocusDeferral = function(this: InteractiveModeBase): () => void {
    let released = false;
    this.deferredInlineCustomUiFocusDepth++;
    return () => {
      if (released) return;
      released = true;
      this.deferredInlineCustomUiFocusDepth = Math.max(
        0,
        this.deferredInlineCustomUiFocusDepth - 1,
      );
      if (this.deferredInlineCustomUiFocusDepth === 0) {
        this.focusHostInlineCustomUi();
      }
    };
  };

InteractiveModeBase.prototype.shouldDeferInlineCustomUiFocus = function(this: InteractiveModeBase): boolean {
    return this.deferredInlineCustomUiFocusDepth > 0;
  };

InteractiveModeBase.prototype.focusHostInlineCustomUi = function(this: InteractiveModeBase): boolean {
    const component = this.pendingInlineCustomUiFocus;
    if (component === undefined) return false;
    this.pendingInlineCustomUiFocus = undefined;
    this.ui.setFocus(component);
    this.ui.requestRender();
    this.notifyHostCustomUiStateListeners();
    return true;
  };

InteractiveModeBase.prototype.onHostCustomUiStateChange = function(this: InteractiveModeBase, listener: HostCustomUiStateListener): () => void {
    this.hostCustomUiStateListeners.add(listener);
    return () => {
      this.hostCustomUiStateListeners.delete(listener);
    };
  };

InteractiveModeBase.prototype.createProjectTrustContext = function(this: InteractiveModeBase, cwd: string): ProjectTrustContext {
    const ui = this.createExtensionUIContext();
    return {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: {
        select: ui.select,
        confirm: ui.confirm,
        input: ui.input,
        notify: ui.notify,
      },
    };
  };

InteractiveModeBase.prototype.createExtensionUIContext = function(this: InteractiveModeBase): ExtensionUIContext {
    return {
      select: (title, options, opts) =>
        this.showExtensionSelector(title, options, opts),
      confirm: (title, message, opts) =>
        this.showExtensionConfirm(title, message, opts),
      input: (title, placeholder, opts) =>
        this.showExtensionInput(title, placeholder, opts),
      notify: (message, type) => this.showExtensionNotify(message, type),
      requestRender: () => this.ui.requestRender(),
      getHostCustomUiState: () => this.getHostCustomUiState(),
      onHostCustomUiStateChange: (listener) =>
        this.onHostCustomUiStateChange(listener),
      focusHostInlineCustomUi: () => this.focusHostInlineCustomUi(),
      onTerminalInput: (handler) =>
        this.addExtensionTerminalInputListener(handler),
      setStatus: (key, text) => this.setExtensionStatus(key, text),
      setWorkingMessage: (message) => {
        this.workingMessage = message;
        if (this.loadingAnimation) {
          this.loadingAnimation.setMessage(
            message ?? this.defaultWorkingMessage,
          );
        }
      },
      setWorkingVisible: (visible) => this.setWorkingVisible(visible),
      setWorkingIndicator: (options) => this.setWorkingIndicator(options),
      setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
      setWidget: (key, content, options) =>
        this.setExtensionWidget(key, content, options),
      setFooter: (factory) => this.setExtensionFooter(factory),
      setHeader: (factory) => this.setExtensionHeader(factory),
      setTitle: (title) => this.ui.terminal.setTitle(title),
      custom: (factory, options) => this.showExtensionCustom(factory, options),
      pasteToEditor: (text) =>
        this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      setEditorText: (text) => this.editor.setText(text),
      getEditorText: () =>
        this.editor.getExpandedText?.() ?? this.editor.getText(),
      editor: (title, prefill) => this.showExtensionEditor(title, prefill),
      addAutocompleteProvider: (factory) => {
        this.autocompleteProviderWrappers.push(factory);
        this.setupAutocompleteProvider();
      },
      setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
      getEditorComponent: () => this.editorComponentFactory,
      getFooterDataProvider: () => this.footerDataProvider,
      get theme() {
        return theme;
      },
      getAllThemes: () => getAvailableThemesWithPaths(),
      getTheme: (name) => getThemeByName(name),
      setTheme: (themeOrName) => {
        if (themeOrName instanceof Theme) {
          return this.themeController.setThemeInstance(themeOrName);
        }
        const result = this.themeController.setThemeName(themeOrName);
        if (result.success && this.settingsManager.getThemeSetting() !== themeOrName) {
          this.settingsManager.setTheme(themeOrName);
        }
        return result;
      },
      getToolsExpanded: () => this.toolOutputExpanded,
      setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
      getChatRenderSettings: () => ({
        hideThinkingBlock: this.hideThinkingBlock,
        hiddenThinkingLabel: this.hiddenThinkingLabel,
        toolOutputExpanded: this.toolOutputExpanded,
        showImages: this.settingsManager.getShowImages(),
        imageWidthCells: this.settingsManager.getImageWidthCells(),
        getToolDefinition: (toolName: string) =>
          this.getRegisteredToolDefinition(toolName),
        getCustomMessageRenderer: (customType: string) =>
          this.session.extensionRunner.getMessageRenderer(customType),
      }),
    };
  };
