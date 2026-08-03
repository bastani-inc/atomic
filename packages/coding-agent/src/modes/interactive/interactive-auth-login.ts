import { isOAuthLoginCancelled } from "../../core/oauth-login.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Api,
	defaultModelPerProvider,
	ExtensionSelectorComponent,
	getAuthPath,
	getDocsPath,
	LoginDialogComponent,
	type Model,
	type OAuthSelectPrompt,
	path,
	theme,
} from "./interactive-mode-deps.ts";
import { hasDefaultModelProvider, isUnknownModel } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.completeProviderAuthentication = async function (
	this: InteractiveModeBase,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
	previousModel: Model<Api> | undefined,
	options: { modelsRefreshed?: boolean } = {},
): Promise<void> {
	if (!options.modelsRefreshed) {
		// Match pi: after authentication persists the credential, a thrown catalog
		// refresh failure remains visible to the caller without rolling it back.
		await this.session.modelRuntime.refresh();
	}

	const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

	let selectedModel: Model<Api> | undefined;
	let selectionError: string | undefined;
	if (isUnknownModel(previousModel)) {
		const availableModels = this.session.modelRuntime.getAvailableSnapshot();
		const providerModels = availableModels.filter((model) => model.provider === providerId);
		if (!hasDefaultModelProvider(providerId)) {
			selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
		} else if (providerModels.length === 0) {
			selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
		} else {
			const defaultModelId = defaultModelPerProvider[providerId];
			selectedModel = providerModels.find((model) => model.id === defaultModelId);
			if (!selectedModel) {
				selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
			} else {
				try {
					await this.session.setModel(selectedModel);
				} catch (error: unknown) {
					selectedModel = undefined;
					const errorMessage = error instanceof Error ? error.message : String(error);
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
		this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
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

InteractiveModeBase.prototype.showBedrockSetupDialog = function (
	this: InteractiveModeBase,
	providerId: string,
	providerName: string,
): void {
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
		theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
		theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
		theme.fg("muted", "See:"),
		theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
	]);

	this.editorContainer.clear();
	this.editorContainer.addChild(dialog);
	this.ui.setFocus(dialog);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.showApiKeyLoginDialog = async function (
	this: InteractiveModeBase,
	providerId: string,
	providerName: string,
): Promise<void> {
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
		await this.session.modelRuntime.login(providerId, "api_key", {
			signal: dialog.signal,
			prompt: (prompt) =>
				dialog.showPrompt(prompt.message, "placeholder" in prompt ? prompt.placeholder : undefined),
			notify: (event) => {
				if (event.type === "info") dialog.showInfo(event.message, event.links);
				else if (event.type === "progress") dialog.showProgress(event.message);
			},
		});
		restoreEditor();
		await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel, {
			modelsRefreshed: true,
		});
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (!isOAuthLoginCancelled(error)) {
			this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
		}
	}
};

InteractiveModeBase.prototype.showOAuthLoginSelect = function (
	this: InteractiveModeBase,
	dialog: LoginDialogComponent,
	prompt: OAuthSelectPrompt,
): Promise<string | undefined> {
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
				resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
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

InteractiveModeBase.prototype.showLoginDialog = async function (
	this: InteractiveModeBase,
	providerId: string,
	providerName: string,
): Promise<void> {
	const previousModel = this.session.model;
	const metadata = this.session.modelRuntime?.getOAuthProviderMetadata().find(({ id }) => id === providerId);
	const usesCallbackServer = metadata?.usesCallbackServer === true;

	const dialog = new LoginDialogComponent(
		this.ui,
		providerId,
		(_success, _message) => {
			// Completion handled below
		},
		providerName,
		metadata?.loginLabel,
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

	let loginSucceeded = false;
	try {
		const loginResult = await this.runtimeHost.loginOAuthProvider(providerId, {
			onAuth: (info: { url: string; instructions?: string }) => {
				dialog.showAuth(info.url, info.instructions, {
					showCancelHint: !usesCallbackServer,
				});

				if (usesCallbackServer) {
					// Show input for manual paste, racing with callback
					dialog
						.showManualInput("Paste redirect URL below, or complete login in browser:")
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

			onPrompt: async (prompt: { message: string; placeholder?: string }) => {
				return dialog.showPrompt(prompt.message, "placeholder" in prompt ? prompt.placeholder : undefined);
			},

			onProgress: (message: string) => {
				dialog.showProgress(message);
			},

			onInfo: (message, links) => {
				dialog.showInfo(message, links);
			},

			onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

			onManualCodeInput: () => manualCodePromise,

			onManualCodeCancel: () => {
				dialog.dismissPendingInput();
				manualCodeResolve?.("");
				manualCodeResolve = undefined;
				manualCodeReject = undefined;
			},

			signal: dialog.signal,
		});
		loginSucceeded = true;

		// Success
		restoreEditor();
		await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel, loginResult);
	} catch (error: unknown) {
		restoreEditor();
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (loginSucceeded || !isOAuthLoginCancelled(error)) {
			this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
		}
	}
};
