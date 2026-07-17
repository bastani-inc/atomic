import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { CompactionRequestPrefix } from "./compaction/compaction-types.ts";

function normalizedUsagePart(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Provider prompt occupancy excludes generated output and sums disjoint cache partitions. */
export function providerPromptOccupancy(usage: Usage): number {
	return normalizedUsagePart(usage.input)
		+ normalizedUsagePart(usage.cacheRead)
		+ normalizedUsagePart(usage.cacheWrite);
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
	return Object.freeze({ ...prefix, providerInputTokens: providerPromptOccupancy(message.usage) });
}
