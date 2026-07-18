import type { Api, Usage } from "@earendil-works/pi-ai/compat";

export function normalizedUsagePart(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Anthropic-compatible endpoints sometimes mirror the whole prompt into cache usage. */
export function anthropicCacheMirrorsInput(api: Api | undefined, input: number, cacheTokens: number): boolean {
	return api === "anthropic-messages" && input > 0 && cacheTokens > 0
		&& cacheTokens >= input * 0.9 && cacheTokens <= input * 1.1;
}

export function normalizedPromptUsage(usage: Usage, api?: Api): {
	input: number;
	cacheTokens: number;
	promptTokens: number;
} {
	const input = normalizedUsagePart(usage.input);
	const cacheTokens = normalizedUsagePart(usage.cacheRead) + normalizedUsagePart(usage.cacheWrite);
	return {
		input,
		cacheTokens,
		promptTokens: anthropicCacheMirrorsInput(api, input, cacheTokens) ? input : input + cacheTokens,
	};
}
