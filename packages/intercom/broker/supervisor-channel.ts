const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

interface SupervisorCrossing {
  recordedAt: number;
  fromId: string;
  toId: string;
}

/**
 * Bounded record of `contact_supervisor` vertical-channel crossings. It lets the
 * broker permit a supervisor's reply back across peer-group isolation without
 * opening a general "any replyTo bypasses isolation" hole: a reply is only
 * allowed when it answers a recorded crossing in the exact opposite direction.
 * Mirrors {@link DeliveredMessageCache} (TTL + max entries, insertion-ordered).
 */
export class SupervisorChannelCache {
  private readonly crossings = new Map<string, SupervisorCrossing>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Record a supervisor-channel crossing keyed by the outbound message id. */
  record(messageId: string, fromId: string, toId: string, now = Date.now()): void {
    this.prune(now);
    this.crossings.delete(messageId);
    this.crossings.set(messageId, { recordedAt: now, fromId, toId });
    while (this.crossings.size > this.maxEntries) {
      const oldest = this.crossings.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.crossings.delete(oldest);
    }
  }

  /**
   * Return true when a reply (`send` with `replyTo`) answers a recorded crossing:
   * the reply's target is the crossing's original sender AND the reply's sender is
   * the crossing's original target. Prevents fabricated-replyTo cross-group sends.
   */
  matchReply(replyTo: string, replySenderId: string, replyTargetId: string, now = Date.now()): boolean {
    this.prune(now);
    const crossing = this.crossings.get(replyTo);
    if (!crossing) return false;
    if (now - crossing.recordedAt > this.ttlMs) {
      this.crossings.delete(replyTo);
      return false;
    }
    return crossing.fromId === replyTargetId && crossing.toId === replySenderId;
  }

  private prune(now: number): void {
    for (const [messageId, crossing] of this.crossings) {
      if (now - crossing.recordedAt <= this.ttlMs) break;
      this.crossings.delete(messageId);
    }
  }
}
