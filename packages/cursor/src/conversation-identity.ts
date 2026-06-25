import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";

export interface CursorConversationIdentity {
	readonly activeKey: string;
	readonly wireConversationId: string;
}

export function deriveCursorConversationIdentity(
	context: Context,
	sessionId: string | undefined,
): CursorConversationIdentity {
	const bridgeKey = deriveCursorConversationKey("bridge", context, sessionId);
	const conversationKey = deriveCursorConversationKey("conv", context, sessionId);
	return { activeKey: bridgeKey, wireConversationId: deterministicCursorConversationId(conversationKey) };
}

export function deriveCursorBridgeKeyFromSessionId(sessionId: string): string {
	return hashCursorKey("bridge", sessionId);
}

export function deriveCursorWireConversationIdFromSessionId(sessionId: string): string {
	return deterministicCursorConversationId(hashCursorKey("conv", sessionId));
}

function deriveCursorConversationKey(prefix: "bridge" | "conv", context: Context, sessionId: string | undefined): string {
	const trimmedSessionId = sessionId?.trim();
	if (trimmedSessionId) return hashCursorKey(prefix, trimmedSessionId);
	const firstUserMessage = context.messages.find((message) => message.role === "user");
	const firstUserText = firstUserMessage ? textFromUserMessage(firstUserMessage).slice(0, 200) : "";
	return hashCursorKey(prefix, firstUserText);
}

function textFromUserMessage(message: Extract<Context["messages"][number], { readonly role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function hashCursorKey(prefix: "bridge" | "conv", value: string): string {
	return createHash("sha256").update(`${prefix}:${value}`).digest("hex").slice(0, 16);
}

function deterministicCursorConversationId(conversationKey: string): string {
	const hex = createHash("sha256").update(`cursor-conv-id:${conversationKey}`).digest("hex").slice(0, 32);
	const variantNibble = (0x8 | (Number.parseInt(hex[16] ?? "0", 16) & 0x3)).toString(16);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${variantNibble}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
}
