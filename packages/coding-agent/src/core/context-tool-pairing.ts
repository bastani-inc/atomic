import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Structural tool-pairing guard for provider-bound context.
 *
 * `repairOrphanToolResults` already collapses the recoverable forms of this
 * invariant at conversion time: orphaned or duplicate `tool_result` blocks and
 * tool calls interrupted before their result was persisted. None need to reach
 * the provider.
 *
 * A `tool_use` id announced by more than one assistant message is a different
 * problem. It means the transcript itself carries the same assistant turn twice,
 * so there is no safe repair — dropping either copy guesses at which tool results
 * belong to it. The provider answers that with an opaque 400 that kills the turn,
 * so fail here instead, naming the ids.
 */
export function findDuplicateToolCallIds(messages: readonly AgentMessage[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if ((message as { excludeFromContext?: boolean }).excludeFromContext === true) continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; id?: unknown };
			if (candidate.type !== "toolCall" || typeof candidate.id !== "string") continue;
			if (seen.has(candidate.id)) duplicates.add(candidate.id);
			else seen.add(candidate.id);
		}
	}
	return [...duplicates];
}

/** Throw a descriptive error when context carries a tool call id more than once. */
export function assertToolPairingInvariant(messages: readonly AgentMessage[]): void {
	const duplicates = findDuplicateToolCallIds(messages);
	if (duplicates.length === 0) return;
	const plural = duplicates.length > 1;
	throw new Error(
		`Context is structurally invalid for the provider: tool call ${plural ? "ids" : "id"} ` +
			`${duplicates.join(", ")} ${plural ? "appear" : "appears"} in more than one assistant message. ` +
			"The request was not sent.",
	);
}
