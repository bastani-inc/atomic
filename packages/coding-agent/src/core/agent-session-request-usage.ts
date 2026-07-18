import type { Api, AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { CompactionRequestPrefix } from "./compaction/compaction-types.ts";
import { normalizedPromptUsage } from "./provider-usage-accounting.ts";

/** Provider prompt occupancy excludes generated output and handles Anthropic mirror buckets. */
export function providerPromptOccupancy(usage: Usage, api?: Api): number {
	return normalizedPromptUsage(usage, api).promptTokens;
}

/** Attach usage only to the exact normal request whose stream produced this message object. */
export function bindAssistantUsageToRequest(
	prefix: CompactionRequestPrefix | undefined,
	requestGeneration: number | undefined,
	message: AssistantMessage,
	sessionId: string,
): CompactionRequestPrefix | undefined {
	if (requestGeneration === undefined || prefix?.requestGeneration !== requestGeneration) return prefix;
	const identity = prefix.identity;
	if (
		identity.api !== message.api
		|| identity.provider !== message.provider
		|| identity.model !== message.model
		|| identity.sessionId !== sessionId
	) return prefix;
	return Object.freeze({ ...prefix, providerInputTokens: providerPromptOccupancy(message.usage, message.api) });
}
