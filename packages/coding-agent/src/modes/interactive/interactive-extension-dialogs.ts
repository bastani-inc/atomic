import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Component,
	type EditorFactory,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	type ExtensionUIDialogOptions,
	formatMissingSessionCwdPrompt,
	getEditorTheme,
	type MissingSessionCwdError,
} from "./interactive-mode-deps.ts";

InteractiveModeBase.prototype.showExtensionSelector = function (
	this: InteractiveModeBase,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const onAbort = () => {
			this.hideExtensionSelector(selector);
			resolve(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const selector = new ExtensionSelectorComponent(
			title,
			options,
			(option) => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionSelector(selector);
				resolve(option);
			},
			() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionSelector(selector);
				resolve(undefined);
			},
			{
				tui: this.ui,
				timeout: opts?.timeout,
				onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
			},
		);
		this.extensionSelector = selector;

		this.editorContainer.clear();
		this.editorContainer.addChild(selector);
		this.ui.setFocus(selector);
		this.ui.requestRender();
	});
};

/**
 * Close the selector. Pass the instance that is closing: a late abort from a
 * dead engine generation must never dismiss a newer dialog that has since taken
 * over `editorContainer`.
 */
InteractiveModeBase.prototype.hideExtensionSelector = function (
	this: InteractiveModeBase,
	instance?: ExtensionSelectorComponent,
): void {
	if (instance !== undefined && this.extensionSelector !== instance) return;
	this.extensionSelector?.dispose();
	this.editorContainer.clear();
	this.editorContainer.addChild(this.editor);
	this.extensionSelector = undefined;
	this.ui.setFocus(this.editor);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showExtensionConfirm = async function (
	this: InteractiveModeBase,
	title: string,
	message: string,
	opts?: ExtensionUIDialogOptions,
): Promise<boolean> {
	const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
	return result === "Yes";
};

InteractiveModeBase.prototype.promptForMissingSessionCwd = async function (
	this: InteractiveModeBase,
	error: MissingSessionCwdError,
): Promise<string | undefined> {
	const confirmed = await this.showExtensionConfirm(
		"Session cwd not found",
		formatMissingSessionCwdPrompt(error.issue),
	);
	return confirmed ? error.issue.fallbackCwd : undefined;
};

InteractiveModeBase.prototype.showExtensionInput = function (
	this: InteractiveModeBase,
	title: string,
	placeholder?: string,
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const onAbort = () => {
			this.hideExtensionInput(input);
			resolve(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionInput(input);
				resolve(value);
			},
			() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionInput(input);
				resolve(undefined);
			},
			{ tui: this.ui, timeout: opts?.timeout },
		);
		this.extensionInput = input;

		this.editorContainer.clear();
		this.editorContainer.addChild(input);
		this.ui.setFocus(input);
		this.ui.requestRender();
	});
};

/** Instance-scoped: see hideExtensionSelector. */
InteractiveModeBase.prototype.hideExtensionInput = function (
	this: InteractiveModeBase,
	instance?: ExtensionInputComponent,
): void {
	if (instance !== undefined && this.extensionInput !== instance) return;
	this.extensionInput?.dispose();
	this.editorContainer.clear();
	this.editorContainer.addChild(this.editor);
	this.extensionInput = undefined;
	this.ui.setFocus(this.editor);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showExtensionEditor = function (
	this: InteractiveModeBase,
	title: string,
	prefill?: string,
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const onAbort = () => {
			this.hideExtensionEditor(editor);
			resolve(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const editor = new ExtensionEditorComponent(
			this.ui,
			this.keybindings,
			title,
			prefill,
			(value) => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionEditor(editor);
				resolve(value);
			},
			() => {
				opts?.signal?.removeEventListener("abort", onAbort);
				this.hideExtensionEditor(editor);
				resolve(undefined);
			},
			undefined,
			this.settingsManager.getExternalEditorCommand(),
		);
		this.extensionEditor = editor;

		this.editorContainer.clear();
		this.editorContainer.addChild(editor);
		this.ui.setFocus(editor);
		this.ui.requestRender();
	});
};

/** Instance-scoped: see hideExtensionSelector. */
InteractiveModeBase.prototype.hideExtensionEditor = function (
	this: InteractiveModeBase,
	instance?: ExtensionEditorComponent,
): void {
	if (instance !== undefined && this.extensionEditor !== instance) return;
	this.editorContainer.clear();
	this.editorContainer.addChild(this.editor);
	this.extensionEditor = undefined;
	this.ui.setFocus(this.editor);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.setCustomEditorComponent = function (
	this: InteractiveModeBase,
	factory: EditorFactory | undefined,
): void {
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
		if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
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
				customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
			}
			// Copy action handlers (clear, suspend, model switching, etc.)
			for (const [action, handler] of this.defaultEditor.actionHandlers) {
				(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
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
