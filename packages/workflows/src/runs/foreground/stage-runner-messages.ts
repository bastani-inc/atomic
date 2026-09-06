import type { AgentSession } from "@bastani/atomic";
import { errorMessage } from "../shared/model-fallback.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

type TextLikeContent = {
	readonly type?: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
};

type MessageWithTextContent = {
	readonly content?: string | readonly TextLikeContent[];
};

export function extractMessageText(message: AgentSession["messages"][number]): string {
	const { content } = message as MessageWithTextContent;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
			.filter(Boolean)
			.join("");
	}
	return "";
}

/** Completed answers in one output generation; tool progress remains transcript-only. */
export function assistantArtifactTextForGeneration(messages: AgentSession["messages"]): string {
	const answers = messages.flatMap((message) => {
		if (message.role !== "assistant") return [];
		if (message.stopReason !== "stop" && message.stopReason !== "length") return [];
		if (message.content.some((block) => block.type === "toolCall")) return [];
		const text = extractMessageText(message);
		return text.length > 0 ? [text] : [];
	});
	return answers.map((text, index) => (index === 0 ? text : `\n\n## Supplement ${index}\n\n${text}`)).join("");
}

export function lastAssistantTextFromMessages(messages: AgentSession["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = extractMessageText(message).trim();
		if (text) return text;
	}
	return undefined;
}

/**
 * Name the shape of the turn a schema-backed prompt produced (issue #2812).
 *
 * A candidate that burns its whole structured-output correction budget looks
 * clean to every other observer: the turns return without an error and without
 * a terminal stop reason. Recording *which* clean shape it produced — no
 * assistant message at all, an assistant message whose text is empty, or
 * ordinary text that never called the tool — is what makes the external cause
 * attributable the next time it happens.
 *
 * The detail carries no closing period: it is appended to the contract error
 * and that error is interpolated into the standard `[fallback] … failed: <error>.
 * Retrying with …` warning, which supplies the sentence break itself.
 */
export function structuredOutputTurnDetail(messages: AgentSession["messages"], startIndex: number): string {
	for (let index = messages.length - 1; index >= Math.max(startIndex, 0); index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return extractMessageText(message).trim().length > 0
			? "The model produced assistant text but never called structured_output"
			: "The model produced an assistant message with empty text";
	}
	return "The model produced no assistant message after the prompt";
}

/**
 * Artifact text for a successful `structured_output` call (issue #2198).
 *
 * Primary: the ordinary text of the exact assistant message that carried the
 * successful tool call, so corrective attempts and later admitted turns cannot
 * replace the pairing. Fallback: when that message carries no ordinary text —
 * or the session no longer holds it after model-fallback recreation — the most
 * recent earlier assistant message that carries text and makes no
 * `structured_output` call. Assistant turns after the successful call never
 * win. When neither side exists the caller writes an empty artifact and its
 * receipt carries the standard empty-artifact warning; the companion
 * transcript remains the recovery path.
 */
export function assistantArtifactTextForToolCall(
	messages: AgentSession["messages"],
	toolCallId: string,
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const { content } = message as MessageWithTextContent;
		if (!Array.isArray(content)) continue;
		if (!content.some((block) => block.type === "toolCall" && block.id === toolCallId)) continue;
		const text = extractMessageText(message);
		if (text.trim().length > 0) return text;
		return lastNonStructuredAssistantTextBefore(messages, index);
	}
	return lastNonStructuredAssistantTextBefore(messages, messages.length);
}

function lastNonStructuredAssistantTextBefore(
	messages: AgentSession["messages"],
	endIndex: number,
): string | undefined {
	for (let index = endIndex - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const { content } = message as MessageWithTextContent;
		if (!Array.isArray(content)) continue;
		if (content.some((block) => block.type === "toolCall" && block.name === "structured_output")) continue;
		const text = extractMessageText(message);
		if (text.trim().length > 0) return text;
	}
	return undefined;
}

function messageStopReason(message: AgentSession["messages"][number]): string | undefined {
	const record = message as { readonly stopReason?: unknown };
	return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

function normalizedStopReason(stopReason: string | undefined): string | undefined {
	return stopReason?.toLowerCase().replace(/[_-]+/g, "");
}

function isTerminalAssistantFailureStopReason(stopReason: string | undefined): boolean {
	const normalized = normalizedStopReason(stopReason);
	return normalized === "error" || normalized === "aborted";
}

function isCleanAssistantStopReason(stopReason: string | undefined): boolean {
	const normalized = normalizedStopReason(stopReason);
	return normalized === "stop" || normalized === "tooluse" || normalized === "length";
}

function assistantErrorMessage(message: AgentSession["messages"][number]): string | undefined {
	const record = message as { readonly errorMessage?: unknown };
	return typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0
		? record.errorMessage
		: undefined;
}

export function latestTerminalAssistantFailureSince(
	messages: AgentSession["messages"],
	startIndex: number,
): AgentSession["messages"][number] | undefined {
	for (let index = messages.length - 1; index >= startIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const stopReason = messageStopReason(message);
		if (isTerminalAssistantFailureStopReason(stopReason)) return message;
		if (isCleanAssistantStopReason(stopReason)) return undefined;
		if (assistantErrorMessage(message) === undefined && extractMessageText(message).trim().length > 0) {
			return undefined;
		}
	}
	return undefined;
}

export class WorkflowPromptModelFailure extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super(errorMessage(cause));
		this.name = "WorkflowPromptModelFailure";
		this.cause = cause;
	}
}

function terminatingToolResultText(
	messages: AgentSession["messages"],
	terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult") {
			const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
			if (typeof toolCallId !== "string" || !terminatingToolCallIds.has(toolCallId)) {
				return undefined;
			}
			const text = extractMessageText(message).trim();
			return text.length > 0 ? text : undefined;
		}
		if (message.role === "assistant") return undefined;
	}
	return undefined;
}

export function lastAssistantTextFromSession(
	activeSession: StageSessionRuntime | undefined,
	fallback: string | undefined,
	terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
	if (!activeSession) return fallback;
	const terminatingText = terminatingToolResultText(activeSession.messages, terminatingToolCallIds);
	if (terminatingText !== undefined) return terminatingText;
	const direct = activeSession.getLastAssistantText?.();
	if (direct?.trim()) return direct;
	return lastAssistantTextFromMessages(activeSession.messages) ?? direct ?? fallback;
}

export function assistantMessage(text: string): AgentSession["messages"] {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text }],
		},
	] as AgentSession["messages"];
}
