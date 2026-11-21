import { type ExtensionAPI, type ExtensionContext, sliceHead } from "@bastani/atomic";
import { UNAUTHORIZED_REPLY_REASON } from "./broker/delivery-failure-reason.js";
import {
  type ClosedInboundAsk,
  INTERCOM_ASK_CLOSED_ENTRY,
  type IntercomContext,
  ReplyTracker,
  restorePendingInboundAsks,
} from "./reply-tracker.js";
import { finishedChildAsks, type ReplyRouteVerdict, relaunchedChildAsks } from "./session-recovery.js";

const PREVIEW_CHARS = 120;

/** What closing asks needs of the extension API: saving the close, and asking Subagents. */
type AskCloser = Pick<ExtensionAPI, "appendEntry"> & {
  readonly events: { emit(eventName: string, payload: unknown): void };
};

/** Refusals that say the sender has no live session; Subagents decides whether the sender ended. */
const SENDER_GONE_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "recipient_completed",
  "recipient_failed",
  "recipient_stopped",
  "recipient_cancelled",
]);

/** Record that this session closed `messageId` without a reply; the ask then stays closed across restarts (#6168). */
export async function recordClosedInboundAsk(
  pi: Pick<ExtensionAPI, "appendEntry">,
  messageId: string,
  reason: ClosedInboundAsk["reason"],
): Promise<void> {
  await pi.appendEntry(INTERCOM_ASK_CLOSED_ENTRY, { messageId, reason } satisfies ClosedInboundAsk);
}

/**
 * Close the ask `messageId` this session holds unanswered, without a reply: once its record is saved, it leaves the
 * pending asks, now and after every restart. Nothing is sent to its sender. A close that could not be saved leaves the
 * ask pending, so it can be closed again. Returns whether it was closed.
 */
export async function closeInboundAsk(
  pi: Pick<ExtensionAPI, "appendEntry">,
  tracker: ReplyTracker,
  messageId: string,
  reason: ClosedInboundAsk["reason"],
): Promise<boolean> {
  try {
    await recordClosedInboundAsk(pi, messageId, reason);
  } catch {
    return false;
  }
  tracker.markReplied(messageId);
  return true;
}

function preview(context: IntercomContext): string {
  const text = context.message.content.text.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_CHARS ? `${sliceHead(text, PREVIEW_CHARS)}…` : text;
}

/** The asks this session holds unanswered, as a reopened session restores them; none when its branch cannot be read. */
export function heldInboundAsks(ctx: Pick<ExtensionContext, "sessionManager">): IntercomContext[] {
  const pending = new ReplyTracker();
  try {
    restorePendingInboundAsks(
      pending,
      ctx.sessionManager.getBranch(),
      ctx.sessionManager.getSessionId(),
      () => ctx.sessionManager.getSessionRecoveryState?.().answeredInboundIds,
    );
  } catch {
    return [];
  }
  return pending.listPending();
}

/**
 * #6168: after a restart, close the asks this session holds unanswered whose sender is one of its subagents that has
 * ended: no reply can reach them, and they would otherwise stay pending for good. Returns the recovery notice naming
 * them, if any were closed. An ask whose close is not saved stays pending, and the next resume decides about it again.
 */
export async function closeFinishedChildAsks(
  pi: AskCloser,
  ctx: Pick<ExtensionContext, "sessionManager">,
  asks: readonly IntercomContext[] = heldInboundAsks(ctx),
): Promise<string[]> {
  const sessionId = ctx.sessionManager.getSessionId();
  const finished = await finishedChildAsks(pi.events, sessionId, asks);
  const closed: IntercomContext[] = [];
  for (const context of asks) {
    if (!finished.has(context.message.id)) continue;
    try {
      await recordClosedInboundAsk(pi, context.message.id, "sender-ended");
      closed.push(context);
    } catch {
      // Unsaved, the ask stays pending; the next resume decides about it again.
    }
  }
  if (closed.length === 0) return [];
  const lines = closed.map(
    (context) => `- ${context.message.id} from \`${context.from.name ?? context.from.id}\`: ${preview(context)}`,
  );
  return [
    `Closed ${closed.length === 1 ? "1 unanswered ask" : `${closed.length} unanswered asks`} from subagents that have ended: no reply can reach ${closed.length === 1 ? "it" : "them"} any more.\n${lines.join("\n")}`,
  ];
}

