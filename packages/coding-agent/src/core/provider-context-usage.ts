import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { CompactionEntry, SessionEntry } from "./session-manager.ts";

function findLatestCompactionBoundary(entries: readonly SessionEntry[]): CompactionEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && (entry.details as { strategy?: string } | undefined)?.strategy === "verbatim-lines") return entry;
	}
	return undefined;
}

function hasTokenUsage(usage: Usage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
}

function createZeroUsage(usage: Usage): Usage {
	const zeroed: Usage = {
		...usage,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	if (usage.cacheWrite1h !== undefined) {
		zeroed.cacheWrite1h = 0;
	}
	if (usage.reasoning !== undefined) {
		zeroed.reasoning = 0;
	}

	return zeroed;
}

/**
 * Provider-side token-budget estimators use the last assistant usage in the
 * request context as an anchor. After logical context compaction, retained
 * pre-compaction assistant messages still carry usage from the old, larger
 * context. Scrub only the provider-bound clone so the durable transcript keeps
 * historical billing data while the next request estimates the compacted prompt.
 */
export function scrubPreCompactionAssistantUsage(
	messages: AgentMessage[],
	entries: readonly SessionEntry[],
): AgentMessage[] {
	const compactionBoundary = findLatestCompactionBoundary(entries);
	if (!compactionBoundary) return messages;

	const boundaryTime = Date.parse(compactionBoundary.timestamp);
	if (!Number.isFinite(boundaryTime)) return messages;

	let changed = false;
	const scrubbed = messages.map((message) => {
		if (message.role !== "assistant") return message;

		const assistant = message as AssistantMessage;
		if (assistant.timestamp > boundaryTime || !hasTokenUsage(assistant.usage)) {
			return message;
		}

		changed = true;
		return { ...assistant, usage: createZeroUsage(assistant.usage) };
	});

	return changed ? scrubbed : messages;
}
