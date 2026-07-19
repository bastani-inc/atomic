import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
function capabilityMac(ownerToken: string, childName: string, nonce: string): Buffer {
  return createHmac("sha256", ownerToken).update(`${nonce}\0${childName}`).digest();
}

function issueCapability(ownerToken: string, childName: string): string {
  const nonce = randomUUID();
  return `${nonce}.${capabilityMac(ownerToken, childName, nonce).toString("base64url")}`;
}

function ownsCapability(capability: string, ownerToken: string, childName: string): boolean {
  const separator = capability.indexOf(".");
  if (separator <= 0 || separator === capability.length - 1) return false;
  const nonce = capability.slice(0, separator);
  let supplied: Buffer;
  try { supplied = Buffer.from(capability.slice(separator + 1), "base64url"); } catch { return false; }
  const expected = capabilityMac(ownerToken, childName, nonce);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}


interface SupervisorCrossing {
  recordedAt: number;
  fromId: string;
  toId: string;
}
interface SupervisorAuthorizationRecord {
  supervisorId: string;
  childName: string;
  ownerToken: string;
  boundChildName?: string;
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
  private readonly authorizations = new Map<string, SupervisorAuthorizationRecord>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Issue or restore a capability from an already registered supervisor socket. */
  authorize(supervisorId: string, ownerToken: string, childName: string, requestedCapability?: string): string {
    const capability = requestedCapability ?? issueCapability(ownerToken, childName);
    if (!ownsCapability(capability, ownerToken, childName)) {
      throw new Error("Invalid supervisor capability owner");
    }
    const existing = this.authorizations.get(capability);
    if (existing && (existing.ownerToken !== ownerToken || existing.childName !== childName)) {
      throw new Error("Supervisor capability is already owned by another relationship");
    }
    this.authorizations.delete(capability);
    this.authorizations.set(capability, {
      supervisorId,
      childName,
      ownerToken,
      ...(existing?.boundChildName ? { boundChildName: existing.boundChildName } : {}),
    });
    while (this.authorizations.size > this.maxEntries) {
      const oldest = this.authorizations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.authorizations.delete(oldest);
    }
    return capability;
  }

  /** Resolve a capability for its exact child, binding a dynamic slot on first use. */
  claim(capability: string, childName: string): string | undefined {
    const authorization = this.authorizations.get(capability);
    if (!authorization) return undefined;
    if (authorization.childName === "*") {
      if (authorization.boundChildName && authorization.boundChildName !== childName) return undefined;
      authorization.boundChildName = childName;
    } else if (authorization.childName !== childName) {
      return undefined;
    }
    return authorization.supervisorId;
  }

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
