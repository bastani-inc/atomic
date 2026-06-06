export interface SubagentAssistantDrainMessage {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly stopReason?: unknown;
	readonly errorMessage?: unknown;
}

export function assistantStopReason(message: SubagentAssistantDrainMessage): string | undefined {
	return typeof message.stopReason === "string" ? message.stopReason : undefined;
}

export function isAssistantFailureStopReason(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

export function assistantMessageHasToolCall(message: SubagentAssistantDrainMessage): boolean {
	return Array.isArray(message.content)
		&& message.content.some((part) => part !== null
			&& typeof part === "object"
			&& (part as { readonly type?: unknown }).type === "toolCall");
}

function assistantMessageHasError(message: SubagentAssistantDrainMessage): boolean {
	const errorMessage = message.errorMessage;
	if (typeof errorMessage === "string") return errorMessage.trim().length > 0;
	return errorMessage !== undefined && errorMessage !== null;
}

export function shouldStartSubagentFinalDrain(message: SubagentAssistantDrainMessage): boolean {
	if (message.role !== undefined && message.role !== "assistant") return false;
	return assistantStopReason(message) === "stop"
		&& !assistantMessageHasError(message)
		&& !assistantMessageHasToolCall(message);
}
