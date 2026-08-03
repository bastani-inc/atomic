import { boundedInteractiveModelRefresh } from "../../core/bounded-model-refresh.ts";
import { isOfflineModeEnabled } from "../../core/package-manager-env.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Api,
	findExactModelReferenceMatch,
	type Model,
	ModelSelectorComponent,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
	ScopedModelsSelectorComponent,
	UserMessageSelectorComponent,
} from "./interactive-mode-deps.ts";
import { ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, isAnthropicSubscriptionAuthKey } from "./interactive-mode-helpers.ts";

InteractiveModeBase.prototype.handleModelCommand = async function (
	this: InteractiveModeBase,
	searchTerm?: string,
): Promise<void> {
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

InteractiveModeBase.prototype.findExactModelMatch = async function (
	this: InteractiveModeBase,
	searchTerm: string,
): Promise<Model<Api> | undefined> {
	const models = await this.getModelCandidates();
	return findExactModelReferenceMatch(searchTerm, models);
};

InteractiveModeBase.prototype.getModelCandidates = async function (this: InteractiveModeBase): Promise<Model<Api>[]> {
	if (this.session.scopedModels.length > 0) {
		return this.session.scopedModels.map((scoped) => scoped.model);
	}

	const allowNetwork = !isOfflineModeEnabled();
	await boundedInteractiveModelRefresh((refreshOptions) => this.session.modelRuntime.refresh(refreshOptions), {
		allowNetwork,
	});
	try {
		return [...this.session.modelRuntime.getAvailableSnapshot()];
	} catch {
		return [];
	}
};

InteractiveModeBase.prototype.updateAvailableProviderCount = async function (this: InteractiveModeBase): Promise<void> {
	const models =
		this.session.scopedModels.length > 0
			? this.session.scopedModels.map((scoped) => scoped.model)
			: this.session.modelRuntime.getAvailableSnapshot();
	this.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);
};

InteractiveModeBase.prototype.maybeWarnAboutAnthropicSubscriptionAuth = async function (
	this: InteractiveModeBase,
	model: Model<Api> | undefined = this.session.model,
	targetContainer = this.chatContainer,
): Promise<void> {
	if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
		return;
	}
	if (this.anthropicSubscriptionWarningShown) {
		return;
	}
	if (model?.provider !== "anthropic") {
		return;
	}

	if (this.session.modelRuntime.isUsingOAuth("anthropic")) {
		this.anthropicSubscriptionWarningShown = true;
		this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, targetContainer);
		return;
	}

	try {
		const storedCredential = await this.session.modelRuntime.getAuth("anthropic");
		const apiKey = storedCredential?.auth.apiKey;
		if (!isAnthropicSubscriptionAuthKey(apiKey)) {
			return;
		}
		this.anthropicSubscriptionWarningShown = true;
		this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, targetContainer);
	} catch {
		// Ignore auth lookup failures for warning-only checks.
	}
};

InteractiveModeBase.prototype.showModelSelector = function (
	this: InteractiveModeBase,
	initialSearchInput?: string,
): void {
	this.showSelector((done) => {
		const selector = new ModelSelectorComponent(
			this.ui,
			this.session.model,
			this.settingsManager,
			this.session.modelRuntime,
			this.session.scopedModels,
			async (model) => {
				try {
					await this.session.setModel(model);
					this.footer.invalidate();
					this.updateEditorBorderColor();
					done();
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
					this.checkDaxnutsEasterEgg(model);
					this.showStatus(`Model: ${model.id}`);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
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

InteractiveModeBase.prototype.showModelsSelector = async function (this: InteractiveModeBase): Promise<void> {
	await this.session.modelRuntime.refresh({ allowNetwork: !isOfflineModeEnabled() });
	const allModels = [...this.session.modelRuntime.getAvailableSnapshot()];
	const allModelIds = new Set(allModels.map((model) => `${model.provider}/${model.id}`));
	const configuredPatterns = this.settingsManager.getEnabledModels();
	const sessionScopedModels = this.session.scopedModels;

	if (allModels.length === 0 && !configuredPatterns?.length && sessionScopedModels.length === 0) {
		this.showStatus("No models available");
		return;
	}

	const configuredScope = configuredPatterns?.length
		? await resolveModelScopeWithDiagnostics(configuredPatterns, this.session.modelRuntime)
		: undefined;
	const hasSessionScope = sessionScopedModels.length > 0;
	let currentEnabledIds: string[] | null = null;
	if (hasSessionScope) {
		currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	} else if (configuredScope) {
		currentEnabledIds = configuredScope.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	}
	for (const diagnostic of configuredScope?.diagnostics ?? []) {
		if (diagnostic.code !== "no-match") continue;
		currentEnabledIds ??= [];
		if (!currentEnabledIds.includes(diagnostic.pattern)) currentEnabledIds.push(diagnostic.pattern);
	}

	const updateSessionModels = async (enabledIds: string[] | null) => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		const hasEnabledAvailableModel = enabledIds?.some((id) => allModelIds.has(id)) ?? false;
		const allAvailableModelsEnabled = enabledIds !== null && [...allModelIds].every((id) => enabledIds.includes(id));
		if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
			const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRuntime);
			this.session.setScopedModels(
				newScopedModels.map((sm) => ({ model: sm.model, thinkingLevel: sm.thinkingLevel })),
			);
		} else {
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
					const allEnabled =
						enabledIds !== null &&
						enabledIds.length === allModels.length &&
						enabledIds.every((id) => allModelIds.has(id));
					const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
					this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
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

InteractiveModeBase.prototype.showUserMessageSelector = async function (this: InteractiveModeBase): Promise<void> {
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
					this.showError(error instanceof Error ? error.message : String(error));
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
