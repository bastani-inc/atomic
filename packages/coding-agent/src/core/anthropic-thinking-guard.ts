import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai/compat";

type JsonObject = Record<string, unknown>;

type AnthropicContentBlock = JsonObject & { type: string };

type ReplayThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicContentBlock(value: unknown): value is AnthropicContentBlock {
	return isObject(value) && typeof value.type === "string";
}

function isThinkingLikeAnthropicBlock(value: unknown): boolean {
	if (!isAnthropicContentBlock(value)) return false;
	return value.type === "thinking" || value.type === "redacted_thinking";
}

function isSameModelAssistant(message: AssistantMessage, model: Model<Api>): boolean {
	return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

function readReplayThinkingBlock(block: unknown): ReplayThinkingBlock | undefined {
	if (!isObject(block) || typeof block.type !== "string") return undefined;

	if (block.type === "redacted_thinking") {
		return typeof block.data === "string" ? { type: "redacted_thinking", data: block.data } : undefined;
	}

	if (block.type !== "thinking") return undefined;

	if (block.redacted === true) {
		return typeof block.thinkingSignature === "string"
			? { type: "redacted_thinking", data: block.thinkingSignature }
			: undefined;
	}

	return typeof block.thinking === "string" && typeof block.thinkingSignature === "string"
		? { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }
		: undefined;
}

function hasReplayThinkingBlock(message: AssistantMessage): boolean {
	return message.content.some((block) => readReplayThinkingBlock(block) !== undefined);
}

function legacyProviderWouldEmitAssistantBlock(block: unknown, allowEmptySignature: boolean): boolean {
	if (!isObject(block) || typeof block.type !== "string") return false;

	if (block.type === "text") {
		return typeof block.text === "string" && block.text.trim().length > 0;
	}

	if (block.type === "toolCall") {
		return true;
	}

	if (block.type !== "thinking") {
		return false;
	}

	if (block.redacted === true) {
		return true;
	}

	if (typeof block.thinking !== "string") return false;
	if (block.thinking.trim().length === 0) return false;

	const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
	if (signature !== undefined && signature.trim().length > 0) return true;
	return allowEmptySignature;
}

function legacyProviderWouldEmitAssistant(message: AssistantMessage, model: Model<Api>, allowEmptySignature: boolean): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;

	// This mirrors the relevant same-model branch in @earendil-works/pi-ai's
	// transformMessages() + Anthropic convertMessages() pipeline closely enough
	// to keep assistant ordinal mapping aligned with the provider payload.
	if (isSameModelAssistant(message, model)) {
		return message.content.some((block) => legacyProviderWouldEmitAssistantBlock(block, allowEmptySignature));
	}

	return message.content.some((block) => {
		if (!isObject(block) || typeof block.type !== "string") return false;
		if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
		if (block.type === "toolCall") return true;
		if (block.type !== "thinking") return false;
		if (block.redacted === true) return false;
		return typeof block.thinking === "string" && block.thinking.trim().length > 0;
	});
}

function fallbackTextBlock(block: JsonObject): AnthropicContentBlock | undefined {
	return typeof block.text === "string" && block.text.trim().length > 0
		? { type: "text", text: block.text }
		: undefined;
}

function fallbackToolUseBlock(block: JsonObject): AnthropicContentBlock | undefined {
	if (typeof block.id !== "string" || typeof block.name !== "string") return undefined;
	return { type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} };
}

function takeProviderBlock(
	providerBlocks: readonly AnthropicContentBlock[],
	providerIndex: number,
	expectedType: string,
): { block: AnthropicContentBlock | undefined; nextProviderIndex: number } {
	const providerBlock = providerBlocks[providerIndex];
	if (providerBlock?.type === expectedType) {
		return { block: providerBlock, nextProviderIndex: providerIndex + 1 };
	}
	return { block: undefined, nextProviderIndex: providerIndex };
}

