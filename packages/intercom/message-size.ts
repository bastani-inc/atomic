import type { Message } from "./types.js";

const MIB = 1024 * 1024;

/** Largest Intercom message text, in UTF-8 bytes. */
export const INTERCOM_MAX_MESSAGE_TEXT_BYTES = MIB;

/**
 * Largest Intercom message overall, in UTF-8 bytes: the text plus every attachment's name, language and content.
 * Even when every byte needs JSON escaping, a message this size stays well under the broker's frame size cap.
 */
export const INTERCOM_MAX_MESSAGE_BYTES = 8 * MIB;

/** UTF-8 bytes of a message's text and attachments: the size the Intercom limits measure. */
export function intercomMessageBytes(content: Message["content"]): number {
	let bytes = Buffer.byteLength(content.text);
	for (const attachment of content.attachments ?? []) {
		bytes += Buffer.byteLength(attachment.name) + Buffer.byteLength(attachment.content);
		if (attachment.language !== undefined) bytes += Buffer.byteLength(attachment.language);
	}
	return bytes;
}

/** Why a message is too large to send, or `undefined` when it is within both limits. */
export function intercomMessageSizeError(content: Message["content"]): string | undefined {
	const textBytes = Buffer.byteLength(content.text);
	if (textBytes > INTERCOM_MAX_MESSAGE_TEXT_BYTES) {
		return `Intercom message text is ${textBytes} bytes, over the limit of ${INTERCOM_MAX_MESSAGE_TEXT_BYTES} bytes (1 MiB); the message was not sent. Shorten it, or save the content to a file and send its path.`;
	}
	const totalBytes = intercomMessageBytes(content);
	if (totalBytes > INTERCOM_MAX_MESSAGE_BYTES) {
		return `Intercom message text and attachments total ${totalBytes} bytes, over the limit of ${INTERCOM_MAX_MESSAGE_BYTES} bytes (8 MiB); the message was not sent. Send fewer or smaller attachments, or save the content to files and send their paths.`;
	}
	return undefined;
}
