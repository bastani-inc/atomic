import type net from "node:net";
import type { Attachment, BrokerMessage, Message, SessionInfo } from "../types.js";
import { resolveSessionTarget, sessionTargetFailureReason } from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { buildMessageSendSignature } from "./send-signature.js";

export interface BrokerConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
}

interface SendClientMessage extends Record<string, unknown> {
  type: string;
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const attachment = value as Record<string, unknown>;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") return false;
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") return false;
  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") return false;
  if (message.replyTo !== undefined && typeof message.replyTo !== "string") return false;
  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") return false;
  if (typeof message.content !== "object" || message.content === null) return false;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") return false;
  return content.attachments === undefined || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

/** Validate and route one wire-level send request. */
export function handleBrokerSend(
  socket: net.Socket,
  clientMessage: SendClientMessage,
  currentId: string | null,
  sessions: Map<string, BrokerConnectedSession>,
  deliveredMessages: DeliveredMessageCache,
  write: (target: net.Socket, message: BrokerMessage) => void,
): void {
  const message = clientMessage.message;
  const messageId = isMessage(message) ? message.id : "unknown";
  const hasAttemptId = Object.prototype.hasOwnProperty.call(clientMessage, "attemptId");
  if (hasAttemptId && typeof clientMessage.attemptId !== "string") {
    write(socket, {
      type: "delivery_failed",
      messageId,
      reason: "Invalid attemptId format",
    });
    return;
  }
  const attemptId = typeof clientMessage.attemptId === "string" ? clientMessage.attemptId : undefined;
  if (typeof clientMessage.to !== "string" || !isMessage(message)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid message format" });
    return;
  }

  const signature = buildMessageSendSignature(clientMessage.to, message);
  const deliveredMatch = deliveredMessages.lookup(message.id, signature);
  if (deliveredMatch === "match") {
    write(socket, { type: "delivered", messageId: message.id, attemptId });
    return;
  }
  if (deliveredMatch === "conflict") {
    write(socket, {
      type: "delivery_failed",
      messageId: message.id,
      attemptId,
      reason: `Intercom message ID '${message.id}' was already delivered with a different target or payload`,
    });
    return;
  }

  const resolution = resolveSessionTarget(
    Array.from(sessions.values(), (session) => session.info),
    clientMessage.to,
  );
  if (resolution.kind === "resolved") {
    const target = sessions.get(resolution.session.id);
    const fromSession = currentId ? sessions.get(currentId) : undefined;
    if (!fromSession) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Sender session not found" });
      return;
    }
    if (!target) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Session not found" });
      return;
    }
    if (target.info.id === fromSession.info.id) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Cannot message the current session" });
      return;
    }
    write(target.socket, { type: "message", from: fromSession.info, message });
    deliveredMessages.record(message.id, signature);
    write(socket, { type: "delivered", messageId: message.id, attemptId });
    return;
  }
  write(socket, {
    type: "delivery_failed",
    messageId: message.id,
    attemptId,
    reason: sessionTargetFailureReason(clientMessage.to, resolution),
  });
}
