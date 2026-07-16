import type { Message, SessionInfo } from "./types.ts";
import { resolveSessionTarget, sessionTargetFailureReason } from "./session-target.js";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = 10 * 60 * 1000) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context = { from, message, receivedAt };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
  }

  forgetIncomingMessage(context: IntercomContext): void {
    if (this.pendingAsks.get(context.message.id) === context) this.pendingAsks.delete(context.message.id);
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnContexts[index] === context) this.pendingTurnContexts.splice(index, 1);
    }
    if (this.currentTurnContext === context) this.currentTurnContext = null;
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    if (this.currentTurnContext) {
      return this.currentTurnContext;
    }

    const pending = Array.from(this.pendingAsks.values());
    if (options.to) {
      const senders = [...new Map(
        pending.map((context) => [context.from.id, context.from] as const),
      ).values()];
      const resolution = resolveSessionTarget(senders, options.to);
      if (resolution.kind !== "resolved") {
        if (resolution.kind === "not_found") {
          throw new Error(`No pending ask from "${options.to}"`);
        }
        throw new Error(sessionTargetFailureReason(options.to, resolution));
      }
      const matches = pending.filter(
        (context) => context.from.id === resolution.session.id,
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from "${options.to}"`);
      }
      throw new Error(`No pending ask from "${options.to}"`);
    }
    if (pending.length === 1) {
      return pending[0]!;
    }

    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
      }
    }
  }
}
