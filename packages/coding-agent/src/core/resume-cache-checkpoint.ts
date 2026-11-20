import type { AgentMessage, ThinkingLevel } from "@bastani/atomic-agent-core";
import type { AssistantMessage, Message, ThinkingBudgets } from "@bastani/atomic-ai";
import { BLUEPRINT_CONTEXT_TYPE } from "./resume/blueprint/context.ts";

/**
 * The message a resumed session's history ends with, as its last request before the exit sent it or as that request's
 * reply. A resume appends blueprint context before the session starts; that was never sent, so it is not part of it.
 * A system message is skipped too: requests may rebuild system messages as new objects, so it could not be found in
 * them, and the breakpoint goes on the input before it anyway.
 */
export function restoredCacheCheckpoint(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "system") continue;
		if (message.role === "custom" && message.customType === BLUEPRINT_CONTEXT_TYPE) continue;
		return message;
	}
	return undefined;
}

function isAnsweredReply(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		(message.stopReason === "stop" || message.stopReason === "toolUse" || message.stopReason === "length")
	);
}

export interface CacheCheckpointResult {
	converted: Message[];
	/** False once the checkpoint is answered or gone: later requests extend a prefix their own previous request cached. */
	keep: boolean;
}

/**
 * Ask for a prompt-cache breakpoint at `checkpoint` in the provider messages `converted` from `messages`, so the first
 * request after a resume finds the prefix the last request before the exit cached, however much the resume appended
 * after it. `rows` holds the provider message each input message became, by position. Kept until a reply after the
 * checkpoint is answered. The marked message is a copy; the transcript is not changed.
 */
export function withCacheCheckpoint(
	messages: readonly AgentMessage[],
	rows: readonly (Message | undefined)[],
	converted: Message[],
	checkpoint: AgentMessage,
): CacheCheckpointResult {
	const index = messages.indexOf(checkpoint);
	if (index === -1 || messages.slice(index + 1).some(isAnsweredReply)) return { converted, keep: false };
	for (let source = index; source >= 0; source--) {
		const row = rows[source];
		if (row === undefined || row.role === "system") continue;
		const at = converted.indexOf(row);
		if (at === -1) continue;
		const marked = converted.slice();
		marked[at] = { ...row, cacheBreakpoint: true };
		return { converted: marked, keep: true };
	}
	return { converted, keep: true };
}

/**
 * The thinking budgets a resumed session continues with. While it resumes on the model and thinking level of its last
 * recorded reply, that reply's budget stays, as it would in a session that kept running: a changed settings file or a
 * newer default budget would change the cached request. An explicit model or level change at resume, and a history
 * with no recorded budget, use `configured`.
 */
export function restoredThinkingBudgets(
	messages: readonly AgentMessage[],
	model: { provider: string; id: string } | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	configured: ThinkingBudgets | undefined,
): ThinkingBudgets | undefined {
	if (!model || thinkingLevel === undefined || thinkingLevel === "off") return configured;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant" || message.requestedThinkingBudget === undefined) continue;
		const recordedLevel = (message as AssistantMessage & { thinkingLevel?: string }).thinkingLevel;
		if (message.provider !== model.provider || message.model !== model.id || recordedLevel !== thinkingLevel)
			return configured;
		const level = thinkingLevel === "xhigh" || thinkingLevel === "max" ? "high" : thinkingLevel;
		return { ...configured, [level]: message.requestedThinkingBudget };
	}
	return configured;
}
