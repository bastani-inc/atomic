import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@earendil-works/pi-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { type ModelCycleResult, THINKING_LEVELS } from "./agent-session-types.ts";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

export async function _getRequiredRequestAuth(
	this: AgentSession,
	model: Model<Api>,
): Promise<{
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}> {
	let result: Awaited<ReturnType<AgentSession["_modelRuntime"]["getAuth"]>>;
	try {
		result = await this._modelRuntime.getAuth(model);
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}
		throw error;
	}
	if (result && (result.auth.apiKey || result.auth.headers)) {
		const headers = result.auth.headers
			? Object.fromEntries(
					Object.entries(result.auth.headers).filter((entry): entry is [string, string] => entry[1] !== null),
				)
			: undefined;
		return { apiKey: result.auth.apiKey, headers, env: result.env };
	}
	if (this._modelRuntime.isUsingOAuth(model.provider)) {
		throw new Error(
			`Authentication failed for "${model.provider}". Credentials may have expired or network is unavailable. Run '/login ${model.provider}' to re-authenticate.`,
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

export function _emitModelChanged(
	this: AgentSession,
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

export async function _emitModelSelect(
	this: AgentSession,
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
	if (!this._modelRuntime.hasConfiguredAuth(model.provider)) {
		throw new Error(`No API key for ${model.provider}/${model.id}`);
	}
	this._clearFallbackModelScope?.();

	const previousModel = this.model;
	const thinkingLevel = this._getThinkingLevelForModelSwitch();
	const nextModel = model;
	this.agent.state.model = nextModel;
	this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
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

export async function cycleModel(
	this: AgentSession,
	direction: "forward" | "backward" = "forward",
): Promise<ModelCycleResult | undefined> {
	if (this._scopedModels.length > 0) {
		return this._cycleScopedModel(direction);
	}
	return this._cycleAvailableModel(direction);
}

export async function _cycleScopedModel(
	this: AgentSession,
	direction: "forward" | "backward",
): Promise<ModelCycleResult | undefined> {
	const scopedModels = this._scopedModels.filter((scoped) =>
		this._modelRuntime.hasConfiguredAuth(scoped.model.provider),
	);
	if (scopedModels.length <= 1) return undefined;

	const currentModel = this.model;
	let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = scopedModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const next = scopedModels[nextIndex];
	const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
	const nextModel = next.model;

	// An explicit cycle cancels any pending per-turn fallback restoration.
	this._clearFallbackModelScope?.();
	this.agent.state.model = nextModel;
	this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
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

export async function _cycleAvailableModel(
	this: AgentSession,
	direction: "forward" | "backward",
): Promise<ModelCycleResult | undefined> {
	const availableModels = await this._modelRuntime.getAvailableSnapshot();
	if (availableModels.length <= 1) return undefined;

	const currentModel = this.model;
	let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

	if (currentIndex === -1) currentIndex = 0;
	const len = availableModels.length;
	const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
	const selectedModel = availableModels[nextIndex];

	const thinkingLevel = this._getThinkingLevelForModelSwitch();
	// An explicit cycle cancels any pending per-turn fallback restoration.
	this._clearFallbackModelScope?.();
	this.agent.state.model = selectedModel;
	this.sessionManager.appendModelChange(selectedModel.provider, selectedModel.id);
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
		// A reasoning choice is not a model choice, so it must not strand the
		// session on a fallback candidate: keep the pending restore. Carry the
		// explicit level into the scope so the restore does not overwrite it.
		// (A no-op level assignment — a registry refresh re-applying the current
		// level — changes nothing here.)
		if (this._fallbackOriginModel !== undefined) this._fallbackOriginThinkingLevel = effectiveLevel;
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

export function _clampThinkingLevel(
	this: AgentSession,
	level: ThinkingLevel,
	_availableLevels: ThinkingLevel[],
): ThinkingLevel {
	return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
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
};
