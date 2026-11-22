import { type ExtensionAPI, type ExtensionContext, sliceHead } from "@bastani/atomic";
import { UNAUTHORIZED_REPLY_REASON } from "./broker/delivery-failure-reason.js";
import {
  type ClosedInboundAsk,
  type ClosedInboundAsks,
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

/** Refusals that say the sender has no live session; Subagents decides whether the sender ended. */
const SENDER_GONE_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "recipient_completed",
  "recipient_failed",
  "recipient_stopped",
  "recipient_cancelled",
]);

/** The most asks one record of closed asks names, and the most bytes their ids take, so a record stays small. */
const CLOSED_ASKS_PER_RECORD = 500;
const CLOSED_ASK_ID_BYTES_PER_RECORD = 32 * 1024;

/** The most closed asks a recovery notice names one by one; it counts the rest. */
export const CLOSED_ASKS_LISTED = 20;

/**
 * Record that this session closed each of `messageIds` without a reply, for `reason`: one entry per
 * {@link CLOSED_ASKS_PER_RECORD} asks (or {@link CLOSED_ASK_ID_BYTES_PER_RECORD} of their ids), not one per ask, so a
 * restart that closes many does not wait for a write each. Returns the ids whose record was saved; an ask whose record
 * was not saved stays pending.
 */
export async function recordClosedInboundAsks(
  atomic: Pick<ExtensionAPI, "appendEntry">,
  messageIds: readonly string[],
  reason: ClosedInboundAsk["reason"],
): Promise<string[]> {
  const recorded: string[] = [];
  for (const batch of closedAskBatches(messageIds)) {
    try {
      if (batch.length === 1) await recordClosedInboundAsk(atomic, batch[0]!, reason);
      else await atomic.appendEntry(INTERCOM_ASK_CLOSED_ENTRY, { messageIds: batch, reason } satisfies ClosedInboundAsks);
      recorded.push(...batch);
    } catch {
      // Unsaved, these asks stay pending; the next resume decides about them again.
    }
  }
  return recorded;
}

function closedAskBatches(messageIds: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const messageId of messageIds) {
    const size = Buffer.byteLength(messageId) + 3;
    if (batch.length > 0 && (batch.length >= CLOSED_ASKS_PER_RECORD || bytes + size > CLOSED_ASK_ID_BYTES_PER_RECORD)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(messageId);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The lines a recovery notice names closed asks with: the first {@link CLOSED_ASKS_LISTED}, and a count of the rest. */
function closedAskLines(closed: readonly IntercomContext[]): string {
  const lines = closed
    .slice(0, CLOSED_ASKS_LISTED)
    .map((context) => `- ${context.message.id} from \`${context.from.name ?? context.from.id}\`: ${preview(context)}`);
  if (closed.length > CLOSED_ASKS_LISTED) lines.push(`- and ${closed.length - CLOSED_ASKS_LISTED} more`);
  return lines.join("\n");
}

/** Record that this session closed `messageId` without a reply; the ask then stays closed across restarts (#6168). */
export async function recordClosedInboundAsk(
  atomic: Pick<ExtensionAPI, "appendEntry">,
  messageId: string,
  reason: ClosedInboundAsk["reason"],
): Promise<void> {
  await atomic.appendEntry(INTERCOM_ASK_CLOSED_ENTRY, { messageId, reason } satisfies ClosedInboundAsk);
}

/**
 * Close the ask `messageId` this session holds unanswered, without a reply: once its record is saved, it leaves the
 * pending asks, now and after every restart. Nothing is sent to its sender. A close that could not be saved leaves the
 * ask pending, so it can be closed again. Returns whether it was closed.
 */
export async function closeInboundAsk(
  atomic: Pick<ExtensionAPI, "appendEntry">,
  tracker: ReplyTracker,
  messageId: string,
  reason: ClosedInboundAsk["reason"],
): Promise<boolean> {
  try {
    await recordClosedInboundAsk(atomic, messageId, reason);
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
 * #6168: after a restart, close the asks this session holds unanswered whose sender is one of its subagents that has
 * ended: no reply can reach them, and they would otherwise stay pending for good. Returns the recovery notice naming
 * them, if any were closed. An ask whose close is not saved stays pending, and the next resume decides about it again.
 */
export async function closeFinishedChildAsks(
  atomic: AskCloser,
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
  const finished = await finishedChildAsks(atomic.events, sessionId, asks);
  const recorded = new Set(
    await recordClosedInboundAsks(
      atomic,
      asks.filter((context) => finished.has(context.message.id)).map((context) => context.message.id),
      "sender-ended",
    ),
  );
  const closed = asks.filter((context) => recorded.has(context.message.id));
  if (closed.length === 0) return [];
  return [
    `Closed ${closed.length === 1 ? "1 unanswered ask" : `${closed.length} unanswered asks`} from subagents that have ended: no reply can reach ${closed.length === 1 ? "it" : "them"} any more.\n${closedAskLines(closed)}`,
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
  atomic: AskCloser,
  tracker: ReplyTracker,
  sessionId: string,
  messageId: string,
  refused: RefusedReply,
): Promise<string | undefined> {
  let reason: ClosedInboundAsk["reason"] | undefined;
  if (refused.reasonCode === undefined && refused.reason === UNAUTHORIZED_REPLY_REASON) reason = "route-expired";
  else if (refused.reasonCode !== undefined && SENDER_GONE_CODES.has(refused.reasonCode)) {
    const context = tracker.listPending().find((pending) => pending.message.id === messageId);
    if (context !== undefined && (await finishedChildAsks(atomic.events, sessionId, [context])).has(messageId))
      reason = "sender-ended";
  }
  // A close that could not be saved leaves the ask pending: the next refused reply closes it.
  if (reason === undefined || !(await closeInboundAsk(atomic, tracker, messageId, reason))) return undefined;
  return reason === "route-expired"
    ? `Ask ${messageId} is closed: Intercom refuses every reply to it, so it no longer shows as pending. Send a plain message if its sender still needs the answer.`
    : `Ask ${messageId} is closed: the subagent that asked it has ended, so no reply can reach it and it no longer shows as pending. Send a plain message if the subagent still needs the answer.`;
}
