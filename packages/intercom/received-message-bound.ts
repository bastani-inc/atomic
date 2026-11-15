import { boundOversizedText, DEFAULT_MAX_BYTES } from "@bastani/atomic";
import { formatAttachments } from "./intercom-utils.js";
import type { Message } from "./types.js";

/**
 * #4907: largest received message, its text plus its attachments as shown, in UTF-8 bytes, that enters the
 * recipient's context whole. It is the tool-result truncation limit; a larger message is saved to a file.
 */
export const INTERCOM_MAX_RECEIVED_MESSAGE_BYTES = DEFAULT_MAX_BYTES;

/** Where a received message too large for the context is saved. */
export interface ReceivedMessageSpillSession {
	readonly sessionId: string;
	readonly sessionDir?: string;
}

function shownText(message: Message): string {
	const attachments = message.content.attachments;
	return `${message.content.text}${attachments?.length ? formatAttachments(attachments) : ""}`;
}

/** Whether a received message is larger than {@link INTERCOM_MAX_RECEIVED_MESSAGE_BYTES} once shown. */
export function receivedMessageExceedsBound(message: Message): boolean {
	return Buffer.byteLength(shownText(message), "utf8") > INTERCOM_MAX_RECEIVED_MESSAGE_BYTES;
}

/**
 * #4907: a received message within the limit is returned unchanged. A larger one has its text and attachments saved
 * to a file in the session's directory, like an oversized tool result, and becomes a message whose text is a short
 * preview plus that file's path, so neither the context nor the saved session holds it whole.
 */
export async function boundReceivedMessage(
	message: Message,
	session: () => ReceivedMessageSpillSession,
): Promise<Message> {
	if (!receivedMessageExceedsBound(message)) return message;
	const { content: _content, ...rest } = message;
	const text = await boundOversizedText({
		text: shownText(message),
		maxBytes: INTERCOM_MAX_RECEIVED_MESSAGE_BYTES,
		...session(),
	});
	return { ...rest, content: { text } };
}
