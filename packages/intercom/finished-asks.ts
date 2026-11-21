import { type ExtensionAPI, type ExtensionContext, sliceHead } from "@bastani/atomic";
import { UNAUTHORIZED_REPLY_REASON } from "./broker/delivery-failure-reason.js";
import {
  type ClosedInboundAsk,
  INTERCOM_ASK_CLOSED_ENTRY,
  type IntercomContext,
  ReplyTracker,
  restorePendingInboundAsks,
} from "./reply-tracker.js";
import { finishedChildAsks } from "./session-recovery.js";

const PREVIEW_CHARS = 120;

/** What closing asks needs of the extension API: saving the close, and asking Subagents. */
type AskCloser = Pick<ExtensionAPI, "appendEntry"> & {
  readonly events: { emit(eventName: string, payload: unknown): void };
};

/** Refusals that say the sender has no live session; Subagents decides whether its asking attempt is over. */
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

/**
 * #6168: after a restart, close the asks this session holds unanswered whose sender is one of its subagents and whose
 * asking attempt is over: no reply can reach them, and they would otherwise stay pending for good. Returns the recovery notice naming them, if any were closed. An ask whose
 * close is not saved stays pending, and the next resume decides about it again.
 */
export async function closeFinishedChildAsks(
  pi: AskCloser,
  ctx: Pick<ExtensionContext, "sessionManager">,
): Promise<string[]> {
  const pending = new ReplyTracker();
  const sessionId = ctx.sessionManager.getSessionId();
  try {
    restorePendingInboundAsks(
      pending,
      ctx.sessionManager.getBranch(),
      sessionId,
      () => ctx.sessionManager.getSessionRecoveryState?.().answeredInboundIds,
    );
  } catch {
    return [];
  }
  const asks = pending.listPending();
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
    `Closed ${closed.length === 1 ? "1 unanswered ask" : `${closed.length} unanswered asks`} from subagents whose run that asked ${closed.length === 1 ? "it" : "them"} has ended: no reply can reach ${closed.length === 1 ? "it" : "them"} any more.\n${lines.join("\n")}`,
  ];
}

/** How a reply to an ask was refused, as the broker reported it. */
export interface RefusedReply {
  readonly reason?: string;
  readonly reasonCode?: string;
}

/**
 * #6168: close the ask `messageId` when its reply was refused in a way no later reply can get past: Intercom refuses
 * every reply to it (its route expired, or it was answered), or its sender is a subagent of this session whose asking
 * attempt is over. A refusal that may pass, such as a sender Intercom cannot find right now, keeps the ask pending.
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
    : `Ask ${messageId} is closed: the run of the subagent that asked it has ended, so no reply can reach that question and it no longer shows as pending. Send a plain message if the subagent still needs the answer.`;
}
