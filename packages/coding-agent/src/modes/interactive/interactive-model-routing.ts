import { clampThinkingLevel } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { boundedInteractiveModelRefresh } from "../../core/bounded-model-refresh.ts";
import { isOfflineModeEnabled } from "../../core/package-manager-env.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type Api,
	findExactModelReferenceMatch,
	type Model,
	ModelSelectorComponent,
	resolveModelScopeFromModels,
	ScopedModelsSelectorComponent,
	ThinkingSelectorComponent,
	UserMessageSelectorComponent,
} from "./interactive-mode-deps.ts";
import { ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, isAnthropicSubscriptionAuthKey } from "./interactive-mode-helpers.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";

export function resolveThinkingSelectorDefault(
	rawDefault: ThinkingLevel | undefined,
	availableLevels: readonly ThinkingLevel[],
	model: Model<Api> | undefined,
): ThinkingLevel | undefined {
	if (rawDefault === undefined) return undefined;
	if (availableLevels.includes(rawDefault)) return rawDefault;
	if (!model) return availableLevels.includes("off") ? "off" : availableLevels[0];
	const clamped = clampThinkingLevel(model, rawDefault) as ThinkingLevel;
	if (availableLevels.includes(clamped)) return clamped;
	return availableLevels.includes("off") ? "off" : availableLevels[0];
}

/**
 * The saved level the active session would start from, in the precedence
 * `findInitialModel` uses: a scoped `--models "id:level"` entry wins over a
 * persisted per-model override, which wins over the global default. Matching
 * it keeps the selector badge from advertising a level the session never used.
 */
export function resolveSessionThinkingDefault(
	model: Model<Api> | undefined,
	scopedModels: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
	settings: {
		getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
		getDefaultThinkingLevel(): ThinkingLevel | undefined;
	},
): ThinkingLevel | undefined {
	if (model === undefined) return settings.getDefaultThinkingLevel();
	const scopedLevel = scopedModels.find(
		(scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id,
	)?.thinkingLevel;
	return scopedLevel ?? settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel();
}

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
	if (this.session.scopedModels.length > 0) {
		return findExactModelReferenceMatch(
			searchTerm,
			this.session.scopedModels.map((scoped) => scoped.model),
		);
	}

	try {
		const cachedMatch = findExactModelReferenceMatch(searchTerm, [
			...this.session.modelRuntime.getAvailableSnapshot(),
		]);
		if (cachedMatch) return cachedMatch;
	} catch {
		// A refresh below retries the snapshot read and safely falls back to no match.
	}

	const models = await this.getModelCandidates();
	return findExactModelReferenceMatch(searchTerm, models);
};

InteractiveModeBase.prototype.getModelCandidates = async function (this: InteractiveModeBase): Promise<Model<Api>[]> {
	if (this.session.scopedModels.length > 0) {
		return this.session.scopedModels.map((scoped) => scoped.model);
	}

	const allowNetwork = !isOfflineModeEnabled();
	await boundedInteractiveModelRefresh(
		(refreshOptions) => refreshModelCatalogs(this.session.modelRuntime, refreshOptions),
		{ allowNetwork },
	);
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
			async (model, persist) => {
				try {
					await this.session.setModel(model, { persist });
					await this.updateAvailableProviderCount();
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
		return { component: selector, focus: selector, dispose: () => selector.dispose() };
	});
};