function repairAssistantContent(
	originalMessage: AssistantMessage,
	providerBlocks: readonly AnthropicContentBlock[],
): AnthropicContentBlock[] {
	const repaired: AnthropicContentBlock[] = [];
	let providerIndex = 0;

	for (const originalBlock of originalMessage.content) {
		const replayBlock = readReplayThinkingBlock(originalBlock);
		if (replayBlock) {
			if (isThinkingLikeAnthropicBlock(providerBlocks[providerIndex])) {
				providerIndex += 1;
			}
			repaired.push({ ...replayBlock });
			continue;
		}

		if (!isObject(originalBlock) || typeof originalBlock.type !== "string") continue;

		if (originalBlock.type === "text") {
			const providerText = takeProviderBlock(providerBlocks, providerIndex, "text");
			if (providerText.block) {
				repaired.push(providerText.block);
				providerIndex = providerText.nextProviderIndex;
				continue;
			}
			const fallback = fallbackTextBlock(originalBlock);
			if (fallback) repaired.push(fallback);
			continue;
		}

		if (originalBlock.type === "toolCall") {
			const providerToolUse = takeProviderBlock(providerBlocks, providerIndex, "tool_use");
			if (providerToolUse.block) {
				repaired.push(providerToolUse.block);
				providerIndex = providerToolUse.nextProviderIndex;
				continue;
			}
			const fallback = fallbackToolUseBlock(originalBlock);
			if (fallback) repaired.push(fallback);
		}
	}

	for (; providerIndex < providerBlocks.length; providerIndex += 1) {
		repaired.push(providerBlocks[providerIndex]);
	}

	return repaired;
}

function getAnthropicMessages(payload: unknown): unknown[] | undefined {
	if (!isObject(payload)) return undefined;
	return Array.isArray(payload.messages) ? payload.messages : undefined;
}

function getAnthropicAssistantContent(message: unknown): AnthropicContentBlock[] | undefined {
	if (!isObject(message) || message.role !== "assistant") return undefined;
	if (!Array.isArray(message.content)) return undefined;
	const content = message.content.filter(isAnthropicContentBlock);
	return content.length === message.content.length ? content : undefined;
}

/**
 * Restore same-model Anthropic replay thinking blocks after provider payload
 * construction and extension payload hooks.
 *
 * Anthropic requires thinking/redacted_thinking blocks from replayed assistant
 * messages to remain byte-for-byte identical to the original response. The
 * upstream pi-ai Anthropic converter currently still sanitizes thinking text,
 * drops signed empty thinking, and does not understand raw redacted_thinking
 * blocks. This guard repairs the already-built Anthropic payload from the
 * pre-provider LLM messages while leaving non-Anthropic and cross-model payloads
 * unchanged.
 */
export function restoreAnthropicReplayThinkingBlocks(payload: unknown, sourceMessages: readonly Message[], model: Model<Api>): unknown {
	if (model.api !== "anthropic-messages") return payload;

	const payloadMessages = getAnthropicMessages(payload);
	if (!payloadMessages) return payload;

	const assistantPayloads = payloadMessages
		.map((message, index) => ({ message, index, content: getAnthropicAssistantContent(message) }))
		.filter(
			(entry): entry is { message: JsonObject; index: number; content: AnthropicContentBlock[] } =>
				entry.content !== undefined && isObject(entry.message),
		);

	if (assistantPayloads.length === 0) return payload;

	const allowEmptySignature = isObject(model.compat) && model.compat.allowEmptySignature === true;
	let assistantPayloadOrdinal = 0;
	let nextPayloadMessages: unknown[] | undefined;

	for (const sourceMessage of sourceMessages) {
		if (sourceMessage.role !== "assistant") continue;
		if (!legacyProviderWouldEmitAssistant(sourceMessage, model, allowEmptySignature)) continue;

		const payloadAssistant = assistantPayloads[assistantPayloadOrdinal];
		assistantPayloadOrdinal += 1;
		if (!payloadAssistant) break;

		if (!isSameModelAssistant(sourceMessage, model) || !hasReplayThinkingBlock(sourceMessage)) continue;

		const repairedContent = repairAssistantContent(sourceMessage, payloadAssistant.content);
		if (JSON.stringify(repairedContent) === JSON.stringify(payloadAssistant.content)) continue;

		nextPayloadMessages ??= [...payloadMessages];
		nextPayloadMessages[payloadAssistant.index] = {
			...payloadAssistant.message,
			content: repairedContent,
		};
	}

	if (!nextPayloadMessages || !isObject(payload)) return payload;
	return { ...payload, messages: nextPayloadMessages };
}
