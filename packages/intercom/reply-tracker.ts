import type { SessionEntry } from "@bastani/atomic";
import { isMessage, isSessionInfo } from "./broker/client-message-validation.js";
import type { Message, SessionInfo } from "./types.js";
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
  private turnContextAdmitted = false;

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

  /**
   * A turn starting binds nothing: a queued context's message may not be visible to the model yet
   * (a followUp waiting behind a tool call, or a continuation with no new input), so only
   * `admitTurnMessage` makes it the reply target.
   */
  beginTurn(): void {
    this.turnContextAdmitted = false;
  }

  /**
   * An inbound message entered this turn's model context, so the model has seen it and it leaves
   * the queue. Steer, followUp, and interrupt deliveries reach turns out of arrival order, so the
   * first admitted message with a queued context becomes the turn's reply target; later messages
   * admitted in the same turn (followUpMode "all") stay eligible for the implicit fallback.
   */
  admitTurnMessage(messageId: string): void {
    if (this.currentTurnContext?.message.id === messageId) {
      this.turnContextAdmitted = true;
      return;
    }
    const index = this.pendingTurnContexts.findIndex((context) => context.message.id === messageId);
    if (index < 0) return;
    const [admitted] = this.pendingTurnContexts.splice(index, 1);
    if (this.turnContextAdmitted) return;
    this.currentTurnContext = admitted!;
    this.turnContextAdmitted = true;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  /**
   * A cancelled turn that produced nothing could not have replied. Its message is already in the
   * model's context and will not be admitted again, so it stays the target for the next turn.
   */
  restoreTurnContext(): void {
    this.turnContextAdmitted = false;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

	/** An ask has no expiry (#4751): it can be answered until it is replied to. */
	resolveReplyTarget(options: { to?: string; replyTo?: string }): IntercomContext {
		if (options.replyTo !== undefined) {
			const contexts = new Map(this.pendingAsks);
			if (this.currentTurnContext && !this.currentTurnContext.message.expectsReply) {
				contexts.set(this.currentTurnContext.message.id, this.currentTurnContext);
			}
			const resolution = resolveSessionTarget(Array.from(contexts.keys(), (id) => ({ id })), options.replyTo);
			if (resolution.kind === "ambiguous_id_prefix" || resolution.kind === "ambiguous_name") {
				throw new Error(sessionTargetFailureReason(options.replyTo, resolution));
			}
			const exact = resolution.kind === "resolved" ? contexts.get(resolution.session.id) : undefined;
			if (!exact) throw new Error(`No reply context for "${options.replyTo}"`);
			if (options.to !== undefined) {
				const resolution = resolveSessionTarget([exact.from], options.to);
				if (resolution.kind !== "resolved") throw new Error(`Reply context "${options.replyTo}" is not from "${options.to}"`);
			}
			return exact;
		}
    if (options.to === undefined && this.currentTurnContext) {
      return this.currentTurnContext;
    }

    const pending = Array.from(this.pendingAsks.values());
    if (options.to !== undefined) {
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
    // An implicit reply may only answer an ask the model has seen; a queued context is not yet visible.
    const visible = pending.filter(
      (context) => !this.pendingTurnContexts.some((queued) => queued.message.id === context.message.id),
    );
    if (visible.length === 1) {
      return visible[0]!;
    }

    if (visible.length === 0) {
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) {
      if (this.pendingTurnContexts[index]?.message.id === replyTo) this.pendingTurnContexts.splice(index, 1);
    }
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  listPending(): IntercomContext[] {
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }
}

/**
 * #4751: after a restart, the asks this session was sent and has not answered can still be answered. Their cards are
 * on the branch; a reply this session sent (`intercom_sent` with `replyTo`) marks one answered.
 */
export function restorePendingInboundAsks(tracker: ReplyTracker, entries: Iterable<SessionEntry>): void {
  const asks = new Map<string, IntercomContext>();
  const answered = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === "intercom_message") {
      const details = entry.details as { from?: unknown; message?: unknown } | undefined;
      if (!isSessionInfo(details?.from) || !isMessage(details.message) || details.message.expectsReply !== true) continue;
      if ((details as { historyOnly?: unknown }).historyOnly === true) continue;
      asks.set(details.message.id, { from: details.from, message: details.message, receivedAt: Date.parse(entry.timestamp) || Date.now() });
    } else if (entry.type === "custom" && entry.customType === "intercom_sent") {
      const replyTo = (entry.data as { message?: { replyTo?: unknown } } | undefined)?.message?.replyTo;
      if (typeof replyTo === "string") answered.add(replyTo);
    }
  }
  for (const [id, context] of asks) {
    if (!answered.has(id)) tracker.recordIncomingMessage(context.from, context.message, context.receivedAt);
  }
}
