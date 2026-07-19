import type { SessionInfo } from "../types.js";
import { normalizeGroup } from "../group.js";
import type { SupervisorChannelCache } from "./supervisor-channel.js";

/** Two sessions share a group when their normalized group ids are equal. */
export function sameGroup(a: SessionInfo, b: SessionInfo): boolean {
  return normalizeGroup(a.group) === normalizeGroup(b.group);
}

export interface VerticalBypassInput {
  /** Wire `channel` marker; only `contact_supervisor` sets `"supervisor"`. */
  channel?: string;
  /** Reply correlation id, when this send is a reply. */
  replyTo?: string;
  sender: SessionInfo;
  target: SessionInfo;
  supervisorCache: SupervisorChannelCache;
}

/**
 * Decide whether a send is allowed to cross peer-group isolation. Two coherent
 * cases: (1) the sender explicitly marks the send as a supervisor-channel
 * message (`channel === "supervisor"`), or (2) the send replies to a previously
 * recorded supervisor-channel crossing in the exact opposite direction. Any
 * other cross-group send is rejected.
 */
export function isVerticalBypass(input: VerticalBypassInput): boolean {
  if (input.channel === "supervisor") return true;
  if (input.replyTo) {
    return input.supervisorCache.matchReply(input.replyTo, input.sender.id, input.target.id);
  }
  return false;
}
