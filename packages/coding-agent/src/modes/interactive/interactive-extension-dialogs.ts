import { showStartupInput, showStartupSelector } from "../../cli/startup-ui.ts";
import { AtomicWorkingLoader } from "./components/atomic-working-status.ts";
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
import { isStartupTrustHeld } from "./interactive-startup-trust.ts";
import type { BlockedStatus } from "./program-status-reporter.ts";

InteractiveModeBase.prototype.showExtensionSelector = function (
	this: InteractiveModeBase,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
	blocked: BlockedStatus = { kind: "question", message: title },
): Promise<string | undefined> {
	if (isStartupTrustHeld(this)) {
		return showStartupSelector(
			this.settingsManager,
			title,
			options.map((option) => ({ label: option, value: option })),
			opts,
		);
	}
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = (option: string | undefined) => {
			opts?.signal?.removeEventListener("abort", onAbort);
			selector.dispose();
			this.removeExtensionDialog(selector);
			resolve(option);
		};
		const onAbort = () => finish(undefined);
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const selector = new ExtensionSelectorComponent(
			title,
			options,
			(option) => finish(option),
			() => finish(undefined),
			{
				tui: this.ui,
				timeout: opts?.timeout,
				onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
			},
		);
		this.pushExtensionDialog(selector, blocked);
	});
};

InteractiveModeBase.prototype.showExtensionConfirm = async function (
	this: InteractiveModeBase,
	title: string,
	message: string,
	opts?: ExtensionUIDialogOptions,
): Promise<boolean> {
	const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, {
		kind: "permission",
		message: title,
	});
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
	if (isStartupTrustHeld(this)) {
		return showStartupInput(this.settingsManager, title, placeholder, opts);
	}
	return new Promise((resolve) => {
		if (opts?.signal?.aborted) {
			resolve(undefined);
			return;
		}

		const finish = (value: string | undefined) => {
			opts?.signal?.removeEventListener("abort", onAbort);
			input.dispose();
			this.removeExtensionDialog(input);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => finish(value),
			() => finish(undefined),
			{ tui: this.ui, timeout: opts?.timeout },
		);
		this.pushExtensionDialog(input, { kind: "question", message: title });
	});
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

		const finish = (value: string | undefined) => {
			opts?.signal?.removeEventListener("abort", onAbort);
			this.removeExtensionDialog(editor);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		const editor = new ExtensionEditorComponent(
			this.ui,
			this.keybindings,
			title,
			prefill,
			(value) => finish(value),
			() => finish(undefined),
			undefined,
			this.settingsManager.getExternalEditorCommand(),
		);
		this.pushExtensionDialog(editor, { kind: "question", message: title });
	});
};

InteractiveModeBase.prototype.setCustomEditorComponent = function (
	this: InteractiveModeBase,
	factory: EditorFactory | undefined,
): void {
	this.editorComponentFactory = factory;

	// Save text from current editor before switching
	const currentText = this.editor.getText();

	// An open extension dialog keeps the editor slot; the new editor is shown when the last dialog closes.
	const dialogOpen = this.extensionDialogs.length > 0;
	if (!dialogOpen) {
		this.disposeActiveSelector();
		this.editorContainer.clear();
	}

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
		if (newEditor.setAutocompleteMaxVisible !== undefined) {
			newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
		}
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

	if (!dialogOpen) this.editorContainer.addChild(this.editor as Component);
	if (this.loadingAnimation instanceof AtomicWorkingLoader) {
		this.statusContainer.clear();
		this.workingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.loadingAnimation);
		if (!this.workingIndicatorEmbedded) this.statusContainer.addChild(this.loadingAnimation);
	}
	if (!dialogOpen) this.ui.setFocus(this.editor as Component);
	this.ui.requestRender();
};
