import type { ExtensionAPI } from "@bastani/atomic";
import type { Message, SessionInfo } from "./types.js";

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";

interface DetachHandshake {
  phase: "probe" | "commit";
  requestId: string;
  messageId: string;
  childIntercomTarget: string;
  senderId: string;
  runtimeGeneration: number;
}

type ForegroundDeliveryDisposition = "delivered" | "unclaimed" | "abandoned";

/** Claims a busy inbound message only when its exact foreground owner acknowledges it. */
export class ForegroundDetachHandoff {
  private generation = -1;
  private readonly delivered = new Set<string>();
  private readonly pending = new Map<string, Promise<ForegroundDeliveryDisposition>>();

  constructor(
    private readonly pi: Pick<ExtensionAPI, "events">,
    private readonly ackTimeoutMs = 50,
  ) {}

  deliver(input: {
    from: SessionInfo;
    message: Message;
    generation: number;
    surface: () => void;
    isCurrent: () => boolean;
  }): Promise<ForegroundDeliveryDisposition> {
    if (!input.isCurrent()) return Promise.resolve("abandoned");
    if (this.generation !== input.generation) this.resetForGeneration(input.generation);
    const deliveryKey = `${input.from.id}\0${input.message.id}`;
    const pendingKey = `${input.generation}\0${deliveryKey}`;
    if (this.delivered.has(deliveryKey)) return Promise.resolve("delivered");
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;

    const attempt = this.claimAndDeliver(input, deliveryKey).finally(() => {
      if (this.pending.get(pendingKey) === attempt) this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, attempt);
    return attempt;
  }

  reset(): void { this.resetForGeneration(-1); }

  private async claimAndDeliver(
    input: { from: SessionInfo; message: Message; generation: number; surface: () => void; isCurrent: () => boolean },
    deliveryKey: string,
  ): Promise<ForegroundDeliveryDisposition> {
    const route: DetachHandshake = {
      phase: "probe",
      requestId: input.message.id,
      messageId: input.message.id,
      childIntercomTarget: input.from.name || input.from.id,
      senderId: input.from.id,
      runtimeGeneration: input.generation,
    };
    const probed = await this.awaitAcknowledgement(route);
    if (!probed) return "unclaimed";
    if (!input.isCurrent() || this.generation !== input.generation) return "abandoned";

    const committed = await this.awaitAcknowledgement({ ...route, phase: "commit" });
    if (!committed || !input.isCurrent() || this.generation !== input.generation) return "abandoned";
    input.surface();
    this.delivered.add(deliveryKey);
    return "delivered";
  }

  private awaitAcknowledgement(route: DetachHandshake): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(accepted);
      };
      unsubscribe = this.pi.events?.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
        if (!payload || typeof payload !== "object") return;
        const response = payload as Partial<DetachHandshake> & { accepted?: unknown };
        if (response.accepted === true
          && response.phase === route.phase
          && response.requestId === route.requestId
          && response.messageId === route.messageId
          && response.childIntercomTarget === route.childIntercomTarget
          && response.senderId === route.senderId
          && response.runtimeGeneration === route.runtimeGeneration) finish(true);
      });
      timeout = setTimeout(() => finish(false), this.ackTimeoutMs);
      this.pi.events?.emit(INTERCOM_DETACH_REQUEST_EVENT, route);
    });
  }

  private resetForGeneration(generation: number): void {
    this.delivered.clear();
    this.generation = generation;
  }
}

export async function handleForegroundInboundDelivery(input: {
  handoff: ForegroundDetachHandoff;
  from: SessionInfo;
  message: Message;
  generation: number;
  surface: () => void;
  isCurrent: () => boolean;
  onUnclaimed: () => void;
}): Promise<void> {
  const disposition = await input.handoff.deliver(input);
  if (disposition === "unclaimed" && input.isCurrent()) input.onUnclaimed();
}