/** How the broker would take a reply to each of these asks; `unknown` for all when it cannot be asked. */
export type ReplyRouteQuery = (
  replies: readonly { readonly replyTo: string; readonly to: string }[],
) => Promise<readonly ReplyRouteVerdict[]>;

/**
 * After a restart, close the asks this session holds unanswered from a subagent the restart relaunched, when the broker
 * says a reply to one would be refused now as one no pending question authorizes: the same refusal that closes an ask
 * when a reply to it is refused (#6168). The relaunched subagent's earlier run asked it, and its route did not come back
 * with the subagent. An ask whose reply the broker would route, or about which it cannot tell, stays pending. Nothing is
 * sent to the subagent. A verdict that arrives once `isCurrent` no longer holds closes nothing. Returns the recovery
 * notice naming the closed asks, if any.
 */
export async function closeRelaunchedChildAsks(
  pi: AskCloser,
  ctx: Pick<ExtensionContext, "sessionManager">,
  query: ReplyRouteQuery,
  isCurrent: () => boolean = () => true,
  held: readonly IntercomContext[] = heldInboundAsks(ctx),
): Promise<string[]> {
  const relaunched = await relaunchedChildAsks(pi.events, ctx.sessionManager.getSessionId(), held);
  const asks = held.filter((context) => relaunched.has(context.message.id));
  if (asks.length === 0) return [];
  const verdicts = await query(asks.map((context) => ({ replyTo: context.message.id, to: context.from.id })));
  const closed: IntercomContext[] = [];
  for (const [index, context] of asks.entries()) {
    if (verdicts[index] !== "refused" || !isCurrent()) continue;
    try {
      await recordClosedInboundAsk(pi, context.message.id, "route-expired");
      closed.push(context);
    } catch {
      // Unsaved, the ask stays pending: a refused reply, or the next restart, closes it.
    }
  }
  if (closed.length === 0) return [];
  const lines = closed.map(
    (context) => `- ${context.message.id} from \`${context.from.name ?? context.from.id}\`: ${preview(context)}`,
  );
  return [
    `Closed ${closed.length === 1 ? "1 unanswered ask" : `${closed.length} unanswered asks`} from subagents this restart relaunched: Intercom would refuse a reply to ${closed.length === 1 ? "it" : "them"} now, as no question of the relaunched subagent authorizes one, so ${closed.length === 1 ? "it no longer shows" : "they no longer show"} as pending. Send a plain message if a subagent still needs the answer.\n${lines.join("\n")}`,
  ];
}

/** How a reply to an ask was refused, as the broker reported it. */
export interface RefusedReply {
  readonly reason?: string;
  readonly reasonCode?: string;
}

/**
 * #6168: close the ask `messageId` when its reply was refused in a way no later reply can get past: Intercom refuses
 * every reply to it (its route expired, or it was answered), or its sender is a subagent of this session that has
 * ended. A refusal that may pass, such as a sender Intercom cannot find right now, keeps the ask pending.
 * Returns the sentence that tells the caller the ask is closed, or `undefined` when it stays pending.
 */
export async function closeRefusedAsk(
  pi: AskCloser,
  tracker: ReplyTracker,
  sessionId: string,
  messageId: string,
  refused: RefusedReply,
): Promise<string | undefined> {
  let reason: ClosedInboundAsk["reason"] | undefined;
  if (refused.reasonCode === undefined && refused.reason === UNAUTHORIZED_REPLY_REASON) reason = "route-expired";
  else if (refused.reasonCode !== undefined && SENDER_GONE_CODES.has(refused.reasonCode)) {
    const context = tracker.listPending().find((pending) => pending.message.id === messageId);
    if (context !== undefined && (await finishedChildAsks(pi.events, sessionId, [context])).has(messageId))
      reason = "sender-ended";
  }
  // A close that could not be saved leaves the ask pending: the next refused reply closes it.
  if (reason === undefined || !(await closeInboundAsk(pi, tracker, messageId, reason))) return undefined;
  return reason === "route-expired"
    ? `Ask ${messageId} is closed: Intercom refuses every reply to it, so it no longer shows as pending. Send a plain message if its sender still needs the answer.`
    : `Ask ${messageId} is closed: the subagent that asked it has ended, so no reply can reach it and it no longer shows as pending. Send a plain message if the subagent still needs the answer.`;
}
