const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export type DeliveredMessageMatch = "miss" | "match" | "conflict";

interface DeliveredMessage {
  deliveredAt: number;
  signature: string;
}

/** Bounded successful-delivery cache used to make broker and local retries idempotent. */
export class DeliveredMessageCache {
  private readonly delivered = new Map<string, DeliveredMessage>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  lookup(messageId: string, signature: string, now = Date.now()): DeliveredMessageMatch {
    this.prune(now);
    const delivered = this.delivered.get(messageId);
    if (!delivered || now - delivered.deliveredAt > this.ttlMs) return "miss";
    return delivered.signature === signature ? "match" : "conflict";
  }

  record(messageId: string, signature: string, now = Date.now()): void {
    this.prune(now);
    this.delivered.delete(messageId);
    this.delivered.set(messageId, { deliveredAt: now, signature });
    while (this.delivered.size > this.maxEntries) {
      const oldest = this.delivered.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [messageId, delivered] of this.delivered) {
      if (now - delivered.deliveredAt <= this.ttlMs) break;
      this.delivered.delete(messageId);
    }
  }
}
