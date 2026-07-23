import type { IntercomClient } from "./broker/client.js";
import type { InboundMessageAdmission, InboundMessageReservation } from "./inbound-message-admission.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { IntercomContext, ReplyTracker } from "./reply-tracker.js";

/** Sends an exact-thread tool error when destination-side stage admission fails. */
export async function sendWorkflowStageDeliveryFailure(
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

/** Builds the target-side rejection path for an open workflow-stage delivery. */
export function createWorkflowStageDeliveryFailureHandler(input: {
  entry: InboundMessageEntry;
  admission: InboundMessageAdmission;
  reservation: InboundMessageReservation;
  tracker: ReplyTracker;
  replyContext: IntercomContext;
  currentClient: () => IntercomClient | null;
  commit: () => void;
}): (error: unknown) => Promise<void> {
  let settlement: Promise<void> | undefined;
  return (error) => {
    settlement ??= settleOpenStageDeliveryFailure(input, error);
    return settlement;
  };
}

async function settleOpenStageDeliveryFailure(
  input: {
    entry: InboundMessageEntry;
    admission: InboundMessageAdmission;
    reservation: InboundMessageReservation;
    tracker: ReplyTracker;
    replyContext: IntercomContext;
    currentClient: () => IntercomClient | null;
    commit: () => void;
  },
  error: unknown,
): Promise<void> {
  const failure = error instanceof Error ? error : new Error(String(error));
  input.tracker.forgetIncomingMessage(input.replyContext);
  if (input.entry.message.expectsReply !== true) {
    input.admission.release(input.reservation, failure);
    return;
  }
  const delivered = await sendWorkflowStageDeliveryFailure(
    input.entry,
    failure,
    input.tracker,
    input.currentClient,
    () => input.currentClient()?.isConnected() === true,
    "Running workflow stage could not admit intercom ask",
  );
  if (delivered) input.commit();
  else input.admission.release(input.reservation, failure);
}
