import { type Api, clampThinkingLevel, type Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

/** The settings a model switch reads its starting level from. */
export interface ModelSwitchThinkingSettings {
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
}

export interface ModelSwitchThinkingContext {
	readonly settings: ModelSwitchThinkingSettings;
	/** The model switched away from and its level; no model before one is chosen. */
	readonly current?: { readonly model: Model<Api> | undefined; readonly thinkingLevel: ThinkingLevel };
}

/**
 * The level a switch to `target` asks for, before it is clamped to what `target` supports: the target's saved
 * per-model level, else the current level when the current model reasons, else the default level.
 */
export function requestedThinkingLevelForModelSwitch(
	target: Model<Api> | undefined,
	context: ModelSwitchThinkingContext,
): ThinkingLevel {
	const saved = target ? context.settings.getModelThinkingLevel(target.provider, target.id) : undefined;
	if (saved !== undefined) return saved;
	if (context.current?.model?.reasoning) return context.current.thinkingLevel;
	return context.settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
}

/** The level `target` runs at once a switch selects it, so a model list can show it beside the ID (#4269). */
export function thinkingLevelForModelSwitch(target: Model<Api>, context: ModelSwitchThinkingContext): ThinkingLevel {
	return clampThinkingLevel(target, requestedThinkingLevelForModelSwitch(target, context)) as ThinkingLevel;
}
