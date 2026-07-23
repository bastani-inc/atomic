import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@earendil-works/pi-ai/compat";
import { getModelDefaultContextWindow, getSupportedContextWindows, selectContextWindow } from "./context-window.ts";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS, THINKING_LEVELS, type ContextWindowReplayRequest, type ContextWindowReplaySource, type ModelCycleResult } from "./agent-session-types.ts";

export async function _getRequiredRequestAuth(this: AgentSession, model: Model<Api>): Promise<{
	apiKey: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}> {
	const result = await this._modelRegistry.getApiKeyAndHeaders(model);
	if (!result.ok) {
		if (result.error.startsWith("No API key found")) {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}
		throw new Error(result.error);
	}
	if (result.apiKey) {
		return { apiKey: result.apiKey, headers: result.headers, baseUrl: result.baseUrl };
	}

	const isOAuth = this._modelRegistry.isUsingOAuth(model);
	if (isOAuth) {
		throw new Error(
			`Authentication failed for "${model.provider}". ` +
				`Credentials may have expired or network is unavailable. ` +
				`Run '/login ${model.provider}' to re-authenticate.`,
		);
	}
	throw new Error(formatNoApiKeyFoundMessage(model.provider));
}

/**
 * Install tool hooks once on the Agent instance.
 *
 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
 * registered tool execution to the extension context. Tool call and tool result interception now
 * happens here instead of in wrappers.
 */

export function _emitModelChanged(this: AgentSession, 
	nextModel: Model<Api>,
	previousModel: Model<Api> | undefined,
	source: "set" | "cycle" | "restore" | "fallback",
): void {
	if (modelsAreEqual(previousModel, nextModel)) return;
	this._emit({
		type: "model_changed",
		model: nextModel,
		previousModel,
		source,
	});
}


export async function _emitModelSelect(this: AgentSession, 
	nextModel: Model<Api>,
	previousModel: Model<Api> | undefined,
	source: "set" | "cycle" | "restore" | "fallback",
): Promise<void> {
	if (modelsAreEqual(previousModel, nextModel)) return;
	await this._extensionRunner.emit({
		type: "model_select",
		model: nextModel,
		previousModel,
		source,
	});
}

/**
 * Set model directly.
 * Validates that auth is configured, saves to session and settings.
 * @throws Error if no auth is configured for the model
 */

