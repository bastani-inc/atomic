import { clampThinkingLevel, getSupportedThinkingLevels } from "../models.ts";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "./diagnostics.ts";

/** Diagnostic type recorded when thinking `off` ran at a model's lowest supported level instead. */
export const THINKING_OFF_FALLBACK_DIAGNOSTIC = "thinking_off_fallback";

/**
 * The level a request for thinking `off` runs at on a reasoning model whose `thinkingLevelMap.off` is
 * `null`: its lowest supported level. `undefined` when the model can disable thinking or has no level.
 */
export function getThinkingOffFallbackLevel(model: Model<Api>): ThinkingLevel | undefined {
	const level = clampThinkingLevel(model, "off");
	return level === "off" ? undefined : level;
}

export function appendThinkingOffFallbackDiagnostic(
	output: AssistantMessage,
	thinkingLevel: ThinkingLevel,
	providerThinkingLevel: string,
): void {
	appendAssistantMessageDiagnostic(output, {
		type: THINKING_OFF_FALLBACK_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { requestedThinkingLevel: "off", thinkingLevel, providerThinkingLevel },
	});
}

/**
 * Resolve thinking `off` for a request that sends a level's `thinkingLevelMap` value as the effort, such as
 * the Responses, Chat Completions and Mistral APIs. Falls back to the lowest supported level the map lists
 * an effort for, because these endpoints reject an effort the model does not support, and a level the map
 * leaves unlisted does not say which effort is safe. Returns the fallback level, recorded on `output`.
 */
export function recordThinkingOffFallback(model: Model<Api>, output: AssistantMessage): ThinkingLevel | undefined {
	for (const level of getSupportedThinkingLevels(model)) {
		if (level === "off") return undefined;
		const effort = model.thinkingLevelMap?.[level];
		if (typeof effort !== "string") continue;
		appendThinkingOffFallbackDiagnostic(output, level, effort);
		return level;
	}
	return undefined;
}

/**
 * Resolve thinking `off` to the model's lowest supported level, for an endpoint that maps any effort onto the
 * ones the model supports. The level's `thinkingLevelMap` value, or the level itself when the map lists none,
 * is the effort sent. Returns the fallback level, recorded on `output`.
 */
export function recordLowestThinkingOffFallback(
	model: Model<Api>,
	output: AssistantMessage,
): ThinkingLevel | undefined {
	const level = getThinkingOffFallbackLevel(model);
	if (level === undefined) return undefined;
	const effort = model.thinkingLevelMap?.[level];
	appendThinkingOffFallbackDiagnostic(output, level, typeof effort === "string" ? effort : level);
	return level;
}
