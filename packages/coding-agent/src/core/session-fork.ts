/**
 * Append-only forks of a session.
 *
 * A fork starts from the messages its source would send for its own next request, unchanged, and only appends to
 * them. Providers bind signed reasoning to the exact turns and turn order that produced it: a fork that removes,
 * merges or rewrites an inherited message can be rejected outright (#5481). The one thing a fork must add before its
 * own messages is an answer to every tool call the source's last turn left open, since a provider rejects a request
 * whose last tool calls have no results.
 */

import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ToolCall, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { messageStartsLlmUserTurn } from "./messages.ts";
import type { SessionManager } from "./session-manager-core.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/** The text of the result a fork appends for one open tool call of its source. */
export type ForkToolCallAnswer = (call: ToolCall) => string;

/**
 * The entry a fork launched by `toolCallIds` starts at: the assistant message on `branch` that holds one of those tool
 * calls. Every fork launched from that message shares this point, however much of the source follows it by the time
 * the fork is made. Undefined when no assistant message on `branch` holds one of them.
 */
export function forkPointEntryId(branch: readonly SessionEntry[], toolCallIds: readonly string[]): string | undefined {
	if (toolCallIds.length === 0) return undefined;
	const launching = new Set(toolCallIds);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.content.some((block) => block.type === "toolCall" && launching.has(block.id))) return entry.id;
	}
	return undefined;
}

/**
 * The tool calls of the last assistant message in `messages` that no tool result after it answers, in call order.
 *
 * Empty when that message failed or was aborted, since providers are sent no such turn, or when a message the model
 * reads as a new user turn follows it, since the calls are then earlier history that a request already repairs.
 */
export function unansweredToolCalls(messages: readonly AgentMessage[]): ToolCall[] {
	const answered = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") return [];
			return message.content.filter(
				(block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id),
			);
		}
		if (messageStartsLlmUserTurn(message)) return [];
	}
	return [];
}

/** One tool result for each of `calls`, in order, with the text `answer` gives it. */
export function forkToolResults(
	calls: readonly ToolCall[],
	answer: ForkToolCallAnswer,
	timestamp: number,
): ToolResultMessage[] {
	return calls.map((call) => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: answer(call) }],
		isError: false,
		timestamp,
	}));
}

/**
 * Complete a fork that `manager` holds: append one result for each tool call its source's last turn left open, after
 * the inherited messages and before anything the fork itself adds. Returns the results it appended.
 */
export async function appendForkToolResults(
	manager: SessionManager,
	answer: ForkToolCallAnswer,
): Promise<ToolResultMessage[]> {
	const results = forkToolResults(unansweredToolCalls(manager.buildSessionContext().messages), answer, Date.now());
	for (const result of results) await manager.appendMessage(result);
	return results;
}

/**
 * Fork `source` at `entryId`: `source` switches to a new session holding the branch's context from the root to that
 * entry, unchanged, followed by the results {@link appendForkToolResults} appends. The new session holds what a resume of
 * `source` at that entry loads: the latest clear or compaction boundary on the branch, what it keeps, everything after
 * it through `entryId`, and the settings kept from before it (#5500). Its context is the branch's context, and its
 * boundary still names the history the earlier conversation is in. A `source` opened at `entryId` with
 * `history: "tail"` is forked without reading more of its session.
 */
export async function createForkedSession(
	source: SessionManager,
	entryId: string,
	answer: ForkToolCallAnswer,
): Promise<ToolResultMessage[]> {
	await source.createBranchedSession(entryId, { history: "tail" });
	return appendForkToolResults(source, answer);
}
