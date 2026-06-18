export function isAssistantThinkingBlockType(type: unknown): type is "thinking" | "redacted_thinking" {
	return type === "thinking" || type === "redacted_thinking";
}

export function contentArrayHasAssistantThinkingBlock(content: readonly unknown[]): boolean {
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isAssistantThinkingBlockType((block as { type?: unknown }).type);
	});
}

export function messageHasAssistantThinkingContentBlock(message: { role?: unknown; content?: unknown }): boolean {
	return message.role === "assistant" &&
		Array.isArray(message.content) &&
		contentArrayHasAssistantThinkingBlock(message.content);
}
