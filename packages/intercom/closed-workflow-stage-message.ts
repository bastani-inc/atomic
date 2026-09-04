import type { IntercomClient } from "./broker/client.js";
import type { InboundMessageAdmission } from "./inbound-message-admission.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import { routeIncomingReply } from "./reply-routing.js";
import type { ReplyTracker } from "./reply-tracker.js";
import type { ReplyWaiterRecord } from "./reply-waiter.ts";
import { retryStableDelivery } from "./stable-delivery-retry.js";
import { sendWorkflowStageDeliveryFailure } from "./workflow-stage-delivery-failure.js";

/**
 * Owns late ingress after a workflow stage seals its active generation.
 * The stage boundary retains the exact subagent run IDs it launched, so only
 * matching child traffic is dropped instead of escaping to the parent route.
 * Blocking asks from other sessions are handed to workflow post-mortem routing
 * once; ordinary non-owned notifications retain the stable parent-route retry.
 */
export function routeClosedWorkflowStageMessage(
  entry: InboundMessageEntry,
  admission: InboundMessageAdmission,
  tracker: ReplyTracker,
  waiter: ReplyWaiterRecord | Iterable<ReplyWaiterRecord> | null,
  deliver: () => Promise<void>,
  currentClient: () => IntercomClient | null,
  isCurrent: () => boolean,
  ownsSubagentRun: (runId: string) => boolean,
): void {
  const sourceRunId = entry.message.source?.subagentRunId;
  if (sourceRunId !== undefined && ownsSubagentRun(sourceRunId)) return;

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
