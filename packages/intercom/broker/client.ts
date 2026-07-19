import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import type { SessionInfo, Message, Attachment } from "../types.js";
import { buildSendSignature, PendingSendRegistry } from "./pending-send-registry.js";
import { readSubagentMessageSource } from "../source-ownership.js";

const BROKER_SOCKET = getBrokerSocketPath();

interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  replyError?: string;
  messageId?: string;
  /** Marks a `contact_supervisor` vertical-channel send that bypasses peer-group isolation. */
  channel?: "supervisor";
}

interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const attachment = value as Record<string, unknown>;

  if (
    attachment.type !== "file"
    && attachment.type !== "snippet"
    && attachment.type !== "context"
  ) {
    return false;
  }

  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }

  return attachment.language === undefined || typeof attachment.language === "string";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }

  if (message.replyTo !== undefined && typeof message.replyTo !== "string") {
    return false;
  }

  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") {
    return false;
  }

  if (message.replyError !== undefined && typeof message.replyError !== "string") {
    return false;
  }

  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }

  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") {
    return false;
  }

  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.id !== "string"
    || typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.group !== undefined && typeof session.group !== "string") {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private pendingSends = new PendingSendRegistry();
  private pendingLists = new Map<string, { resolve: (sessions: SessionInfo[]) => void; reject: (e: Error) => void }>();
  private disconnecting = false;
  private disconnectError: Error | null = null;

  private failPending(error: Error): void {
    this.pendingSends.rejectAll(error);
    for (const pending of this.pendingLists.values()) pending.reject(error);
    this.pendingLists.clear();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }

    return socket;
  }

  connect(session: Omit<SessionInfo, "id">): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }

    return new Promise((resolve, reject) => {
      const socket = net.connect(BROKER_SOCKET);
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      
      try {
        writeMessage(socket, { type: "register", session });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null && brokerMessage.type !== "registered") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid registered message");
        }

        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        this._sessionId = brokerMessage.sessionId;
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }
        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          // Late list responses can still arrive after the caller has already timed out.
          return;
        }
        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }
      case "message": {
        const { from, message, channel } = brokerMessage;
        if (!isSessionInfo(from) || !isMessage(message) || (channel !== undefined && channel !== "supervisor")) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message, channel);
        break;
      }
      case "delivered": {
        const { messageId, attemptId } = brokerMessage;
        if (typeof messageId !== "string" || (attemptId !== undefined && typeof attemptId !== "string")) {
          throw new Error("Invalid delivered message");
        }
        const result = { id: messageId, delivered: true } as const;
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "delivery_failed": {
        const { messageId, attemptId, reason } = brokerMessage;
        if (typeof messageId !== "string" || (attemptId !== undefined && typeof attemptId !== "string") || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }
        const result = { id: messageId, delivered: false, reason } as const;
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "error": {
        if (typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        this.emit("error", new Error(brokerMessage.error));
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }
  listSessions(group?: string): Promise<SessionInfo[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const wrappedResolve = (sessions: SessionInfo[]) => {
        clearTimeout(timeout);
        resolve(sessions);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5000);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, group === undefined ? { type: "list", requestId } : { type: "list", requestId, group });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error));
      }
    });
  }
  send(to: string, options: SendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID();
    let acquired;
    try {
      acquired = this.pendingSends.acquire(messageId, buildSendSignature(to, options), 10000);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (!acquired.owner) return acquired.attempt.promise;

    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      replyError: options.replyError,
      source: readSubagentMessageSource(),
      content: { text: options.text, attachments: options.attachments },
    };
    try {
      writeMessage(socket, options.channel === "supervisor"
        ? { type: "send", to, message, attemptId: acquired.attempt.attemptId, channel: "supervisor" }
        : { type: "send", to, message, attemptId: acquired.attempt.attemptId });
    } catch (error) {
      this.pendingSends.reject(acquired.attempt, toError(error));
    }
    return acquired.attempt.promise;
  }
  updatePresence(updates: { name?: string; status?: string; model?: string }): void {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...updates });
  }
}
