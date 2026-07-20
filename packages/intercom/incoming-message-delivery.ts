import type { ExtensionAPI } from "@bastani/atomic";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { IntercomContext } from "./reply-tracker.js";

export type IncomingMessageDelivery = "trigger" | "followUp" | "prelude";
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
    if (delivery === "trigger" && trackReplyContext) {
      input.queueTurnContext(turnContext ?? { from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const baseOptions = {
      stageAdmissionKey: `intercom:${entry.message.id}`,
      ...(stageAdmissionBarrier ? { stageAdmissionBarrier } : {}),
    } as const;
    const options = delivery === "trigger"
      ? { ...baseOptions, triggerTurn: true } as const
      : delivery === "followUp" ? { ...baseOptions, deliverAs: "followUp" } as const : baseOptions;
    return Promise.resolve(input.pi.sendMessage(buildIncomingCustomMessage(entry), options));
  };
}

export function buildIncomingCustomMessage(entry: InboundMessageEntry) {
  const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
  const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
  return {
    customType: "intercom_message" as const,
    content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
    display: true as const,
    details: entry,
  };
}
