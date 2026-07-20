import type { IntercomClient } from "./broker/client.js";
import type { InboundMessageAdmission } from "./inbound-message-admission.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import { routeIncomingReply } from "./reply-routing.js";
import type { ReplyTracker } from "./reply-tracker.js";
import type { ReplyWaiterRecord } from "./reply-waiter.js";
import { retryStableDelivery } from "./stable-delivery-retry.js";
import { sendWorkflowStageDeliveryFailure } from "./workflow-stage-delivery-failure.js";

/**
 * Owns late ingress after a workflow stage seals its active generation.
 * Blocking asks are handed to workflow post-mortem routing once and receive a
 * correlated remote tool error if revival fails. Ordinary late notifications
 * retain the stable parent-route retry used before completed-stage asks existed.
 */
export function routeClosedWorkflowStageMessage(
  entry: InboundMessageEntry,
  admission: InboundMessageAdmission,
  tracker: ReplyTracker,
  waiter: ReplyWaiterRecord | null,
  deliver: () => Promise<void>,
  currentClient: () => IntercomClient | null,
  isCurrent: () => boolean,
): void {
  if (entry.message.expectsReply !== true) {
    void retryStableDelivery({ deliver, isCurrent }).catch(() => {});
    return;
  }
  const admitted = admission.admit(entry.from, entry.message);
  if (admitted.kind !== "reserved") return;
  if (routeIncomingReply(waiter, entry.from, entry.message)) {
    admission.commit(admitted.reservation);
    return;
  }
  const replyContext = tracker.recordIncomingMessage(entry.from, entry.message);
  tracker.queueTurnContext(replyContext);
  const delivery = invoke(deliver);
  void delivery.then(
    () => { admission.commit(admitted.reservation); },
    async (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      tracker.forgetIncomingMessage(replyContext);
      if (entry.message.expectsReply === true
        && await sendWorkflowStageDeliveryFailure(
          entry,
          failure,
          tracker,
          currentClient,
          isCurrent,
          "Completed workflow stage could not process intercom ask",
        )) {
        admission.commit(admitted.reservation);
        return;
      }
      admission.release(admitted.reservation, failure);
    },
  ).catch(() => {});
}

function invoke(deliver: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(deliver());
  } catch (error) {
    return Promise.reject(error);
  }
}
