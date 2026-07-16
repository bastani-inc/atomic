import { DeliveredMessageCache } from "./broker/delivered-message-cache.js";
import type { Message, SessionInfo } from "./types.js";

/** Deduplicates broker deliveries before reply-tracker or turn-context side effects. */
export class InboundMessageAdmission {
  private readonly delivered = new DeliveredMessageCache();

  accept(from: SessionInfo, message: Message): boolean {
    const signature = JSON.stringify({ from: from.id, message });
    if (this.delivered.lookup(message.id, signature) !== "miss") return false;
    this.delivered.record(message.id, signature);
    return true;
  }
}