InteractiveModeBase.prototype.showModelsSelector = function (this: InteractiveModeBase): void {
	let availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
	let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
	const sessionScopedModels = this.session.scopedModels;
	const sessionScopedIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	const getConfiguredScope = (
		models: readonly Model<Api>[],
	): { enabledIds: string[]; unavailableIds: string[] } | undefined => {
		const configuredPatterns = this.settingsManager.getEnabledModels();
		if (!configuredPatterns?.length) return undefined;
		const { scopedModels, diagnostics } = resolveModelScopeFromModels(configuredPatterns, models);
		const enabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		const unavailableIds: string[] = [];
		for (const diagnostic of diagnostics) {
			if (diagnostic.code === "no-match" && !unavailableIds.includes(diagnostic.pattern)) {
				unavailableIds.push(diagnostic.pattern);
			}
		}
		return { enabledIds: [...enabledIds, ...unavailableIds], unavailableIds };
	};

	const configuredScope = getConfiguredScope(availableModels);
	let currentEnabledIds =
		sessionScopedIds.length > 0
			? [...sessionScopedIds, ...(configuredScope?.unavailableIds ?? [])]
			: (configuredScope?.enabledIds ?? null);
	let selectionChanged = false;

	const updateSessionModels = (enabledIds: string[] | null): void => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
		const allAvailableModelsEnabled =
			enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
		if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
			const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
			this.session.setScopedModels(
				newScopedModels.map((scoped) => ({ model: scoped.model, thinkingLevel: scoped.thinkingLevel })),
			);
		} else {
			this.session.setScopedModels([]);
		}
		void this.updateAvailableProviderCount();
		this.setupAutocompleteProvider();
		this.ui.requestRender();
	};

	this.showSelector((done) => {
		let disposed = false;
		const refreshAbortController = new AbortController();
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: availableModels,
				enabledModelIds: currentEnabledIds,
				refreshStatus: "Refreshing model catalogs…",
			},
			{
				onChange: (enabledIds) => {
					selectionChanged = true;
					updateSessionModels(enabledIds);
				},
				onPersist: (enabledIds) => {
					const allEnabled =
						enabledIds !== null &&
						enabledIds.length === availableModels.length &&
						enabledIds.every((id) => availableModelIds.has(id));
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
		void boundedInteractiveModelRefresh(
			(options) => refreshModelCatalogs(this.session.modelRuntime, options),
			{ allowNetwork: !isOfflineModeEnabled() },
			refreshAbortController.signal,
		)
			.then((outcome) => {
				if (disposed) return;
				availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
				availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
				if (!selectionChanged) {
					const refreshedConfiguredScope = getConfiguredScope(availableModels);
					currentEnabledIds =
						sessionScopedIds.length > 0
							? [...sessionScopedIds, ...(refreshedConfiguredScope?.unavailableIds ?? [])]
							: (refreshedConfiguredScope?.enabledIds ?? null);
					selector.updateModels(availableModels, currentEnabledIds);
				} else {
					selector.updateModels(availableModels);
				}
				if (outcome.status === "timed-out") {
					selector.setRefreshStatus("Model refresh timed out; showing cached models.", "warning");
				} else if (outcome.status === "aborted") {
					selector.setRefreshStatus("Model refresh was cancelled; showing cached models.", "warning");
				} else if (outcome.status === "rejected") {
					selector.setRefreshStatus("Could not refresh model catalogs; showing cached models.", "warning");
				} else if (outcome.value.aborted) {
					selector.setRefreshStatus("Model refresh was cancelled; showing cached models.", "warning");
				} else if (outcome.value.errors.size === 1) {
					selector.setRefreshStatus(
						`Could not refresh ${outcome.value.errors.keys().next().value}; showing cached models.`,
						"warning",
					);
				} else if (outcome.value.errors.size > 1) {
					selector.setRefreshStatus(
						`Could not refresh ${outcome.value.errors.size} model catalogs; showing cached models.`,
						"warning",
					);
				} else {
					selector.setRefreshStatus("Model catalogs refreshed.", "success");
				}
				this.ui.requestRender();
			})
			.catch(() => {
				if (disposed) return;
				selector.setRefreshStatus("Could not update cached models; showing cached models.", "warning");
				this.ui.requestRender();
			});
		return {
			component: selector,
			focus: selector,
			dispose: () => {
				disposed = true;
				refreshAbortController.abort();
			},
		};
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

InteractiveModeBase.prototype.handleThinkingCommand = function (this: InteractiveModeBase, searchTerm?: string): void {
	if (!searchTerm) {
		this.showThinkingSelector();
		return;
	}
	const levels = this.session.getAvailableThinkingLevels();
	const normalized = searchTerm.trim().toLowerCase();
	const level = levels.find((candidate) => candidate === normalized);
	if (!level) {
		this.showError(`Unknown thinking level "${searchTerm}". Available levels: ${levels.join(", ")}.`);
		return;
	}
	this.selectThinkingLevel(level, false);
};

InteractiveModeBase.prototype.selectThinkingLevel = function (
	this: InteractiveModeBase,
	level: ThinkingLevel,
	persist: boolean,
): void {
	this.session.setThinkingLevel(level, { persist });
	this.footer.invalidate();
	this.updateEditorBorderColor();
	this.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
};

InteractiveModeBase.prototype.showThinkingSelector = function (this: InteractiveModeBase): void {
	this.showSelector((done) => {
		const select = (level: ThinkingLevel, persist: boolean) => {
			this.selectThinkingLevel(level, persist);
			done();
		};
		const model = this.session.model;
		const availableLevels = this.session.getAvailableThinkingLevels();
		const rawDefault = resolveSessionThinkingDefault(model, this.session.scopedModels, this.settingsManager);
		const selector = new ThinkingSelectorComponent(
			this.session.thinkingLevel,
			availableLevels,
			(level) => select(level, false),
			() => done(),
			(level) => select(level, true),
			resolveThinkingSelectorDefault(rawDefault, availableLevels, model),
		);
		return { component: selector, focus: selector };
	});
};
