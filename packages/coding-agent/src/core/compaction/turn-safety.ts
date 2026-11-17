import type { SessionEntry } from "../session-manager-types.ts";

function toolCallIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "assistant") return [];
	return entry.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

/** Entries that never end the trailing tool run: they contribute no model message. */
function isPassiveEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" ||
		entry.type === "label" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "usage" ||
		entry.type === "session_info" ||
		entry.type === "session_summary" ||
		entry.type === "context_edit"
	);
}

/**
 * Path index of the earliest assistant message of the trailing run of tool calls and tool results that has a call
 * without a result, or undefined when every call of the run has one. Walks the run backwards, tracking which calls
 * have a result; any other message ends the run. `awaitedEntryId` names a turn the context still waits on a result
 * for whatever entries follow it, such as a custom message that was delivered meanwhile.
 */
export function findUnansweredToolCall(branch: readonly SessionEntry[], awaitedEntryId?: string): number | undefined {
	const answered = new Set<string>();
	let unanswered: number | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isPassiveEntry(entry)) continue;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			answered.add(entry.message.toolCallId);
			continue;
		}
		const calls = toolCallIds(entry);
		if (calls.length === 0) break;
		if (calls.some((id) => !answered.has(id))) unanswered = index;
	}
	const awaited = branch.findIndex((entry) => entry.id === awaitedEntryId);
	return awaited >= 0 && (unanswered === undefined || awaited < unanswered) ? awaited : unanswered;
}

/**
 * Path index of the last entry a compaction boundary may cover, or -1 when nothing is safe.
 *
 * Cuts before the earliest assistant message of the trailing tool run with an unanswered call
 * ({@link findUnansweredToolCall}), so a tool call and its result always stay on the same side of the boundary. A safe
 * point never lands on a label, which a branched copy drops.
 */
export function findCompactionSafePoint(branch: readonly SessionEntry[], awaitedEntryId?: string): number {
	let last = (findUnansweredToolCall(branch, awaitedEntryId) ?? branch.length) - 1;
	while (last >= 0 && branch[last].type === "label") last--;
	return last;
}
