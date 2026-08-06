import type { ModelFallbackFailureKind, ModelFallbackFailureSignal, ModelFallbackFailureSource } from "@bastani/atomic";
import {
	errorMessage,
	isRetryableModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "@bastani/atomic";
import {
	type ModelInfo as AvailableModelInfo,
	splitKnownThinkingSuffix,
	THINKING_LEVELS,
} from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo, ModelFallbackFailureKind, ModelFallbackFailureSignal, ModelFallbackFailureSource };
export { errorMessage, isRetryableModelFailure, modelFailureMessage, normalizeModelFailureSignal };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	error?: string;
	usage?: Usage;
}

function applyFallbackThinkingLevel(model: string, thinkingLevel: string | undefined): string {
	if (!thinkingLevel || !THINKING_LEVELS.some((level) => level === thinkingLevel)) return model;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	return thinkingSuffix ? model : `${model}:${thinkingLevel}`;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	return applyFallbackThinkingLevel(model, thinking);
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	currentModel?: string,
	fallbackThinkingLevels?: string[],
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const fallbackEntries = (fallbackModels ?? []).map((model, index) =>
		applyFallbackThinkingLevel(model, fallbackThinkingLevels?.[index]),
	);
	for (const raw of [primaryModel, ...fallbackEntries, currentModel]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

export function currentModelFullId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${String(model.provider)}/${model.id}`;
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || "model failure";
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
