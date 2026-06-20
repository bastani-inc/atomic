import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ContextCompactionStats } from "../session-manager.ts";
import type { ContextCompactionBudgetToolDetails } from "./context-deletion-tool-definitions.ts";
import type { ContextCompactionParameters, ValidatedContextDeletionResult } from "./context-compaction-types.ts";

export function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createContextDeletionToolResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: "text", text }], details, terminate: false };
}

export function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

export function percentOf(part: number, total: number): number {
	return total > 0 ? roundPercent((part / total) * 100) : 0;
}

export function finitePositiveNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function contextCompactionTargetReductionPercent(parameters: ContextCompactionParameters): number {
	return roundPercent((1 - parameters.compression_ratio) * 100);
}

export function contextCompactionTargetLabel(parameters: ContextCompactionParameters): string {
	return `${contextCompactionTargetReductionPercent(parameters)}%`;
}

export function createContextCompactionBudgetDetails(
	stats: ContextCompactionStats,
	callCount: number,
	contextWindow: number | undefined,
	parameters: ContextCompactionParameters,
): ContextCompactionBudgetToolDetails {
	const targetTokensAfter = Math.max(0, Math.floor(stats.tokensBefore * parameters.compression_ratio));
	const targetReductionPercent = contextCompactionTargetReductionPercent(parameters);
	const details: ContextCompactionBudgetToolDetails = {
		...(contextWindow !== undefined ? { contextWindow } : {}),
		compression_ratio: parameters.compression_ratio,
		tokensBefore: stats.tokensBefore,
		currentTokensAfter: stats.tokensAfter,
		deletedTokens: Math.max(0, stats.tokensBefore - stats.tokensAfter),
		currentReductionPercent: stats.percentReduction,
		targetReductionPercent,
		targetTokensAfter,
		tokensToDeleteForTarget: Math.max(0, stats.tokensAfter - targetTokensAfter),
		...(contextWindow !== undefined
			? {
					contextWindowBeforePercent: percentOf(stats.tokensBefore, contextWindow),
					contextWindowAfterPercent: percentOf(stats.tokensAfter, contextWindow),
				}
			: {}),
		callCount,
	};
	return details;
}

export function contextCompactionTargetMet(
	result: ValidatedContextDeletionResult | undefined,
	parameters: ContextCompactionParameters,
): result is ValidatedContextDeletionResult {
	return (
		result !== undefined &&
		result.deletedTargets.length > 0 &&
		result.stats.percentReduction >= contextCompactionTargetReductionPercent(parameters)
	);
}

export function contextCompactionProgressKey(result: ValidatedContextDeletionResult | undefined): string {
	if (!result) return "none:0";
	return `${result.deletedTargets.length}:${result.stats.percentReduction}:${result.stats.tokensAfter}`;
}

export function contextCompactionProgressPercent(result: ValidatedContextDeletionResult | undefined): number {
	return result?.stats.percentReduction ?? 0;
}