export async function setModel(this: AgentSession, model: Model<Api>): Promise<void> {
	if (!this._modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No API key for ${model.provider}/${model.id}`);
	}

	const previousModel = this.model;
	const thinkingLevel = this._getThinkingLevelForModelSwitch();
	const nextModel = this._withContextWindowForModelSwitch(model);
	this.agent.state.model = nextModel;
	this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
	this._appendContextWindowChangeIfChanged(previousModel, nextModel);
	this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

	// Re-clamp thinking level for new model's capabilities
	this.setThinkingLevel(thinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();

	this._emitModelChanged(nextModel, previousModel, "set");
	await this._emitModelSelect(nextModel, previousModel, "set");
}

/**
 * Cycle to next/previous model.
 * Uses scoped models (from --models flag) if available, otherwise all available models.
 * @param direction - "forward" (default) or "backward"
 * @returns The new model info, or undefined if only one model available
 */

export async function cycleModel(this: AgentSession, direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
	if (this._scopedModels.length > 0) {
		return this._cycleScopedModel(direction);
	}
	return this._cycleAvailableModel(direction);
}


export async function _cycleScopedModel(this: AgentSession, direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
	const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
	if (scopedModels.length <= 1) return undefined;

	const currentModel = this.model;
	let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = scopedModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const next = scopedModels[nextIndex];
	const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
	const nextModel = this._withContextWindowForModelSwitch(next.model);

	// Apply model
	this.agent.state.model = nextModel;
	this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
	this._appendContextWindowChangeIfChanged(currentModel, nextModel);
	this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

	// Apply thinking level.
	// - Explicit scoped model thinking level overrides current session level
	// - Undefined scoped model thinking level inherits the current session preference
	// setThinkingLevel clamps to model capabilities.
	this.setThinkingLevel(thinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();

	this._emitModelChanged(nextModel, currentModel, "cycle");
	await this._emitModelSelect(nextModel, currentModel, "cycle");

	return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: true };
}


export async function _cycleAvailableModel(this: AgentSession, direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
	const availableModels = await this._modelRegistry.getAvailable();
	if (availableModels.length <= 1) return undefined;

	const currentModel = this.model;
	let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = availableModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const selectedModel = this._withContextWindowForModelSwitch(availableModels[nextIndex]);

	const thinkingLevel = this._getThinkingLevelForModelSwitch();
	this.agent.state.model = selectedModel;
	this.sessionManager.appendModelChange(selectedModel.provider, selectedModel.id);
	this._appendContextWindowChangeIfChanged(currentModel, selectedModel);
	this.settingsManager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);

	// Re-clamp thinking level for new model's capabilities
	this.setThinkingLevel(thinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();

	this._emitModelChanged(selectedModel, currentModel, "cycle");
	await this._emitModelSelect(selectedModel, currentModel, "cycle");

	return { model: selectedModel, thinkingLevel: this.thinkingLevel, isScoped: false };
}

// =========================================================================
// Thinking Level Management
// =========================================================================

/**
 * Set thinking level.
 * Clamps to model capabilities based on available thinking levels.
 * Saves to session and settings only if the level actually changes.
 */

export function setThinkingLevel(this: AgentSession, level: ThinkingLevel): void {
	const availableLevels = this.getAvailableThinkingLevels();
	const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

	// Only persist if actually changing
	const previousLevel = this.agent.state.thinkingLevel;
	const isChanging = effectiveLevel !== previousLevel;

	this.agent.state.thinkingLevel = effectiveLevel;

	if (isChanging) {
		this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		this._refreshBaseSystemPromptFromActiveTools();
		if (this.supportsThinking() || effectiveLevel !== "off") {
			this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
		}
		this._emit({ type: "thinking_level_changed", level: effectiveLevel });
		void this._extensionRunner.emit({
			type: "thinking_level_select",
			level: effectiveLevel,
			previousLevel,
		});
	}
}

/**
 * Cycle to next thinking level.
 * @returns New level, or undefined if model doesn't support thinking
 */

export function cycleThinkingLevel(this: AgentSession): ThinkingLevel | undefined {
	if (!this.supportsThinking()) return undefined;

	const levels = this.getAvailableThinkingLevels();
	const currentIndex = levels.indexOf(this.thinkingLevel);
	const nextIndex = (currentIndex + 1) % levels.length;
	const nextLevel = levels[nextIndex];

	this.setThinkingLevel(nextLevel);
	return nextLevel;
}

/**
 * Get available thinking levels for current model.
 * The provider will clamp to what the specific model supports internally.
 */

export function getAvailableThinkingLevels(this: AgentSession): ThinkingLevel[] {
	if (!this.model) return THINKING_LEVELS;
	return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
}

/**
 * Check if current model supports thinking/reasoning.
 */

export function supportsThinking(this: AgentSession): boolean {
	return !!this.model?.reasoning;
}


export function _getThinkingLevelForModelSwitch(this: AgentSession, explicitLevel?: ThinkingLevel): ThinkingLevel {
	if (explicitLevel !== undefined) {
		return explicitLevel;
	}
	if (!this.supportsThinking()) {
		return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}
	return this.thinkingLevel;
}


export function _clampThinkingLevel(this: AgentSession, level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
	return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
}

// =========================================================================
// Context Window Management
// =========================================================================


export function getAvailableContextWindows(this: AgentSession): number[] {
	return this.model ? getSupportedContextWindows(this.model) : [];
}


export function supportsContextWindowSelection(this: AgentSession): boolean {
	return this.getAvailableContextWindows().length > 1;
}


export function setContextWindow(this: AgentSession, contextWindow: number, options: { persistDefault?: boolean } = {}): void {
	if (!this.model) {
		throw new Error("No model selected");
	}
	const selected = selectContextWindow(this.model, contextWindow, COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS);
	if ("error" in selected) {
		throw new Error(selected.error);
	}

	const previousContextWindow = this.model.contextWindow;
	const isChanging = previousContextWindow !== selected.contextWindow;
	this.agent.state.model = selected.model;

	if (isChanging) {
		this.sessionManager.appendContextWindowChange(selected.contextWindow);
		this._emit({ type: "context_window_changed", contextWindow: selected.contextWindow });
	}
	if (options.persistDefault === true) {
		this.settingsManager.setDefaultContextWindowForModel(selected.model.provider, selected.model.id, selected.contextWindow);
	}
}


export function _withContextWindowForModelSwitch(this: AgentSession, model: Model<Api>): Model<Api> {
	// A source model's scalar contextWindow can be its natural default (for example a 1m-default
	// model). Do not treat that alone as an opt-in to larger windows on a 400k-default target.
	const settingsDefaultContextWindow = this._getSettingsContextWindowRequestForModel(model)?.contextWindow;
	const candidates: number[] = [];
	const targetDefaultContextWindow = getModelDefaultContextWindow(model);
	if (model.contextWindow !== targetDefaultContextWindow) {
		// Preserve an explicit context-window selection already applied to the target model
		// (for example a caller passing selectContextWindow(target, 1m).model).
		candidates.push(model.contextWindow);
	}
	const currentModel = this.model;
	if (currentModel && this._shouldCarryCurrentContextWindowForModelSwitch(currentModel, settingsDefaultContextWindow)) {
		candidates.push(currentModel.contextWindow);
	}
	if (settingsDefaultContextWindow !== undefined) {
		candidates.push(settingsDefaultContextWindow);
	}
	candidates.push(targetDefaultContextWindow);

	for (const candidate of candidates) {
		const selected = selectContextWindow(model, candidate, COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS);
		if (!("error" in selected)) return selected.model;
	}
	return model;
}


export function _shouldCarryCurrentContextWindowForModelSwitch(this: AgentSession, 
	currentModel: Model<Api>,
	settingsDefaultContextWindow: number | undefined,
): boolean {
	if (currentModel.contextWindow !== getModelDefaultContextWindow(currentModel)) {
		return true;
	}
	if (this.sessionManager.getBranch().some((entry) => entry.type === "context_window_change")) {
		return true;
	}
	return (
		settingsDefaultContextWindow !== undefined &&
		currentModel.contextWindow === settingsDefaultContextWindow &&
		getSupportedContextWindows(currentModel).includes(settingsDefaultContextWindow)
	);
}


export function _getSettingsContextWindowRequestForModel(this: AgentSession, model: Model<Api>): ContextWindowReplayRequest | undefined {
	const modelContextWindow = this.settingsManager.getDefaultContextWindowForModel(model.provider, model.id);
	if (modelContextWindow !== undefined) {
		return { contextWindow: modelContextWindow, source: "model-settings" };
	}
	const globalContextWindow = this.settingsManager.getDefaultContextWindow();
	return globalContextWindow === undefined
		? undefined
		: { contextWindow: globalContextWindow, source: "global-settings" };
}


export function _getContextWindowReplayForModel(this: AgentSession, 
	model: Model<Api>,
	requestedContextWindow: number | undefined,
	source: ContextWindowReplaySource | undefined,
): { model: Model<Api>; contextWindow: number; wouldWarn: boolean } {
	if (requestedContextWindow !== undefined) {
		const selected = selectContextWindow(model, requestedContextWindow, COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS);
		if (!("error" in selected)) {
			return { model: selected.model, contextWindow: selected.contextWindow, wouldWarn: false };
		}
		return this._getDefaultContextWindowReplayForModel(model, source !== "global-settings");
	}

	return this._getDefaultContextWindowReplayForModel(model, false);
}


export function _getDefaultContextWindowReplayForModel(this: AgentSession, 
	model: Model<Api>,
	wouldWarn: boolean,
): { model: Model<Api>; contextWindow: number; wouldWarn: boolean } {
	const defaultContextWindow = getModelDefaultContextWindow(model);
	const selected = selectContextWindow(model, defaultContextWindow, COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS);
	if (!("error" in selected)) {
		return { model: selected.model, contextWindow: selected.contextWindow, wouldWarn };
	}
	return {
		model: { ...model, contextWindow: defaultContextWindow, defaultContextWindow },
		contextWindow: defaultContextWindow,
		wouldWarn,
	};
}


export function _getResumeContextWindowReplayForModel(this: AgentSession, 
	model: Model<Api>,
): { model: Model<Api>; contextWindow: number; wouldWarn: boolean } {
	const sessionContext = this.sessionManager.buildSessionContext();
	if (sessionContext.contextWindow !== undefined) {
		return this._getContextWindowReplayForModel(model, sessionContext.contextWindow, "session");
	}
	const settingsContextWindow = this._getSettingsContextWindowRequestForModel(model);
	return this._getContextWindowReplayForModel(model, settingsContextWindow?.contextWindow, settingsContextWindow?.source);
}


export function _applyContextWindowReplay(this: AgentSession, contextWindow: number | undefined): void {
	if (!this.model) return;
	const previousContextWindow = this.model.contextWindow;
	const settingsContextWindow = this._getSettingsContextWindowRequestForModel(this.model);
	const requestedContextWindow = contextWindow ?? settingsContextWindow?.contextWindow;
	const source: ContextWindowReplaySource | undefined = contextWindow !== undefined ? "session" : settingsContextWindow?.source;
	const replay = this._getContextWindowReplayForModel(this.model, requestedContextWindow, source);
	this.agent.state.model = replay.model;
	if (previousContextWindow !== replay.contextWindow) {
		this._emit({ type: "context_window_changed", contextWindow: replay.contextWindow });
	}
}


export function _appendContextWindowChangeIfChanged(this: AgentSession, 
	previousModel: Model<Api> | undefined,
	nextModel: Model<Api>,
): void {
	const replay = this._getResumeContextWindowReplayForModel(nextModel);
	if (!replay.wouldWarn && nextModel.contextWindow === replay.contextWindow) return;
	this.sessionManager.appendContextWindowChange(nextModel.contextWindow);
	if (previousModel?.contextWindow !== nextModel.contextWindow) {
		this._emit({ type: "context_window_changed", contextWindow: nextModel.contextWindow });
	}
}

// =========================================================================
// Queue Mode Management
// =========================================================================

/**
 * Set steering message mode.
 * Saves to settings.
 */

export const agentSessionModelsMethods = {
	_getRequiredRequestAuth,
	_emitModelChanged,
	_emitModelSelect,
	setModel,
	cycleModel,
	_cycleScopedModel,
	_cycleAvailableModel,
	setThinkingLevel,
	cycleThinkingLevel,
	getAvailableThinkingLevels,
	supportsThinking,
	_getThinkingLevelForModelSwitch,
	_clampThinkingLevel,
	getAvailableContextWindows,
	supportsContextWindowSelection,
	setContextWindow,
	_withContextWindowForModelSwitch,
	_shouldCarryCurrentContextWindowForModelSwitch,
	_getSettingsContextWindowRequestForModel,
	_getContextWindowReplayForModel,
	_getDefaultContextWindowReplayForModel,
	_getResumeContextWindowReplayForModel,
	_applyContextWindowReplay,
	_appendContextWindowChangeIfChanged,
};
