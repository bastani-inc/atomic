import type net from "node:net";
import { TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import type { BrokerMessage } from "../types.js";
import type { PendingQuestionIndex } from "./pending-question-index.js";
import type { BrokerConnectedSession } from "./send-handler.js";

/** Settle only questions already admitted to this exact execution's registration. */
export function failTerminalQuestions(
  target: BrokerConnectedSession,
  sessions: Map<string, BrokerConnectedSession>,
  pending: PendingQuestionIndex,
  write: (socket: net.Socket, message: BrokerMessage) => void,
): void {
  for (const question of pending.takeForTarget(target.info.id)) {
    const sender = sessions.get(question.senderSessionId);
    if (!sender) continue;
    write(sender.socket, {
      type: "message",
      from: target.info,
      message: {
        id: `terminal:${question.messageId}`,
        timestamp: Date.now(),
        replyTo: question.messageId,
        replyError: TERMINAL_CHILD_ASK_REFUSAL,
        content: { text: TERMINAL_CHILD_ASK_REFUSAL },
      },
    });
  }
}
