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

function readReplayThinkingBlock(block: unknown, allowEmptySignature = false): ReplayThinkingBlock | undefined {
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

	if (typeof block.thinking !== "string" || typeof block.thinkingSignature !== "string") return undefined;
	if (!allowEmptySignature && block.thinkingSignature.trim().length === 0) return undefined;
	return { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature };
}

function hasReplayThinkingBlock(message: AssistantMessage, allowEmptySignature: boolean): boolean {
	return message.content.some((block) => readReplayThinkingBlock(block, allowEmptySignature) !== undefined);
}

function legacyProviderWouldEmitAssistantBlock(block: unknown): boolean {
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
	const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
	return block.thinking.trim().length > 0 || (signature !== undefined && signature.trim().length > 0);
}

function legacyProviderWouldEmitAssistant(message: AssistantMessage, model: Model<Api>): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;

	// This mirrors the relevant same-model branch in @earendil-works/pi-ai's
	// transformMessages() + Anthropic convertMessages() pipeline closely enough
	// to keep assistant ordinal mapping aligned with the provider payload.
	if (isSameModelAssistant(message, model)) {
		return message.content.some((block) => legacyProviderWouldEmitAssistantBlock(block));
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

function nonThinkingBlocksAlign(message: AssistantMessage, providerBlocks: readonly AnthropicContentBlock[]): boolean {
	const sourceTypes = message.content.flatMap((block) => {
		if (!isObject(block) || typeof block.type !== "string") return [];
		if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0 ? ["text"] : [];
		return block.type === "toolCall" ? ["tool_use"] : [];
	});
	const providerTypes = providerBlocks.filter((block) => !isThinkingLikeAnthropicBlock(block)).map((block) => block.type);
	return sourceTypes.length === providerTypes.length && sourceTypes.every((type, index) => type === providerTypes[index]);
}

function repairAssistantContent(
	originalMessage: AssistantMessage,
	providerBlocks: readonly AnthropicContentBlock[],
	allowEmptySignature: boolean,
): AnthropicContentBlock[] {
	const repaired: AnthropicContentBlock[] = [];
	let providerIndex = 0;

	for (const originalBlock of originalMessage.content) {
		const replayBlock = readReplayThinkingBlock(originalBlock, allowEmptySignature);
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
 * upstream pi-ai Anthropic converter can sanitize thinking text and drop signed
 * empty thinking. convertToLlm normalizes raw redacted_thinking blocks in its
 * transient, non-mutating LLM-compatible messages before this hook, then this guard
 * restores exact same-model payloads while leaving non-Anthropic and cross-model
 * payloads unchanged.
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

	const emittingSourceAssistants = sourceMessages.filter(
		(message): message is AssistantMessage => message.role === "assistant" && legacyProviderWouldEmitAssistant(message, model),
	);
	// Fail closed if pi-ai's converter emission behavior drifts from the model above;
	// ordinal restoration must never splice thinking into a different assistant.
	if (emittingSourceAssistants.length !== assistantPayloads.length) return payload;

	const allowEmptySignature = isObject(model.compat) && model.compat.allowEmptySignature === true;
	let nextPayloadMessages: unknown[] | undefined;

	for (const [assistantPayloadOrdinal, sourceMessage] of emittingSourceAssistants.entries()) {
		const payloadAssistant = assistantPayloads[assistantPayloadOrdinal];

		if (!isSameModelAssistant(sourceMessage, model) || !hasReplayThinkingBlock(sourceMessage, allowEmptySignature)) continue;
		// A second fail-closed guard verifies the non-thinking shape before replacing
		// signed blocks, protecting against equal-count ordinal misalignment.
		if (!nonThinkingBlocksAlign(sourceMessage, payloadAssistant.content)) continue;

		const repairedContent = repairAssistantContent(sourceMessage, payloadAssistant.content, allowEmptySignature);
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
