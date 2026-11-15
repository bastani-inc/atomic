import type net from "node:net";
import { TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import type { BrokerMessage } from "../types.js";
import { deliverAskFailure } from "./ask-failures.js";
import type { PendingQuestionIndex } from "./pending-question-index.js";
import type { BrokerConnectedSession } from "./send-handler.js";

/** Settle only questions already admitted to this exact execution's registration. */
export function failTerminalQuestions(
  target: BrokerConnectedSession,
  sessions: Map<string, BrokerConnectedSession>,
  pending: PendingQuestionIndex,
  write: (socket: net.Socket, message: BrokerMessage) => void,
): void {
  // #4751: an away asker's ask to it fails too, with a message held until the asker is back.
  pending.failDormantForTarget(target.info, TERMINAL_CHILD_ASK_REFUSAL, "terminal", target.registrationReturnAddress);
  for (const question of pending.takeForTarget(target.info.id)) {
    const asker = sessions.get(question.senderSessionId);
    if (!asker) continue;
    // #5004: held until the asker saved it, like a reply.
    deliverAskFailure({
      asker,
      question,
      from: target.info,
      id: `terminal:${question.messageId}`,
      reason: TERMINAL_CHILD_ASK_REFUSAL,
      pending,
      write,
    });
  }
}
