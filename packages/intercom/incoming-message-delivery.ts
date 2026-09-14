import type { ExtensionAPI } from "@bastani/atomic";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { IntercomContext } from "./reply-tracker.js";
import type { Message } from "./types.js";

export type IncomingMessageDelivery = "trigger" | "interrupt" | "followUp" | "prelude";
export type IncomingMessageSender = (
  entry: InboundMessageEntry,
  delivery: IncomingMessageDelivery,
  generation?: number,
  trackReplyContext?: boolean,
  turnContext?: IntercomContext,
  stageAdmissionBarrier?: () => Promise<void>,
) => Promise<void>;

/** Creates generation-safe Intercom delivery into the Atomic custom-message API. */
export function createIncomingMessageSender(input: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  currentGeneration: () => number;
  canDeliver: (generation: number) => boolean;
  queueTurnContext: (context: IntercomContext) => void;
}): IncomingMessageSender {
  return (entry, delivery, generation = input.currentGeneration(), trackReplyContext = true, turnContext, stageAdmissionBarrier) => {
    if (!input.canDeliver(generation)) {
      return Promise.reject(new Error("Intercom session retired before inbound delivery"));
    }
    if ((delivery === "trigger" || delivery === "interrupt") && trackReplyContext) {
      input.queueTurnContext(turnContext ?? { from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const baseOptions = {
      stageAdmissionKey: `intercom:${entry.message.id}`,
      persistWhenStreaming: true,
      ...(stageAdmissionBarrier ? { stageAdmissionBarrier } : {}),
    } as const;
    const options = delivery === "interrupt"
      ? { ...baseOptions, triggerTurn: true, deliverAs: "interrupt" } as const
      : delivery === "trigger"
      ? { ...baseOptions, triggerTurn: true } as const
      : delivery === "followUp" ? { ...baseOptions, deliverAs: "followUp" } as const : baseOptions;
    return Promise.resolve(input.pi.sendMessage(buildIncomingCustomMessage(entry), options));
  };
}

export function framePendingStageTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

/** Mark a deferred workflow-stage message as pre-start context without merging it into the stage task prompt. */
export function framePreStartPendingStageMessage(entry: InboundMessageEntry): InboundMessageEntry {
	return {
		...entry,
		bodyText: `**Messages received before you started**\n\nSent: ${framePendingStageTimestamp(entry.message.timestamp)}\n\n${entry.bodyText}`,
	};
}

export function isDeliveryFeedback(message: Message): boolean {
  return Boolean(message.replyTo) && message.replyError !== undefined;
}

/** Delivery feedback describes a past send, not the recipient's current activity. */
export function frameDeliveryFeedback(entry: InboundMessageEntry): InboundMessageEntry {
  return {
    ...entry,
    replyCommand: undefined,
    bodyText: `**Intercom delivery failed**\n\nSent: ${framePendingStageTimestamp(entry.message.timestamp)}\n\n${entry.bodyText}`,
  };
}

/** Supervisor notifications are send-time snapshots, even when delivery precedes completion. */
export function frameHistoricalSupervisorUpdate(entry: InboundMessageEntry): InboundMessageEntry {
	if (entry.channel !== "supervisor" || entry.message.expectsReply === true || entry.message.replyTo) return entry;
	return {
		...entry,
		bodyText: `**Historical supervisor update — snapshot at send time**\n\nSent: ${framePendingStageTimestamp(entry.message.timestamp)}\n\nThis is not current task status; a later correction or final result supersedes this update.\n\n${entry.bodyText}`,
	};
}

export function buildIncomingCustomMessage(entry: InboundMessageEntry) {
  const senderDisplay = entry.from.name || entry.from.id;
  const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
  return {
    customType: "intercom_message" as const,
    content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
    display: true as const,
    details: entry,
  };
}
