import type { Attachment, Message } from "../types.js";

export interface LogicalSendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  replyError?: string;
}

export function canonicalizeAttachmentsForSendSignature(
	attachments: readonly Attachment[] | undefined,
): Array<Record<string, string>> | undefined {
  return attachments?.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    content: attachment.content,
    ...(attachment.language === undefined ? {} : { language: attachment.language }),
  }));
}

/** Canonical identity for one logical send; transport attempt metadata is deliberately excluded. */
export function buildSendSignature(to: string, options: LogicalSendOptions): string {
  return JSON.stringify({
    to,
    text: options.text,
    attachments: canonicalizeAttachmentsForSendSignature(options.attachments) ?? [],
    replyTo: options.replyTo ?? null,
    expectsReply: options.expectsReply ?? false,
    replyError: options.replyError ?? null,
  });
}

export function buildMessageSendSignature(to: string, message: Message, senderId?: string): string {
	const logicalSignature = buildSendSignature(to, {
		text: message.content.text,
		attachments: message.content.attachments,
		replyTo: message.replyTo,
		expectsReply: message.expectsReply,
		replyError: message.replyError,
	});
	if (senderId === undefined && message.source === undefined) return logicalSignature;
	return JSON.stringify({
		senderId: senderId ?? null,
		logicalSignature,
		source: message.source === undefined
			? null
			: {
					subagentRunId: message.source.subagentRunId,
					subagentAgent: message.source.subagentAgent ?? null,
					subagentIndex: message.source.subagentIndex ?? null,
				},
	});
}
