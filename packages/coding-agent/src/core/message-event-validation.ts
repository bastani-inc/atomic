function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextBlock(value: unknown): boolean {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageBlock(value: unknown): boolean {
	return isRecord(value)
		&& value.type === "image"
		&& typeof value.data === "string"
		&& typeof value.mimeType === "string";
}

function isAssistantBlock(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return isTextBlock(value);
	if (value.type === "thinking") return typeof value.thinking === "string";
	if (value.type !== "toolCall") return false;
	return typeof value.id === "string"
		&& typeof value.name === "string"
		&& isRecord(value.arguments);
}

function isSafeContentArray(
	value: unknown,
	isBlock: (block: unknown) => boolean,
): boolean {
	return Array.isArray(value) && value.every(isBlock);
}

function isUserLikeContent(value: unknown): boolean {
	return typeof value === "string"
		|| isSafeContentArray(value, (block) => isTextBlock(block) || isImageBlock(block));
}

export function isSafeAssistantMessageSnapshot(message: unknown): boolean {
	return isRecord(message)
		&& message.role === "assistant"
		&& isSafeContentArray(message.content, isAssistantBlock)
		&& (message.errorMessage === undefined || typeof message.errorMessage === "string");
}

export function isSafeAssistantCacheStatsMessage(message: unknown): boolean {
	if (!isRecord(message) || !isSafeAssistantMessageSnapshot(message)) return false;
	const usage = message.usage;
	if (!isRecord(usage) || !isRecord(usage.cost)) return false;
	return typeof message.provider === "string"
		&& typeof message.model === "string"
		&& typeof message.timestamp === "number"
		&& typeof usage.input === "number"
		&& typeof usage.cacheRead === "number"
		&& typeof usage.cacheWrite === "number"
		&& typeof usage.cost.input === "number"
		&& typeof usage.cost.cacheRead === "number"
		&& typeof usage.cost.cacheWrite === "number";
}

export function isSafeMessageStartMessage(message: unknown): boolean {
	if (!isRecord(message) || typeof message.role !== "string") return false;
	switch (message.role) {
		case "assistant":
			return isSafeAssistantMessageSnapshot(message);
		case "user":
			return isUserLikeContent(message.content);
		case "custom":
			return typeof message.customType === "string"
				&& typeof message.display === "boolean"
				&& isUserLikeContent(message.content);
		case "bashExecution":
			return typeof message.command === "string"
				&& typeof message.output === "string"
				&& (message.exitCode === undefined || typeof message.exitCode === "number")
				&& typeof message.cancelled === "boolean"
				&& typeof message.truncated === "boolean"
				&& (message.fullOutputPath === undefined || typeof message.fullOutputPath === "string")
				&& typeof message.timestamp === "number";
		case "branchSummary":
			return typeof message.summary === "string"
				&& typeof message.fromId === "string"
				&& typeof message.timestamp === "number";
		case "toolResult":
			return typeof message.toolCallId === "string"
				&& typeof message.toolName === "string"
				&& typeof message.isError === "boolean"
				&& isSafeContentArray(message.content, (block) => isTextBlock(block) || isImageBlock(block));
		default:
			// CustomAgentMessages is declaration-merged, so extension roles remain open.
			return true;
	}
}
