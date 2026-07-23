import type { SessionInfo } from "../types.js";
import { normalizeGroup } from "../group.js";
import type { SupervisorChannelCache } from "./supervisor-channel.js";

/** Two sessions share a group when their normalized group ids are equal. */
export function sameGroup(a: SessionInfo, b: SessionInfo): boolean {
  return normalizeGroup(a.group) === normalizeGroup(b.group);
}

export interface VerticalBypassInput {
  /** Reply correlation id, when this send is a reply. */
  replyTo?: string;
  sender: SessionInfo;
  target: SessionInfo;
  supervisorCache: SupervisorChannelCache;
}

/**
 * Only an exact reverse reply to a broker-recorded supervisor crossing may
 * bypass peer-group isolation. Initial supervisor sends are authorized and
 * routed separately; no client-authored marker reaches this decision point.
 */
export function isVerticalBypass(input: VerticalBypassInput): boolean {
  if (input.replyTo) {
    return input.supervisorCache.matchReply(input.replyTo, input.sender.id, input.target.id);
  }
  return false;
}
