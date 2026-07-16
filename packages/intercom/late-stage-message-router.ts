import type { ExtensionAPI } from "@bastani/atomic";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { InboundMessageAdmission, InboundMessageReservation } from "./inbound-message-admission.js";
import type { IntercomContext, ReplyTracker } from "./reply-tracker.js";

const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
type LateStageMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type LateStageMessageEvent = {
  handled: boolean;
  completion?: Promise<void>;
  batch: boolean;
  messages: LateStageMessage[];
  options?: Parameters<ExtensionAPI["sendMessage"]>[1];
};

interface LateStageReservation {
  reservation: InboundMessageReservation;
  context: IntercomContext;
}

export function registerLateStageMessageRouter(
  pi: ExtensionAPI,
  admission: InboundMessageAdmission,
  getReplyTracker: () => ReplyTracker,
): void {
  pi.events.on(LATE_STAGE_MESSAGE_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    const event = data as Partial<LateStageMessageEvent>;
    if (!Array.isArray(event.messages) || typeof event.batch !== "boolean") return;
    const tracker = getReplyTracker();
    const accepted: LateStageMessage[] = [];
    const reservations: LateStageReservation[] = [];
    const joined: Promise<void>[] = [];
    let queuedTurnContext = false;
    for (const message of event.messages) {
      if (message.customType !== "intercom_message") { accepted.push(message); continue; }
      const entry = message.details as InboundMessageEntry | undefined;
      if (!entry?.from || !entry.message) continue;
      const result = admission.admit(entry.from, entry.message);
      if (result.kind === "pending") { joined.push(result.completion); continue; }
      if (result.kind === "duplicate") continue;
      const reservation = result.reservation;
      const context = tracker.recordIncomingMessage(entry.from, entry.message);
      if (!queuedTurnContext && event.options?.triggerTurn === true) {
        tracker.queueTurnContext(context);
        queuedTurnContext = true;
      }
      reservations.push({ reservation, context });
      accepted.push(message);
    }
    event.handled = true;
    for (const { reservation } of reservations) admission.beginDelivery(reservation);
    const delivery = deliver(pi, accepted, event);
    for (const { reservation } of reservations) admission.endDelivery(reservation);
    const ownedCompletion = delivery.then(
      () => { for (const { reservation } of reservations) admission.commit(reservation); },
      (error: Error) => {
        for (const { reservation, context } of reservations) {
          admission.release(reservation, error);
          tracker.forgetIncomingMessage(context);
        }
        throw error;
      },
    );
    event.completion = Promise.all([ownedCompletion, ...joined]).then(() => {});
    return event.completion;
  });
}

function deliver(
  pi: ExtensionAPI,
  accepted: LateStageMessage[],
  event: Partial<LateStageMessageEvent>,
): Promise<void> {
  if (accepted.length === 0) return Promise.resolve();
  try {
    if (event.batch && typeof pi.sendMessages === "function") {
      return Promise.resolve(pi.sendMessages(accepted, event.options as Parameters<ExtensionAPI["sendMessages"]>[1]));
    }
    const deliveries = accepted.map((message, index) => pi.sendMessage(
      message,
      index === 0 ? event.options : { deliverAs: "followUp" },
    ));
    return Promise.all(deliveries).then(() => {});
  } catch (error) {
    return Promise.reject(error);
  }
}
