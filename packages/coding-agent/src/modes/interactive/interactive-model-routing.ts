import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { normalizeProviderId } from "@bastani/atomic-ai";
import { clampThinkingLevel, modelsAreEqual } from "@bastani/atomic-ai/compat";
import { boundedInteractiveModelRefresh } from "../../core/bounded-model-refresh.ts";
import { formatModelLabel } from "../../core/model-label.ts";
import { thinkingLevelForModelSwitch } from "../../core/model-switch-thinking-level.ts";
import { isOfflineModeEnabled } from "../../core/package-manager-env.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { promptHandle } from "./agent-view/agent-drafts.ts";
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
import { mergeRestoredDraft } from "./interactive-prompt-restore.ts";
import { onPreliminaryCatalogWithdrawn } from "./interactive-startup-trust.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";

/** A selector already showing a restricted catalog owns its rows and the effort offered for each row. */
function pendingModelView(mode: InteractiveModeBase) {
	const runtime = mode.runtimeHost;
	const isCurrent =
		runtime instanceof IsolatedInteractiveRuntime
			? runtime.captureStartupCatalog()
			: runtime?.isProjectTrustPending?.() && !runtime.pendingProjectResourcesTrusted?.()
				? () => runtime.isProjectTrustPending() && !mode.settingsManager.isProjectTrusted()
				: undefined;
	if (!isCurrent) return undefined;
	const levels = mode.settingsManager.getAllModelThinkingLevels();
	const fallback = mode.settingsManager.getDefaultThinkingLevel();
	return {
		isCurrent,
		settings: {
			getModelThinkingLevel: (provider: string, modelId: string) =>
				levels[`${normalizeProviderId(provider)}/${modelId}`],
			getDefaultThinkingLevel: () => fallback,
		},
	};
}

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
			await this.session.setModel(model, { persist: true });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Model: ${formatModelLabel(model, { thinkingLevel: this.session.thinkingLevel })}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	this.showModelSelector(searchTerm);
};

/**
 * The model `searchTerm` names exactly among the models known without a refresh: the scoped models when there are any,
 * else the available models already loaded.
 */
export function cachedExactModelMatch(mode: InteractiveModeBase, searchTerm: string): Model<Api> | undefined {
	if (mode.session.scopedModels.length > 0) {
		return findExactModelReferenceMatch(
			searchTerm,
			mode.session.scopedModels.map((scoped) => scoped.model),
		);
	}
	try {
		return findExactModelReferenceMatch(searchTerm, [...mode.session.modelRuntime.getAvailableSnapshot()]);
	} catch {
		// A refresh retries the snapshot read and safely falls back to no match.
		return undefined;
	}
}

InteractiveModeBase.prototype.findExactModelMatch = async function (
	this: InteractiveModeBase,
	searchTerm: string,
): Promise<Model<Api> | undefined> {
	const cachedMatch = cachedExactModelMatch(this, searchTerm);
	if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

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

InteractiveModeBase.prototype.showModelSelector = function showModelSelector(
	this: InteractiveModeBase,
	initialSearchInput?: string,
	previous?: ModelSelectorComponent,
): void {
	this.showSelector((done) => {
		let settled = false;
		const selector = new ModelSelectorComponent(
			this.ui,
			this.session.model,
			this.settingsManager,
			this.session.modelRuntime,
			this.session.scopedModels,
			async (model, thinkingLevel) => {
				if (settled) return;
				settled = true;
				try {
					await this.session.setModel(model, { persist: true, thinkingLevel });
					await this.updateAvailableProviderCount();
					this.footer.invalidate();
					this.updateEditorBorderColor();
					done();
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
					this.showStatus(`Model: ${formatModelLabel(model, { thinkingLevel: this.session.thinkingLevel })}`);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				if (settled) return;
				settled = true;
				done();
				this.ui.requestRender();
			},
			initialSearchInput,
			this.session.thinkingLevel,
			pendingModelView(this),
		);
		if (previous) selector.selector.restoreNavigation(previous.selector, true);
		const unsubscribe = onPreliminaryCatalogWithdrawn(this, () => showModelSelector.call(this, undefined, selector));
		return {
			component: selector,
			focus: selector,
			dispose: () => {
				unsubscribe?.();
				selector.dispose();
			},
		};
	});
};

InteractiveModeBase.prototype.showModelsSelector = function showModelsSelector(
	this: InteractiveModeBase,
	previous?: ScopedModelsSelectorComponent,
): void {
	const view = pendingModelView(this);
	const initial = view ? { model: this.session.model, thinkingLevel: this.session.thinkingLevel } : undefined;
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
				// The level Ctrl+P cycling gives each model: its scoped level, else the level a switch to it applies.
				thinkingLevelFor: (model) => {
					const current = initial ?? { model: this.session.model, thinkingLevel: this.session.thinkingLevel };
					if (modelsAreEqual(current.model, model)) return current.thinkingLevel;
					const scoped = (view ? sessionScopedModels : this.session.scopedModels).find((entry) =>
						modelsAreEqual(entry.model, model),
					);
					return scoped?.thinkingLevel !== undefined
						? clampThinkingLevel(model, scoped.thinkingLevel)
						: thinkingLevelForModelSwitch(model, {
								settings: view?.settings ?? this.settingsManager,
								current,
							});
				},
			},
			{
				onChange: (enabledIds) => {
					selectionChanged = true;
					const allEnabled =
						enabledIds !== null &&
						enabledIds.length === availableModels.length &&
						enabledIds.every((id) => availableModelIds.has(id));
					const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
					this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
					updateSessionModels(enabledIds);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			},
		);
		if (previous) selector.selector.restoreNavigation(previous.selector, true);
		const unsubscribe = onPreliminaryCatalogWithdrawn(this, () => showModelsSelector.call(this, selector));
		void boundedInteractiveModelRefresh(
			(options) => refreshModelCatalogs(this.session.modelRuntime, options),
			{ allowNetwork: !isOfflineModeEnabled() },
			refreshAbortController.signal,
		)
			.then((outcome) => {
				if (disposed) return;
				if (!view || view.isCurrent()) {
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
				unsubscribe?.();
				refreshAbortController.abort();
			},
		};
	});
};

