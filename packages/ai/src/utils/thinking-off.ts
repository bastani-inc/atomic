import { clampThinkingLevel } from "../models.ts";
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
 * Resolve thinking `off` for a Responses request, which sends a level's `thinkingLevelMap` value as the
 * effort. Falls back only to a level the map lists, because these endpoints reject an effort the model
 * does not support, and a map that lists none (such as the Azure GPT-5.x catalog entries) does not say
 * which effort is safe. Returns the fallback level, recorded on `output`.
 */
export function recordThinkingOffFallback(model: Model<Api>, output: AssistantMessage): ThinkingLevel | undefined {
	const level = getThinkingOffFallbackLevel(model);
	const effort = level === undefined ? undefined : model.thinkingLevelMap?.[level];
	if (level === undefined || typeof effort !== "string") return undefined;
	appendThinkingOffFallbackDiagnostic(output, level, effort);
	return level;
}
