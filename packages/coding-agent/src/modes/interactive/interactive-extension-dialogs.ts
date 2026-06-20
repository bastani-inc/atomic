import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { type Component, type EditorFactory, type ExtensionUIDialogOptions, formatMissingSessionCwdPrompt, MissingSessionCwdError, ExtensionEditorComponent, ExtensionInputComponent, ExtensionSelectorComponent, getEditorTheme } from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.showExtensionSelector = function(this: InteractiveModeBase, title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }

      const onAbort = () => {
        this.hideExtensionSelector();
        resolve(undefined);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      this.extensionSelector = new ExtensionSelectorComponent(
        title,
        options,
        (option) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(option);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(undefined);
        },
        {
          tui: this.ui,
          timeout: opts?.timeout,
          onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
        },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionSelector);
      this.ui.setFocus(this.extensionSelector);
      this.ui.requestRender();
    });
  };

InteractiveModeBase.prototype.hideExtensionSelector = function(this: InteractiveModeBase): void {
    this.extensionSelector?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionSelector = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showExtensionConfirm = async function(this: InteractiveModeBase, title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    const result = await this.showExtensionSelector(
      `${title}\n${message}`,
      ["Yes", "No"],
      opts,
    );
    return result === "Yes";
  };

InteractiveModeBase.prototype.promptForMissingSessionCwd = async function(this: InteractiveModeBase, error: MissingSessionCwdError): Promise<string | undefined> {
    const confirmed = await this.showExtensionConfirm(
      "Session cwd not found",
      formatMissingSessionCwdPrompt(error.issue),
    );
    return confirmed ? error.issue.fallbackCwd : undefined;
  };

InteractiveModeBase.prototype.showExtensionInput = function(this: InteractiveModeBase, title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }

      const onAbort = () => {
        this.hideExtensionInput();
        resolve(undefined);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      this.extensionInput = new ExtensionInputComponent(
        title,
        placeholder,
        (value) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(value);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(undefined);
        },
        { tui: this.ui, timeout: opts?.timeout },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionInput);
      this.ui.setFocus(this.extensionInput);
      this.ui.requestRender();
    });
  };

InteractiveModeBase.prototype.hideExtensionInput = function(this: InteractiveModeBase): void {
    this.extensionInput?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionInput = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.showExtensionEditor = function(this: InteractiveModeBase, title: string, prefill?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.extensionEditor = new ExtensionEditorComponent(
        this.ui,
        this.keybindings,
        title,
        prefill,
        (value) => {
          this.hideExtensionEditor();
          resolve(value);
        },
        () => {
          this.hideExtensionEditor();
          resolve(undefined);
        },
      );

      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionEditor);
      this.ui.setFocus(this.extensionEditor);
      this.ui.requestRender();
    });
  };

InteractiveModeBase.prototype.hideExtensionEditor = function(this: InteractiveModeBase): void {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionEditor = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  };

InteractiveModeBase.prototype.setCustomEditorComponent = function(this: InteractiveModeBase, factory: EditorFactory | undefined): void {
    this.editorComponentFactory = factory;

    // Save text from current editor before switching
    const currentText = this.editor.getText();

    this.editorContainer.clear();

    if (factory) {
      // Create the custom editor with tui, theme, and keybindings
      const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

      // Wire up callbacks from the default editor
      newEditor.onSubmit = this.defaultEditor.onSubmit;
      newEditor.onChange = this.defaultEditor.onChange;

      // Copy text from previous editor
      newEditor.setText(currentText);

      // Copy appearance settings if supported
      if (newEditor.borderColor !== undefined) {
        newEditor.borderColor = this.defaultEditor.borderColor;
      }
      if (newEditor.setPaddingX !== undefined) {
        newEditor.setPaddingX(this.defaultEditor.getPaddingX());
      }

      // Set autocomplete if supported
      if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
        newEditor.setAutocompleteProvider(this.autocompleteProvider);
      }

      // If extending CustomEditor, copy app-level handlers
      // Use duck typing since instanceof fails across jiti module boundaries
      const customEditor = newEditor as unknown as Record<string, unknown>;
      if (
        "actionHandlers" in customEditor &&
        customEditor.actionHandlers instanceof Map
  ) {
        if (!customEditor.onEscape) {
          customEditor.onEscape = () => this.defaultEditor.onEscape?.();
        }
        if (!customEditor.onCtrlD) {
          customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
        }
        if (!customEditor.onPasteImage) {
          customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
        }
        if (!customEditor.onExtensionShortcut) {
          customEditor.onExtensionShortcut = (data: string) =>
            this.defaultEditor.onExtensionShortcut?.(data);
        }
        // Copy action handlers (clear, suspend, model switching, etc.)
        for (const [action, handler] of this.defaultEditor.actionHandlers) {
          (customEditor.actionHandlers as Map<string, () => void>).set(
            action,
            handler,
          );
        }
      }

      this.editor = newEditor;
    } else {
      // Restore default editor with text from custom editor
      this.defaultEditor.setText(currentText);
      this.editor = this.defaultEditor;
    }

    this.editorContainer.addChild(this.editor as Component);
    this.ui.setFocus(this.editor as Component);
    this.ui.requestRender();
  };
