import type { IntercomClient } from "./broker/client.js";
import type { InboundMessageAdmission, InboundMessageReservation } from "./inbound-message-admission.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { IntercomContext, ReplyTracker } from "./reply-tracker.js";

/** Sends an exact-thread tool error when destination-side admission fails. */
export async function sendInboundDeliveryFailure(
  entry: InboundMessageEntry,
  failure: Error,
  tracker: ReplyTracker,
  currentClient: () => IntercomClient | null,
  isCurrent: () => boolean,
  prefix: string,
): Promise<boolean> {
  const client = currentClient();
  if (!client?.isConnected() || !isCurrent()) return false;
  const actionable = `${prefix}: ${failure.message}`;
  try {
    const result = await client.send(entry.from.id, {
      text: actionable,
      replyTo: entry.message.id,
      replyError: actionable,
    });
    if (!result.delivered) return false;
    tracker.markReplied(entry.message.id);
    return true;
  } catch {
    return false;
  }
}

/** Builds the target-side rejection path for an arriving message the session could not admit. */
export function createInboundDeliveryFailureHandler(input: {
  entry: InboundMessageEntry;
  admission: InboundMessageAdmission;
  reservation: InboundMessageReservation;
  tracker: ReplyTracker;
  replyContext: IntercomContext;
  currentClient: () => IntercomClient | null;
  commit: () => void;
  failurePrefix?: string;
}): (error: unknown) => Promise<void> {
  let settlement: Promise<void> | undefined;
  return (error) => {
    settlement ??= settleInboundDeliveryFailure(input, error);
    return settlement;
  };
}

async function settleInboundDeliveryFailure(
  input: {
    entry: InboundMessageEntry;
    admission: InboundMessageAdmission;
    reservation: InboundMessageReservation;
    tracker: ReplyTracker;
    replyContext: IntercomContext;
    currentClient: () => IntercomClient | null;
    commit: () => void;
    failurePrefix?: string;
  },
  error: unknown,
): Promise<void> {
  const failure = error instanceof Error ? error : new Error(String(error));
  input.tracker.forgetIncomingMessage(input.replyContext);
  if (input.entry.message.expectsReply !== true) {
    input.admission.release(input.reservation, failure);
    return;
  }
  const delivered = await sendInboundDeliveryFailure(
    input.entry,
    failure,
    input.tracker,
    input.currentClient,
    () => input.currentClient()?.isConnected() === true,
    input.failurePrefix ?? "Recipient could not admit intercom ask",
  );
  if (delivered) input.commit();
  else input.admission.release(input.reservation, failure);
}