InteractiveModeBase.prototype.showUserMessageSelector = async function (this: InteractiveModeBase): Promise<void> {
	// Opened from a subagent's view, the forked message joins main's own draft instead of replacing it.
	const fromSubagentView = this.agentView?.viewed.kind === "agent";
	await this.ensureDeferredStartupComplete();
	// A session opened at its context window lists its older prompts from the store, keeping only their labels' starts.
	const manager = this.session.sessionManager;
	const stored =
		manager?.hasFullHistory?.() === false
			? await (await import("./components/user-message-selector-archive.js")).ForkPromptArchive.open(manager)
			: undefined;
	const userMessages: Array<{ entryId: string; text: string; partial?: true }> =
		stored?.prompts ?? this.session.getUserMessagesForForking();

	if (userMessages.length === 0) {
		stored?.archive.dispose();
		this.showStatus("No messages to fork from");
		return;
	}

	const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

	this.showSelector((done) => {
		let selectionHandled = false;
		const selector = new UserMessageSelectorComponent(
			userMessages.map((m) => ({ id: m.entryId, text: m.text, ...(m.partial ? { partial: true } : {}) })),
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
					if (fromSubagentView) {
						const prompt = promptHandle(this, "main");
						prompt.setText(mergeRestoredDraft(result.selectedText ?? "", prompt.getExpandedText()));
					} else this.editor.setText(result.selectedText ?? "");
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
			stored
				? {
						readText: (id, signal) => stored.archive.readText(id, signal),
						onUpdate: () => this.ui.requestRender(),
						onError: (error) => this.showError(error.message),
					}
				: {},
		);
		return {
			component: selector,
			focus: selector.getMessageList(),
			dispose: () => {
				selector.dispose();
				stored?.archive.dispose();
			},
		};
	});
};

InteractiveModeBase.prototype.handleThinkingCommand = async function (
	this: InteractiveModeBase,
	searchTerm?: string,
): Promise<void> {
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
	await this.selectThinkingLevel(level);
};

InteractiveModeBase.prototype.selectThinkingLevel = async function (
	this: InteractiveModeBase,
	level: ThinkingLevel,
): Promise<void> {
	await this.session.setThinkingLevel(level, { persist: true });
	this.footer.invalidate();
	this.updateEditorBorderColor();
	this.showStatus(`Thinking level: ${level}`);
};

InteractiveModeBase.prototype.showThinkingSelector = function (this: InteractiveModeBase): void {
	this.showSelector((done) => {
		const select = async (level: ThinkingLevel) => {
			try {
				await this.selectThinkingLevel(level);
				done();
			} catch (error) {
				selector.selector.retrySelection();
				this.showError(error instanceof Error ? error.message : String(error));
			}
		};
		const model = this.session.model;
		const availableLevels = this.session.getAvailableThinkingLevels();
		const rawDefault = resolveSessionThinkingDefault(model, this.session.scopedModels, this.settingsManager);
		const selector = new ThinkingSelectorComponent(
			this.session.thinkingLevel,
			availableLevels,
			select,
			() => done(),
			resolveThinkingSelectorDefault(rawDefault, availableLevels, model),
		);
		return { component: selector, focus: selector };
	});
};
