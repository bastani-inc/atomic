import { DeliveredMessageCache } from "./broker/delivered-message-cache.js";
import type { Message, SessionInfo } from "./types.js";

export interface InboundMessageReservation {
  readonly messageId: string;
  readonly signature: string;
  readonly token: symbol;
}

export type InboundMessageAdmissionResult =
  | { readonly kind: "reserved"; readonly reservation: InboundMessageReservation }
  | { readonly kind: "pending"; readonly completion: Promise<void> }
  | { readonly kind: "duplicate" };

interface PendingInboundMessage {
  readonly reservation: InboundMessageReservation;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  delivering: boolean;
}

/** Deduplicates broker deliveries before reply-tracker or turn-context side effects. */
export class InboundMessageAdmission {
  private readonly delivered = new DeliveredMessageCache();
  private readonly pending = new Map<string, PendingInboundMessage>();

  admit(from: SessionInfo, message: Message): InboundMessageAdmissionResult {
    const signature = JSON.stringify({ from: from.id, message });
    if (this.delivered.lookup(message.id, signature) !== "miss") return { kind: "duplicate" };
    const pending = this.pending.get(message.id);
    if (pending) {
      if (pending.reservation.signature !== signature || pending.delivering) return { kind: "duplicate" };
      return { kind: "pending", completion: pending.completion };
    }
    const reservation = { messageId: message.id, signature, token: Symbol(message.id) };
    const deferred = Promise.withResolvers<void>();
    void deferred.promise.catch(() => {});
    this.pending.set(message.id, { reservation, completion: deferred.promise, resolve: deferred.resolve, reject: deferred.reject, delivering: false });
    return { kind: "reserved", reservation };
  }

  reserve(from: SessionInfo, message: Message): InboundMessageReservation | undefined {
    const result = this.admit(from, message);
    return result.kind === "reserved" ? result.reservation : undefined;
  }

  beginDelivery(reservation: InboundMessageReservation): void {
    const pending = this.pending.get(reservation.messageId);
    if (pending?.reservation === reservation) pending.delivering = true;
  }

  endDelivery(reservation: InboundMessageReservation): void {
    const pending = this.pending.get(reservation.messageId);
    if (pending?.reservation === reservation) pending.delivering = false;
  }

  commit(reservation: InboundMessageReservation): void {
    const pending = this.pending.get(reservation.messageId);
    if (pending?.reservation !== reservation) return;
    this.pending.delete(reservation.messageId);
    this.delivered.record(reservation.messageId, reservation.signature);
    pending.resolve();
  }

  release(reservation: InboundMessageReservation, error = new Error("Inbound message admission released")): void {
    const pending = this.pending.get(reservation.messageId);
    if (pending?.reservation !== reservation) return;
    this.pending.delete(reservation.messageId);
    pending.reject(error);
  }

  accept(from: SessionInfo, message: Message): boolean {
    const reservation = this.reserve(from, message);
    if (!reservation) return false;
    this.commit(reservation);
    return true;
  }
}
