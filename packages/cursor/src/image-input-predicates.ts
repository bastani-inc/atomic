import type { Context } from "@earendil-works/pi-ai";

function messageHasImageContent(message: Context["messages"][number]): boolean {
	return typeof message.content !== "string" && message.content.some((content) => content.type === "image");
}

export function hasUserImageInput(context: Context): boolean {
	return context.messages.some((message) => message.role === "user" && messageHasImageContent(message));
}

export function hasCurrentUserImageInput(context: Context): boolean {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (!message || message.role === "assistant" || message.role === "toolResult") break;
		if (message.role === "user" && messageHasImageContent(message)) return true;
	}
	return false;
}

export function hasToolResultImageInput(context: Context): boolean {
	return context.messages.some((message) => message.role === "toolResult" && messageHasImageContent(message));
}
