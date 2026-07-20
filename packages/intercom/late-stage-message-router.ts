import type { ExtensionAPI } from "@bastani/atomic";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { InboundMessageAdmission, InboundMessageReservation } from "./inbound-message-admission.js";
import type { IntercomContext, ReplyTracker } from "./reply-tracker.js";
import { DEFAULT_GROUP, normalizeGroup } from "./group.js";

const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
type LateStageMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type LateStageMessageEvent = {
  handled: boolean;
  completion?: Promise<void>;
  batch: boolean;
  messages: LateStageMessage[];
  workflowRunId?: string;
  workflowStageId?: string;
  options?: Parameters<ExtensionAPI["sendMessage"]>[1];
};

interface LateStageReservation {
  message: LateStageMessage;
  reservation: InboundMessageReservation;
  context: IntercomContext;
}

function isSubagentRelayHandoff(entry: InboundMessageEntry): boolean {
  return entry.from.id === "subagent-control" || entry.from.id === "subagent-result";
}

export function registerLateStageMessageRouter(
  pi: ExtensionAPI,
  admission: InboundMessageAdmission,
  getReplyTracker: () => ReplyTracker,
  getOwnerGroup: () => string = () => DEFAULT_GROUP,
): void {
  pi.events.on(LATE_STAGE_MESSAGE_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    const event = data as Partial<LateStageMessageEvent>;
    if (!Array.isArray(event.messages) || typeof event.batch !== "boolean") return;
    // The workflow extension owns blocking asks to a completed stage so it can
    // schedule a post-mortem turn in that exact retained conversation. Leaving
    // the event unhandled here also makes listener registration order irrelevant.
    if (isCompletedStageAskRoute(event)) return;
    const tracker = getReplyTracker();
    const accepted: LateStageMessage[] = [];
    const reservations: LateStageReservation[] = [];
    const joined: Promise<void>[] = [];
    let queuedTurnContext = false;
    for (const message of event.messages) {
      if (message.customType !== "intercom_message") { accepted.push(message); continue; }
      const entry = message.details as InboundMessageEntry | undefined;
      if (!entry?.from || !entry.message) continue;
      if (entry.channel !== "supervisor"
        && !isSubagentRelayHandoff(entry)
        && normalizeGroup(entry.from.group) !== normalizeGroup(getOwnerGroup())) continue;
      const result = admission.admit(entry.from, entry.message);
      if (result.kind === "pending") { joined.push(result.completion); continue; }
      if (result.kind === "duplicate") continue;
      const context = tracker.recordIncomingMessage(entry.from, entry.message);
      if (!queuedTurnContext && event.options?.triggerTurn === true) {
        tracker.queueTurnContext(context);
        queuedTurnContext = true;
      }
      reservations.push({ message, reservation: result.reservation, context });
      accepted.push(message);
    }
    event.handled = true;
    const ownedCompletion = event.batch && typeof pi.sendMessages === "function"
      ? deliverAtomicBatch(pi, accepted, event, reservations, admission, tracker)
      : deliverSequentially(pi, accepted, event, reservations, admission, tracker);
    event.completion = Promise.all([ownedCompletion, ...joined]).then(() => {});
    return event.completion;
  });
}

function isCompletedStageAskRoute(event: Partial<LateStageMessageEvent>): boolean {
  return typeof event.workflowRunId === "string"
    && typeof event.workflowStageId === "string"
    && event.messages?.length !== 0
    && event.messages?.every((message) => {
      if (message.customType !== "intercom_message") return false;
      const entry = message.details as InboundMessageEntry | undefined;
      return entry?.message.expectsReply === true;
    }) === true;
}

function deliverAtomicBatch(
  pi: ExtensionAPI,
  accepted: LateStageMessage[],
  event: Partial<LateStageMessageEvent>,
  reservations: LateStageReservation[],
  admission: InboundMessageAdmission,
  tracker: ReplyTracker,
): Promise<void> {
  if (accepted.length === 0) return Promise.resolve();
  for (const { reservation } of reservations) admission.beginDelivery(reservation);
  let delivery: Promise<void>;
  try {
    delivery = Promise.resolve(pi.sendMessages(accepted, event.options as Parameters<ExtensionAPI["sendMessages"]>[1]));
  } catch (error) {
    delivery = Promise.reject(error);
  }
  for (const { reservation } of reservations) admission.endDelivery(reservation);
  return delivery.then(
    () => { for (const { reservation } of reservations) admission.commit(reservation); },
    (error: Error) => { releaseReservations(reservations, admission, tracker, error); throw error; },
  );
}

async function deliverSequentially(
  pi: ExtensionAPI,
  accepted: LateStageMessage[],
  event: Partial<LateStageMessageEvent>,
  reservations: LateStageReservation[],
  admission: InboundMessageAdmission,
  tracker: ReplyTracker,
): Promise<void> {
  const pending = new Map(reservations.map((owned) => [owned.message, owned]));
  for (let index = 0; index < accepted.length; index += 1) {
    const message = accepted[index]!;
    const owned = pending.get(message);
    if (owned) admission.beginDelivery(owned.reservation);
    try {
      await pi.sendMessage(message, index === 0 ? event.options : { deliverAs: "followUp" });
    } catch (error) {
      if (owned) admission.endDelivery(owned.reservation);
      const failure = error instanceof Error ? error : new Error(String(error));
      releaseReservations([...pending.values()], admission, tracker, failure);
      throw failure;
    }
    if (owned) {
      admission.endDelivery(owned.reservation);
      admission.commit(owned.reservation);
      pending.delete(message);
    }
  }
}

function releaseReservations(
  reservations: LateStageReservation[],
  admission: InboundMessageAdmission,
  tracker: ReplyTracker,
  error: Error,
): void {
  for (const { reservation, context } of reservations) {
    admission.release(reservation, error);
    tracker.forgetIncomingMessage(context);
  }
}
