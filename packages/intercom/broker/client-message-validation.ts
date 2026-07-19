import type { Attachment, Message, SessionInfo } from "../types.js";

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const attachment = value as Record<string, unknown>;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") return false;
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") return false;
  return attachment.language === undefined || typeof attachment.language === "string";
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") return false;
  if (message.replyTo !== undefined && typeof message.replyTo !== "string") return false;
  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") return false;
  if (message.replyError !== undefined && typeof message.replyError !== "string") return false;
  if (typeof message.content !== "object" || message.content === null) return false;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") return false;
  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== "string"
    || typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) return false;
  if (session.name !== undefined && typeof session.name !== "string") return false;
  if (session.group !== undefined && typeof session.group !== "string") return false;
  return session.status === undefined || typeof session.status === "string";
}
