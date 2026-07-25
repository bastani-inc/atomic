import type { RpcEvent, RpcTransportError } from "./rpc-types.ts";

type RpcMessageLifecycleEvent = Extract<
	RpcEvent,
	{ type: "message_start" | "message_update" | "message_end" }
>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMessageLifecycleType(
	value: unknown,
): value is "message_start" | "message_update" | "message_end" {
	return value === "message_start" || value === "message_update" || value === "message_end";
}

export function isRpcTransportError(value: unknown): value is RpcTransportError {
	return isRecord(value)
		&& value.type === "transport_error"
		&& typeof value.error === "string"
		&& (value.recordType === undefined || typeof value.recordType === "string");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isContentIndex(value: unknown): value is number {
	return Number.isInteger(value) && isFiniteNumber(value) && value >= 0;
}

function isTextContent(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): boolean {
	return isRecord(value)
		&& value.type === "image"
		&& typeof value.data === "string"
		&& typeof value.mimeType === "string";
}

function isThinkingContent(value: unknown): boolean {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCall(value: unknown): boolean {
	return isRecord(value)
		&& value.type === "toolCall"
		&& typeof value.id === "string"
		&& typeof value.name === "string"
		&& isRecord(value.arguments);
}

function isTextImageContent(value: unknown): boolean {
	return Array.isArray(value) && value.every((block) => isTextContent(block) || isImageContent(block));
}

function isAssistantContent(value: unknown): boolean {
	return Array.isArray(value)
		&& value.every((block) => isTextContent(block) || isThinkingContent(block) || isToolCall(block));
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return isFiniteNumber(value.input)
		&& isFiniteNumber(value.output)
		&& isFiniteNumber(value.cacheRead)
		&& isFiniteNumber(value.cacheWrite)
		&& isFiniteNumber(value.totalTokens)
		&& isFiniteNumber(value.cost.input)
		&& isFiniteNumber(value.cost.output)
		&& isFiniteNumber(value.cost.cacheRead)
		&& isFiniteNumber(value.cost.cacheWrite)
		&& isFiniteNumber(value.cost.total);
}

function isStopReason(value: unknown): boolean {
	return value === "stop"
		|| value === "length"
		|| value === "toolUse"
		|| value === "error"
		|| value === "aborted";
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> & { role: "assistant" } {
	return isRecord(value)
		&& value.role === "assistant"
		&& isFiniteNumber(value.timestamp)
		&& typeof value.api === "string"
		&& typeof value.provider === "string"
		&& typeof value.model === "string"
		&& isStopReason(value.stopReason)
		&& isUsage(value.usage)
		&& isAssistantContent(value.content);
}

function isAgentMessage(value: unknown): boolean {
	if (!isRecord(value) || !isFiniteNumber(value.timestamp)) return false;
	switch (value.role) {
		case "user":
			return typeof value.content === "string" || isTextImageContent(value.content);
		case "assistant":
			return isAssistantMessage(value);
		case "toolResult":
			return typeof value.toolCallId === "string"
				&& typeof value.toolName === "string"
				&& typeof value.isError === "boolean"
				&& isTextImageContent(value.content);
		case "custom":
			return typeof value.customType === "string"
				&& typeof value.display === "boolean"
				&& (typeof value.content === "string" || isTextImageContent(value.content));
		case "bashExecution":
			return typeof value.command === "string"
				&& typeof value.output === "string"
				&& (value.exitCode === undefined || isFiniteNumber(value.exitCode))
				&& typeof value.cancelled === "boolean"
				&& typeof value.truncated === "boolean";
		case "branchSummary":
			return typeof value.summary === "string" && typeof value.fromId === "string";
		default:
			return false;
	}
}

function isAssistantMessageEvent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "start":
			return isAssistantMessage(value.partial);
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return isContentIndex(value.contentIndex) && isAssistantMessage(value.partial);
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return isContentIndex(value.contentIndex)
				&& typeof value.delta === "string"
				&& isAssistantMessage(value.partial);
		case "text_end":
		case "thinking_end":
			return isContentIndex(value.contentIndex)
				&& typeof value.content === "string"
				&& isAssistantMessage(value.partial);
		case "toolcall_end":
			return isContentIndex(value.contentIndex)
				&& isToolCall(value.toolCall)
				&& isAssistantMessage(value.partial);
		case "done":
			return (value.reason === "stop" || value.reason === "length" || value.reason === "toolUse")
				&& isAssistantMessage(value.message);
		case "error":
			return (value.reason === "aborted" || value.reason === "error")
				&& isAssistantMessage(value.error);
		default:
			return false;
	}
}

export function isRpcMessageLifecycleEvent(value: unknown): value is RpcMessageLifecycleEvent {
	if (!isRecord(value) || !isMessageLifecycleType(value.type) || !isAgentMessage(value.message)) return false;
	if (value.type !== "message_update") return true;
	return isRecord(value.message)
		&& value.message.role === "assistant"
		&& isAssistantMessageEvent(value.assistantMessageEvent);
}
